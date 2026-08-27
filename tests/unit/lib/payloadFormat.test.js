'use strict'

const zlib = require('zlib')
const { Readable } = require('streamx')
const test = require('brittle')

const {
  inflateHead,
  detectPayloadFormat,
  peekFirstChunk,
  prependChunk
} = require('../../../workers/lib/server/lib/payloadFormat')

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// A 512-byte POSIX tar header carries "ustar" at offset 257, followed by payload blocks.
function tarBytes (name = '10.0.0.1.logs/') {
  const tar = Buffer.alloc(1024)
  tar.write(name, 0, 'latin1')
  tar.write('ustar', 257, 'latin1')
  return tar
}

function makeStream (chunks) {
  let index = 0
  return new Readable({
    read (cb) {
      if (index < chunks.length) this.push(Buffer.from(chunks[index++]))
      else this.push(null)
      cb(null)
    }
  })
}

async function drain (stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

// ─────────────────────────────────────────────────────────────────────────────
// detectPayloadFormat
// ─────────────────────────────────────────────────────────────────────────────

test('detectPayloadFormat - reports a gzipped tar, which is what a Whatsminer streams', (t) => {
  const format = detectPayloadFormat(zlib.gzipSync(tarBytes()))

  t.is(format.extension, 'tar.gz', 'should name the file .tar.gz')
  t.is(format.contentType, 'application/gzip', 'should declare gzip')
})

test('detectPayloadFormat - detects a tar from a truncated stream prefix', (t) => {
  // The handler only ever sees the first chunk, so the deflate block is cut short.
  const gzipped = zlib.gzipSync(Buffer.concat([tarBytes(), Buffer.alloc(64 * 1024)]))
  const format = detectPayloadFormat(gzipped.subarray(0, 512))

  t.is(format.extension, 'tar.gz', 'should still see the tar header')
})

test('detectPayloadFormat - does not claim tar for a gzip payload that holds none', (t) => {
  const format = detectPayloadFormat(zlib.gzipSync(Buffer.from('[board0]\npass = 1\n')))

  t.is(format.extension, 'gz', 'should name the file .gz')
  t.is(format.contentType, 'application/gzip', 'should declare gzip')
})

test('detectPayloadFormat - reports zip payloads', (t) => {
  const format = detectPayloadFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))

  t.is(format.extension, 'zip', 'should name the file .zip')
  t.is(format.contentType, 'application/zip', 'should declare zip')
})

test('detectPayloadFormat - falls back to plain text', (t) => {
  const text = detectPayloadFormat(Buffer.from('[board0]\npass = 1\n'))

  t.is(text.extension, 'log', 'should name a text payload .log')
  t.is(text.contentType, 'text/plain; charset=utf-8', 'should declare text')

  t.is(detectPayloadFormat(null).extension, 'log', 'should default for an empty stream')
  t.is(detectPayloadFormat(Buffer.alloc(0)).extension, 'log', 'should default for zero bytes')
  t.is(detectPayloadFormat(Buffer.from([0x1f])).extension, 'log', 'should default for a single byte')
})

// ─────────────────────────────────────────────────────────────────────────────
// peekFirstChunk
// ─────────────────────────────────────────────────────────────────────────────

test('peekFirstChunk - returns the first chunk', async (t) => {
  const head = await peekFirstChunk(makeStream(['HEAD', 'MIDDLE', 'TAIL']))

  t.is(head.toString(), 'HEAD', 'should hand back the first chunk')
})

test('peekFirstChunk - resolves null for an empty stream', async (t) => {
  t.is(await peekFirstChunk(makeStream([])), null, 'should resolve null')
})

test('peekFirstChunk - rejects when the stream errors', async (t) => {
  const stream = new Readable({
    read (cb) {
      cb(new Error('ERR_LOG_PEER_TIMEOUT'))
    }
  })

  await t.exception(peekFirstChunk(stream), /ERR_LOG_PEER_TIMEOUT/, 'should propagate the error')
})

// ─────────────────────────────────────────────────────────────────────────────
// prependChunk
// ─────────────────────────────────────────────────────────────────────────────

