'use strict'

const utilsStore = require('@tetherto/hp-svc-facs-store/utils')
const mingo = require('mingo')
const { GLOBAL_DATA_TYPES, LCOE_SOURCES, USER_SETTINGS_TYPE } = require('./constants')
const gLibUtilBase = require('@bitfinex/lib-js-util-base')
const { isValidJsonObject } = require('./utils')

function validateCostParameterFields (data) {
  const amounts = ['minerAmortizationUsd', 'infraAmortizationUsd']
  for (const field of amounts) {
    const val = data[field]
    if (val !== undefined && val !== null && (!Number.isFinite(val) || val < 0)) {
      throw new Error('ERR_INVALID_AMORTIZATION')
    }
  }

  const { marginPct } = data
  if (marginPct !== undefined && marginPct !== null &&
    (!Number.isFinite(marginPct) || marginPct < 0 || marginPct > 100)) {
    throw new Error('ERR_INVALID_MARGIN')
  }

  const lcoe = data.lcoe
  if (lcoe !== undefined && lcoe !== null) {
    if (!isValidJsonObject(lcoe)) throw new Error('ERR_INVALID_LCOE')
    if (lcoe.source !== undefined && !LCOE_SOURCES.includes(lcoe.source)) {
      throw new Error('ERR_INVALID_LCOE_SOURCE')
    }
    const custom = lcoe.customUsdPerMwh
    if (custom !== undefined && custom !== null && (!Number.isFinite(custom) || custom < 0)) {
      throw new Error('ERR_INVALID_LCOE_COST')
    }
    if (lcoe.source === 'custom' && (custom === undefined || custom === null)) {
      throw new Error('ERR_LCOE_COST_REQUIRED')
    }
  }
}

class GlobalDataLib {
  constructor (globalDataBee, site) {
    this._globalDataBee = globalDataBee
    this.site = site
  }

  convertRangeToBin (range) {
    if (range) {
      if (range.gt) range.gt = utilsStore.convIntToBin(range.gt)
      if (range.gte) range.gte = utilsStore.convIntToBin(range.gte)
      if (range.lt) range.lt = utilsStore.convIntToBin(range.lt)
      if (range.lte) range.lte = utilsStore.convIntToBin(range.lte)
    }
    return range
  }

  async queryGlobalData (db, range = undefined, opts = undefined) {
    const data = []
    const stream = db.createReadStream(range, opts)
    for await (const entry of stream) {
      data.push(JSON.parse(entry.value.toString()))
    }
    return data
  }

  filterData (data, req) {
    const { queryJSON, fields, sort, offset, limit } = req
    const query = new mingo.Query(queryJSON || {})
    let cursor = query.find(data, fields || {})
    if (!gLibUtilBase.isNil(sort)) cursor = cursor.sort(sort)
    if (!gLibUtilBase.isNil(offset)) cursor = cursor.skip(offset)
    if (!gLibUtilBase.isNil(limit)) cursor = cursor.limit(limit)

    return cursor.all()
  }

  async getGloabalDbDataForType (type) {
    const res = await this._globalDataBee.sub(type).get(type)
    return res?.value ? JSON.parse(res.value) : {}
  }

  async getGlobalData (req) {
    const { type, range, opts, query, fields, sort, offset, limit, groupBy, model } = req

    if (!Object.values(GLOBAL_DATA_TYPES).includes(type)) {
      throw new Error('ERR_INVALID_TYPE')
    }

    if (type === GLOBAL_DATA_TYPES.FEATURES || type === GLOBAL_DATA_TYPES.COST_PARAMETERS) {
      return await this.getGloabalDbDataForType(type)
    }

    if (type === GLOBAL_DATA_TYPES.CONTAINER_SETTINGS) {
      const settingsMap = await this.getGloabalDbDataForType(type)
      if (settingsMap && typeof settingsMap === 'object') {
        let results = Object.values(settingsMap).filter(
          item => item && typeof item === 'object' && item.model && item.site === this.site
        )

        if (model) {
          results = results.filter(item => item.model === model)
        }

        return results
      }
      return []
    }

    const data = await this.queryGlobalData(
      this._globalDataBee.sub(type),
      this.convertRangeToBin(range),
      opts
    )

    const res = this.filterData(data, {
      queryJSON: query,
      fields,
      sort,
      offset,
      limit
    })

    if (groupBy) {
      return gLibUtilBase.groupBy(res, data => data[groupBy])
    }

    return res
  }

