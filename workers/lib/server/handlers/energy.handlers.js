'use strict'

const { WORKER_TYPES, RPC_METHODS, ELECTRICITY_EXT_DATA_KEYS } = require('../../constants')

const getEnergyForecast = async (ctx, req) => {
  return await ctx.dataProxy.requestDataMap(
    RPC_METHODS.GET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      query: { key: ELECTRICITY_EXT_DATA_KEYS.FORECAST }
    })
}

const getEnergyForecastHistory = async (ctx, req) => {
  const { start, end } = req.query
  return await ctx.dataProxy.requestDataMap(
    RPC_METHODS.GET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      query: { key: ELECTRICITY_EXT_DATA_KEYS.FORECAST_HISTORY },
      start,
      end
    })
}

const setAvailableEnergy = async (ctx, req) => {
  return await ctx.dataProxy.requestDataMap(
    RPC_METHODS.SET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      key: ELECTRICITY_EXT_DATA_KEYS.AVAIL_ENERGY,
      value: req.body.data
    })
}

const getForecastSettings = async (ctx, req) => {
  return await ctx.dataProxy.requestDataMap(
    RPC_METHODS.GET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      query: { key: ELECTRICITY_EXT_DATA_KEYS.FORECAST_SETTINGS }
    })
}

const setForecastSettings = async (ctx, req) => {
  return await ctx.dataProxy.requestDataMap(
    RPC_METHODS.SET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      key: ELECTRICITY_EXT_DATA_KEYS.FORECAST_SETTINGS,
      value: req.body
    })
}

const setForecastOverride = async (ctx, req) => {
  return await ctx.dataProxy.requestDataMap(
    RPC_METHODS.SET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      key: ELECTRICITY_EXT_DATA_KEYS.FORECAST_OVERRIDE,
      value: req.body
    })
}

module.exports = {
  getEnergyForecast,
  setAvailableEnergy,
  getEnergyForecastHistory,
  setForecastSettings,
  getForecastSettings,
  setForecastOverride
}
