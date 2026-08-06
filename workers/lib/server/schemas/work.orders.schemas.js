'use strict'

const { WORK_ORDER_TYPES } = require('../../constants')

const types = { type: 'integer', enum: Object.values(WORK_ORDER_TYPES) }

const warranty = {
  type: ['object', 'null'],
  properties: {
    vendor: { type: ['string', 'null'] },
    fields: { type: 'object', additionalProperties: true }
  }
}

const create = {
  body: {
    type: 'object',
    required: ['type', 'deviceType', 'deviceModel', 'deviceIdentifier'],
    additionalProperties: false,
    properties: {
      type: types,
      deviceType: { type: 'string', minLength: 1, maxLength: 100 },
      deviceModel: { type: 'string', minLength: 1, maxLength: 100 },
      deviceIdentifier: { type: 'string', minLength: 1, maxLength: 200 },
      issue: { type: 'string', minLength: 1, maxLength: 2000 },
      assignedTo: { type: ['string', 'null'], maxLength: 200 },
      warranty,
      info: {
        type: 'object',
        additionalProperties: false,
        properties: {
          notes: { type: 'string', maxLength: 4000 },
          remarks: { type: 'string', maxLength: 4000 },
          site: { type: 'string', maxLength: 200 },
          location: { type: 'string', maxLength: 200 },
          deviceStatus: { type: 'string', maxLength: 100 },
          pos: { type: 'string', maxLength: 200 },
          container: { type: 'string', maxLength: 200 },
          subnet: { type: 'string', maxLength: 200 },
          replacementIdentifier: { type: 'string', minLength: 1, maxLength: 200 }
        }
      }
    },
    if: { properties: { type: { enum: [WORK_ORDER_TYPES.MICROBT_MINER, WORK_ORDER_TYPES.MICROBT_NON_MINER] } } },
    then: { required: ['issue'] }
  }
}

// Batch variant of `create`: one work order carrying many devices.
const createBatch = {
  body: {
    type: 'object',
    required: ['type', 'devices'],
    additionalProperties: false,
    properties: {
      type: types,
      devices: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          required: ['deviceType', 'deviceModel', 'deviceIdentifier'],
          additionalProperties: false,
          properties: {
            deviceType: { type: 'string', minLength: 1, maxLength: 100 },
            deviceModel: { type: 'string', minLength: 1, maxLength: 100 },
            deviceIdentifier: { type: 'string', minLength: 1, maxLength: 200 },
            pos: { type: 'string', maxLength: 200 },
            container: { type: 'string', maxLength: 200 },
            subnet: { type: 'string', maxLength: 200 },
            replacementIdentifier: { type: 'string', minLength: 1, maxLength: 200 }
          }
        }
      },
      issue: { type: 'string', minLength: 1, maxLength: 2000 },
      assignedTo: { type: ['string', 'null'], maxLength: 200 },
      warranty,
      info: {
        type: 'object',
        additionalProperties: false,
        properties: {
          notes: { type: 'string', maxLength: 4000 },
          remarks: { type: 'string', maxLength: 4000 },
          site: { type: 'string', maxLength: 200 },
          location: { type: 'string', maxLength: 200 },
          deviceStatus: { type: 'string', maxLength: 100 },
          minerIdentifier: { type: 'string', maxLength: 200 }
        }
      }
    },
    if: { properties: { type: { enum: [WORK_ORDER_TYPES.MICROBT_MINER, WORK_ORDER_TYPES.MICROBT_NON_MINER] } } },
    then: { required: ['issue'] }
  }
}

const list = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      sort: { type: 'string' },
      fields: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      q: { type: 'string', minLength: 1, maxLength: 200 },
      assignee: { type: 'string', minLength: 1, maxLength: 200 },
      creator: { type: 'string', minLength: 1, maxLength: 200 },
      partId: { type: 'string', minLength: 1, maxLength: 200 },
      status: { type: 'string', enum: ['open', 'in_progress', 'closed', 'cancelled'] },
      type: types,
      from: { type: 'integer', minimum: 0 },
      to: { type: 'integer', minimum: 0 },
      overwriteCache: { type: 'boolean' }
    }
  }
}

const byId = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1 } }
  }
}

const update = {
  params: byId.params,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      issue: { type: 'string', minLength: 1, maxLength: 2000 },
      deviceType: { type: 'string', minLength: 1, maxLength: 100 },
      deviceModel: { type: 'string', minLength: 1, maxLength: 100 },
      deviceIdentifier: { type: 'string', minLength: 1, maxLength: 200 },
      assignedTo: { type: ['string', 'null'], maxLength: 200 },
      finalResult: { type: ['string', 'null'], maxLength: 4000 },
      warranty,
      info: {
        type: 'object',
        additionalProperties: false,
        properties: {
          issue: { type: 'string', minLength: 1, maxLength: 2000 },
          notes: { type: 'string', maxLength: 4000 },
          remarks: { type: 'string', maxLength: 4000 },
          site: { type: 'string', maxLength: 200 },
          location: { type: 'string', maxLength: 200 },
          deviceStatus: { type: 'string', maxLength: 100 },
          partsMoves: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              required: ['role'],
              properties: {
                role: { type: 'string' },
                partId: { type: 'string' },
                partCode: { type: 'string' },
                deviceType: { type: 'string' },
                fromLocation: { type: ['string', 'null'] },
                toLocation: { type: ['string', 'null'] },
                reason: { type: ['string', 'null'] },
                replacesPartCode: { type: 'string' },
                partStatus: { type: 'string' },
                ts: { type: 'number' },
                user: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }
}

const close = {
  params: byId.params,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { finalResult: { type: 'string', minLength: 1, maxLength: 4000 } }
  }
}

const cancel = {
  params: byId.params,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } }
  }
}

const reopen = {
  params: byId.params,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } }
  }
}

const assign = {
  params: byId.params,
  body: {
    type: 'object',
    required: ['assignedTo'],
    additionalProperties: false,
    properties: { assignedTo: { type: ['string', 'null'], maxLength: 200 } }
  }
}

const log = {
  params: byId.params,
  body: {
    type: 'object',
    required: ['text'],
    additionalProperties: false,
    properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } }
  }
}

const audit = {
  params: byId.params,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      start: { type: 'integer' },
      end: { type: 'integer' }
    }
  }
}

const exportRoute = {
  params: byId.params,
  querystring: {
    type: 'object',
    required: ['format'],
    additionalProperties: false,
    properties: {
      format: { type: 'string', enum: ['pdf', 'csv', 'docx'] }
    }
  }
}

const exportRma = {
  querystring: {
    type: 'object',
    required: ['ids'],
    additionalProperties: false,
    properties: {
      ids: { type: 'string', minLength: 1, maxLength: 4000 }
    }
  }
}

module.exports = { create, createBatch, list, byId, update, close, cancel, reopen, assign, audit, log, export: exportRoute, exportRma }
