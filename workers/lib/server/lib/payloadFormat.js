'use strict'

const zlib = require('zlib')
const { PassThrough } = require('stream')

// The miner decides what a log download actually contains: some models stream a single
// plain-text log, Whatsminers stream a gzipped tar of their log directory. The action result
// carries no format field, so the only reliable source is the payload's leading bytes.

const GZIP_MAGIC = [0x1f, 0x8b]
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

// `head` is device-supplied and deflate expands up to ~1000x, so only a bounded slice of it is
// ever inflated — detection needs 512 output bytes, not the whole chunk.
const GZIP_INFLATE_INPUT_LIMIT = 4096

// A POSIX tar header is 512 bytes and carries "ustar" at offset 257.
const TAR_HEADER_LENGTH = 512
const TAR_MAGIC = 'ustar'
const TAR_MAGIC_OFFSET = 257

const TEXT_FORMAT = { extension: 'log', contentType: 'text/plain; charset=utf-8' }
const GZIP_FORMAT = { extension: 'gz', contentType: 'application/gzip' }
const TAR_GZ_FORMAT = { extension: 'tar.gz', contentType: 'application/gzip' }
const ZIP_FORMAT = { extension: 'zip', contentType: 'application/zip' }

function hasMagic (head, magic) {
  return head.length >= magic.length && magic.every((byte, index) => head[index] === byte)
}

// Inflates whatever zlib can manage of the first GZIP_INFLATE_INPUT_LIMIT bytes — the input is a
// stream prefix, so the deflate block is expected to be truncated. Returns null when it cannot be
// inflated at all. `maxOutputLength` is deliberately not used: it throws, which would demote a
// real .tar.gz to .gz.
function inflateHead (head) {
  try {
    return zlib.gunzipSync(head.subarray(0, GZIP_INFLATE_INPUT_LIMIT), {
      finishFlush: zlib.constants.Z_SYNC_FLUSH
    })
  } catch {
    return null
  }
}

function isGzippedTar (head) {
  const inflated = inflateHead(head)
  if (!inflated || inflated.length < TAR_HEADER_LENGTH) return false

  return inflated.toString('latin1', TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + TAR_MAGIC.length) === TAR_MAGIC
}

/**
 * Format implied by a payload's leading bytes. Falls back to plain text, and never claims 'tar'
 * without having seen a tar header, so the declared name always matches the bytes.
 *
 * @param {Buffer|null} head  First chunk of the payload (null for an empty stream)
 * @returns {{ extension: string, contentType: string }}
 */
function detectPayloadFormat (head) {
  if (!head || !head.length) return TEXT_FORMAT

  if (hasMagic(head, GZIP_MAGIC)) {
    return isGzippedTar(head) ? TAR_GZ_FORMAT : GZIP_FORMAT
  }

  if (hasMagic(head, ZIP_MAGIC)) return ZIP_FORMAT

  return TEXT_FORMAT
}

/**
 * Reads the first chunk of a stream. Pair it with `prependChunk` to hand the bytes back —
 * `stream.unshift` silently drops them when the peek consumed the stream's last chunk, which
 * would truncate a small log. Resolves null when the stream ends without producing data.
 *
 * @param {import('streamx').Readable} stream
 * @returns {Promise<Buffer|null>}
 */
function peekFirstChunk (stream) {
  return new Promise((resolve, reject) => {
    let settled = false

    // Stays attached for the life of the stream: an 'error' with no listener is thrown by
    // EventEmitter, and the source can fail in the gap between this peek and the pipe.
    const onError = (err) => {
      if (settled) return
      settled = true
      detach()
      reject(err)
    }

    const detach = () => {
      stream.off('readable', onReadable)
      stream.off('end', onEnd)
    }
    const settle = (chunk) => {
      if (settled) return
      settled = true
      detach()
      resolve(chunk === undefined ? null : chunk)
    }
    const onReadable = () => settle(stream.read())
    const onEnd = () => settle(null)

    stream.on('error', onError)

    const immediate = stream.read()
    if (immediate !== null && immediate !== undefined) return settle(immediate)

    stream.on('readable', onReadable)
    stream.on('end', onEnd)
  })
}

/**
 * Re-emits a peeked chunk ahead of the rest of the source, so the consumer sees the payload
 * byte-for-byte. Honours the consumer's backpressure — nothing beyond one chunk is buffered.
 *
 * The two streams share a lifecycle: if the consumer goes away (fastify destroys the response
 * stream when a client aborts mid-download) the source is destroyed too, so the P2P transfer from
 * the miner is not left open with the pump parked on a drain that will never fire. `source.pipe()`
 * would tie them for free but cannot be used here — the peek may already have consumed the
 * source's last chunk, and piping an ended stream never ends the destination.
 *
 * @param {import('stream').Readable} source  Stream already advanced past `head`
 * @param {Buffer|null} head
 * @returns {import('stream').Readable}
 */
function prependChunk (source, head) {
  const out = new PassThrough()

  out.on('close', () => source.destroy())

  // Resolves false once the consumer is gone, which stops the pump instead of hanging it.
  const write = async (chunk) => {
    if (out.destroyed) return false
    if (out.write(chunk) !== false) return true

    return new Promise((resolve) => {
      const settle = (delivered) => {
        out.off('drain', onDrain)
        out.off('close', onClose)
        resolve(delivered)
      }
      const onDrain = () => settle(true)
      const onClose = () => settle(false)

      out.on('drain', onDrain)
      out.on('close', onClose)
    })
  }

  const pump = async () => {
    if (head && !(await write(head))) return

    for await (const chunk of source) {
      if (!(await write(chunk))) return
    }

    out.end()
  }

  pump().catch((err) => out.destroy(err))

  return out
}

module.exports = {
  inflateHead,
  detectPayloadFormat,
  peekFirstChunk,
  prependChunk
}
