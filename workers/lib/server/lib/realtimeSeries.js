'use strict'

class RealtimeSeries {
  constructor ({ retentionMs, refreshMs, chunkMs, refetchMs = 0, fetch }) {
    this.retentionMs = retentionMs
    this.refreshMs = refreshMs
    this.chunkMs = chunkMs
    this.refetchMs = refetchMs
    this.fetch = fetch
    this.entries = []
    this.loadedFrom = null
    this.refreshedAt = 0
    this.inflight = null
    this.version = 0
    this.serializedCache = null
  }

  async ensureFresh (now = Date.now()) {
    if (this.loadedFrom !== null && now - this.refreshedAt < this.refreshMs) return

    try {
      await this.refresh(now)
    } catch (err) {
      if (!this.entries.length) throw err
    }
  }

  async read (since, now = Date.now()) {
    await this.ensureFresh(now)

    const from = Math.max(since ?? -Infinity, now - this.retentionMs)
    return this.entries.filter(entry => entry.ts > from)
  }

  async readSerialized (build, now = Date.now()) {
    await this.ensureFresh(now)

    if (this.serializedCache?.version !== this.version) {
      this.serializedCache = { version: this.version, body: JSON.stringify(build(this.entries)) }
    }
    return this.serializedCache.body
  }

  refresh (now = Date.now()) {
    if (!this.inflight) {
      this.inflight = this._refresh(now).finally(() => { this.inflight = null })
    }
    return this.inflight
  }

  async _refresh (now) {
    const oldest = now - this.retentionMs
    const lastTs = this.entries.length ? this.entries[this.entries.length - 1].ts : null
    const start = this.loadedFrom === null || this.loadedFrom > oldest
      ? oldest + 1
      : Math.max(oldest + 1, (lastTs ?? oldest) - this.refetchMs + 1)

    const fetched = []
    for (let from = start; from <= now; from += this.chunkMs) {
      const rows = await this.fetch(from, Math.min(from + this.chunkMs - 1, now))
      fetched.push(...rows)
    }

    this._merge(fetched, oldest)
    this.loadedFrom = oldest
    this.refreshedAt = now
  }

  _merge (rows, oldest) {
    const lastTs = this.entries.length ? this.entries[this.entries.length - 1].ts : -Infinity
    const valid = rows.filter(entry => Number.isFinite(entry?.ts) && entry.ts > oldest)
    const appendable = valid.every((entry, i) => entry.ts > (i ? valid[i - 1].ts : lastTs))

    if (appendable) {
      const firstKept = this.entries.findIndex(entry => entry.ts > oldest)
      if (firstKept === 0 && !valid.length) return
      this.entries = (firstKept === -1 ? [] : this.entries.slice(firstKept)).concat(valid)
      this.version++
      return
    }

    const byTs = new Map()
    for (const entry of this.entries) {
      if (entry.ts > oldest) byTs.set(entry.ts, entry)
    }
    for (const entry of valid) byTs.set(entry.ts, entry)
    this.entries = [...byTs.values()].sort((a, b) => a.ts - b.ts)
    this.version++
  }
}

module.exports = { RealtimeSeries }
