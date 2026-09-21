'use strict'

const schemas = {
  body: {
    availableEnergy: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              start: { type: 'integer', minimum: 0 },
              end: { type: 'integer', minimum: 0 },
              availableMw: { type: 'number', minimum: 0, maximum: 48 },
              available: { type: ['boolean', 'integer'], minimum: 0, maximum: 1 }
            },
            required: ['start'],
            anyOf: [
              { required: ['availableMw'] },
              { required: ['available'] }
            ]
          }
        }
      },
      required: ['data']
    },
    availableEnergyHistory: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        availableMw: { type: 'number', minimum: 0, maximum: 48 },
        available: { type: 'boolean' }
      },
      required: [
        'start',
        'end'
      ],
      anyOf: [
        { required: ['availableMw'] },
        { required: ['available'] }
      ]
    },
    forecastSettings: {
      type: 'object',
      properties: {
        miningRevenueTaxFees: {
          type: 'object'
        },
        sellingEnergyTaxFees: {
          type: 'object'
        },
        buyingEnergyTaxFees: {
          type: 'object'
        },
        lcoe: {
          type: 'object'
        },
        siteEfficiency: {
          type: 'object'
        }
      },
      required: [
        'miningRevenueTaxFees',
        'sellingEnergyTaxFees',
        'buyingEnergyTaxFees',
        'lcoe',
        'siteEfficiency'
      ]
    },
    forecastOverride: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        manualOverrideMine: { type: 'boolean' }
      },
      required: [
        'start',
        'end',
        'manualOverrideMine'
      ]
    }
  }
}

module.exports = schemas
