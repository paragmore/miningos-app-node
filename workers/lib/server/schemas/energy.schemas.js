'use strict'

const schemas = {
  body: {
    availableEnergy: {
      type: 'object',
      properties: {
        data: {
          type: 'array'
        }
      },
      required: ['data']
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