  async setProductionCostsData (data) {
    if (!Number.isInteger(data.year) || data.year < 0) {
      throw new Error('ERR_INVALID_YEAR')
    }
    if (!Number.isInteger(data.month) || data.month < 1 || data.month > 12) {
      throw new Error('ERR_INVALID_MONTH')
    }
    const id = data.year * 100 + data.month
    const productionData = {
      site: this.site,
      year: data.year,
      month: data.month,
      energyCost: data.energyCost,
      operationalCost: data.operationalCost
    }
    await this._globalDataBee
      .sub(GLOBAL_DATA_TYPES.PRODUCTION_COSTS)
      .put(utilsStore.convIntToBin(id), JSON.stringify(productionData))

    return true
  }

  async setCostParametersData (data) {
    if (!isValidJsonObject(data)) throw new Error('ERR_INVALID_JSON')

    const { year, month, ...fields } = data
    const current = await this.getGloabalDbDataForType(GLOBAL_DATA_TYPES.COST_PARAMETERS)

    // No year/month: save the site defaults, keeping whatever monthly overrides are already stored.
    if (year === undefined && month === undefined) {
      validateCostParameterFields(fields)
      return this.saveGlobalDataForType(
        { ...fields, site: this.site, overrides: fields.overrides ?? current.overrides },
        GLOBAL_DATA_TYPES.COST_PARAMETERS
      )
    }

    if (!Number.isInteger(year) || year < 0) throw new Error('ERR_INVALID_YEAR')
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('ERR_INVALID_MONTH')
    validateCostParameterFields(fields)

    const monthKey = `${year}-${String(month).padStart(2, '0')}`
    const overrides = { ...current.overrides }
    // An all-empty payload is the UI's Reset: drop the month rather than storing a blank override.
    if (Object.values(fields).every(v => v === null || v === undefined)) delete overrides[monthKey]
    else overrides[monthKey] = fields

    return this.saveGlobalDataForType(
      { ...current, site: this.site, overrides },
      GLOBAL_DATA_TYPES.COST_PARAMETERS
    )
  }

  async saveGlobalDataForType (data, type) {
    if (!isValidJsonObject(data)) throw new Error('ERR_INVALID_JSON')
    await this._globalDataBee.sub(type).put(type, JSON.stringify(data))
    return true
  }

  async setContainerSettingsData (data) {
    if (!isValidJsonObject(data)) throw new Error('ERR_INVALID_JSON')

    const existingSettings = await this.getGloabalDbDataForType(GLOBAL_DATA_TYPES.CONTAINER_SETTINGS)
    const settingsMap = {}

    if (isValidJsonObject(existingSettings)) {
      for (const [, value] of Object.entries(existingSettings)) {
        if (value && typeof value === 'object' && value.model && value.site) {
          const correctKey = `${value.model}_${value.site}`
          settingsMap[correctKey] = value
        }
      }
    }

    const key = `${data.model}_${this.site}`
    settingsMap[key] = data

    await this._globalDataBee
      .sub(GLOBAL_DATA_TYPES.CONTAINER_SETTINGS)
      .put(GLOBAL_DATA_TYPES.CONTAINER_SETTINGS, JSON.stringify(settingsMap))

    return true
  }

  async setGlobalData (data, type) {
    if (!Object.values(GLOBAL_DATA_TYPES).includes(type)) {
      throw new Error('ERR_INVALID_TYPE')
    }

    if (type === GLOBAL_DATA_TYPES.PRODUCTION_COSTS) {
      return this.setProductionCostsData(data)
    }

    if (type === GLOBAL_DATA_TYPES.COST_PARAMETERS) {
      return this.setCostParametersData(data)
    }

    if (type === GLOBAL_DATA_TYPES.CONTAINER_SETTINGS) {
      return this.setContainerSettingsData(data)
    }

    return this.saveGlobalDataForType(data, type)
  }

  async getUserSettings (userId) {
    const res = await this._globalDataBee.sub(USER_SETTINGS_TYPE).get(userId)
    return res?.value ? JSON.parse(res.value) : {}
  }

  async setUserSettings (userId, data) {
    await this._globalDataBee.sub(USER_SETTINGS_TYPE).put(userId, JSON.stringify(data))
    return true
  }
}

module.exports = GlobalDataLib
