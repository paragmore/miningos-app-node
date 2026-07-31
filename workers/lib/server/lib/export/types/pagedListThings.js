'use strict'

const PAGE_LIMIT = 100

async function * pagedListThings (ctx, query, fields) {
  let offset = 0
  while (true) {
    const orkPages = await ctx.dataProxy.requestDataMap('listThings', {
      status: 1,
      query,
      fields,
      limit: PAGE_LIMIT,
      offset
    })
    let longest = 0
    for (const orkPage of Array.isArray(orkPages) ? orkPages : []) {
      if (!Array.isArray(orkPage)) continue
      longest = Math.max(longest, orkPage.length)
      yield * orkPage
    }
    if (longest < PAGE_LIMIT) break
    offset += PAGE_LIMIT
  }
}

module.exports = { pagedListThings, PAGE_LIMIT }