test('prependChunk - re-emits the peeked bytes ahead of the rest', async (t) => {
  for (const chunks of [['ONLY'], ['HEAD', 'TAIL'], ['A', 'B', 'C']]) {
    const stream = makeStream(chunks)
    const head = await peekFirstChunk(stream)

    t.is(
      (await drain(prependChunk(stream, head))).toString(),
      chunks.join(''),
      `should lose no bytes for a ${chunks.length}-chunk payload`
    )
  }
})

test('prependChunk - streams a payload larger than the high-water mark', async (t) => {
  // stream.unshift() cannot be used for this: it silently drops the head once the peek has
  // consumed the source's last chunk, which truncated single-chunk logs.
  const chunks = Array.from({ length: 64 }, (_, i) => Buffer.alloc(64 * 1024, i))
  const stream = makeStream(chunks)
  const head = await peekFirstChunk(stream)

  const out = await drain(prependChunk(stream, head))

  t.is(out.length, 64 * 64 * 1024, 'should deliver every byte')
  t.alike(out, Buffer.concat(chunks), 'should deliver them in order')
})

test('prependChunk - handles an empty payload', async (t) => {
  const stream = makeStream([])
  const head = await peekFirstChunk(stream)

  t.is((await drain(prependChunk(stream, head))).length, 0, 'should end without data')
})

test('prependChunk - surfaces a source failure that happens after the peek', async (t) => {
  const stream = makeStream(['HEAD', 'TAIL'])
  const head = await peekFirstChunk(stream)

  const body = prependChunk(stream, head)
  stream.destroy(new Error('ERR_LOG_INCOMPLETE'))

  await t.exception(drain(body), /ERR_LOG_INCOMPLETE/, 'should propagate to the consumer')
})

test('peekFirstChunk - rejects when the source fails before the first chunk arrives', async (t) => {
  // The connection to the miner can drop mid-transfer; the file leg turns this into a 500
  // rather than sending a truncated body under a confident content-type.
  let reads = 0
  const stream = new Readable({
    read (cb) {
      if (reads++ === 0) {
        this.push(Buffer.from('HEAD'))
        return cb(null)
      }
      cb(new Error('ERR_LOG_INCOMPLETE'))
    }
  })

  await t.exception(peekFirstChunk(stream), /ERR_LOG_INCOMPLETE/, 'should reject')
})

// ─────────────────────────────────────────────────────────────────────────────
// inflateHead — bounded work on device-supplied bytes
// ─────────────────────────────────────────────────────────────────────────────

test('inflateHead - inflates only a bounded slice of a highly compressible chunk', (t) => {
  // `head` comes from the miner and deflate expands up to ~1000x: inflating a whole 64 KB chunk
  // of this shape would allocate ~67 MB synchronously per request.
  const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024))
  const inflated = inflateHead(bomb)

  t.ok(inflated.length >= 512, 'should still yield enough output to read a tar header')
  t.ok(
    inflated.length < 8 * 1024 * 1024,
    `should not inflate the whole payload (got ${inflated.length} bytes)`
  )
  t.is(detectPayloadFormat(bomb).extension, 'gz', 'should still classify the payload')
})

test('inflateHead - still sees the tar header of a real archive', (t) => {
  t.is(detectPayloadFormat(zlib.gzipSync(tarBytes())).extension, 'tar.gz', 'should detect tar')
})

// ─────────────────────────────────────────────────────────────────────────────
// prependChunk — lifecycle
// ─────────────────────────────────────────────────────────────────────────────

test('prependChunk - destroys the source when the consumer goes away', async (t) => {
  // Fastify destroys the response stream when a client aborts mid-download. Nothing else would
  // close the P2P transfer from the miner, and the pump would park on a drain that never fires.
  const source = makeStream(Array.from({ length: 64 }, () => Buffer.alloc(64 * 1024, 7)))
  const head = await peekFirstChunk(source)
  const body = prependChunk(source, head)

  await new Promise((resolve) => body.once('readable', resolve))
  body.destroy()

  await t.execution(
    Promise.race([
      new Promise((resolve) => source.once('close', resolve)),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('source never closed')), 2000))
    ]),
    'should destroy the source rather than leave the transfer open'
  )
  t.ok(source.destroyed, 'source should be destroyed')
})
