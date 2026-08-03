'use strict'

// Group sites store their layout in the Siemens DCS worker config.
const GROUP_SITE_WORKER_TYPE = 'dcs-siemens'
const GROUP_SITE_LAYOUT_KEY = 'group'
const GROUP_SITE_TYPE = 'group'

// requestDataMap returns array-per-ork of array-per-rack; find the config carrying the layout.
function findConfigWithLayout (res) {
  const flat = []
  const walk = (v) => {
    if (Array.isArray(v)) {
      v.forEach(walk)
    } else if (v && typeof v === 'object') {
      flat.push(v)
    }
  }
  walk(res)
  return flat.find((c) => c && c.pduGridLayout)
}

// Returns a device/container type's static PDU grid layout from worker config.
async function getPduLayout (ctx, req) {
  const { type } = req.query
  const isGroupSite = type === GROUP_SITE_TYPE

  const workerType = isGroupSite ? GROUP_SITE_WORKER_TYPE : type
  const layoutKey = isGroupSite ? GROUP_SITE_LAYOUT_KEY : type

  const res = await ctx.dataProxy.requestDataMap('getWrkConf', { type: workerType })
  const config = findConfigWithLayout(res)
  const layout = config && config.pduGridLayout && config.pduGridLayout[layoutKey]

  if (!layout) {
    throw new Error('ERR_PDU_LAYOUT_NOT_FOUND')
  }

  if (isGroupSite) {
    const id = req.query.container ? req.query.container.split('-')[1] : '1'
    return {
      type,
      layout: layout.map((item) => ({ ...item, pdu: item.pdu.replace('X', id) }))
    }
  }

  return { type, layout }
}

module.exports = {
  getPduLayout
}
