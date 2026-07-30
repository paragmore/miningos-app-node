'use strict'

const { HTTP_METHODS, ENDPOINTS } = require('../../constants')
const { authCheck } = require('../lib/authCheck')
const { getAuthTokenFromHeaders } = require('../../utils')

module.exports = (ctx) => [{
  method: HTTP_METHODS.GET,
  url: ENDPOINTS.WEBSOCKET,
  websocket: true,
  onRequest: async (req, rep) => {
    // Prefer Authorization header; query token kept for browser WS clients
    const token = getAuthTokenFromHeaders(req.headers) || req.query.token
    await authCheck(ctx, req, rep, token)
  },
  handler: async (socket, _request) => {
    socket.subscriptions = new Set()

    ctx.wsClients.add(socket)

    socket.on('message', async (data) => {
      try {
        const message = JSON.parse(data)
        if (message.event === 'subscribe' && message.channel) {
          socket.subscriptions.add(message.channel)

          if (message.channel === 'alerts') {
            const alerts = await ctx.alertsService.fetchAlerts(true)
            socket.send(JSON.stringify(alerts))
          }
        } else if (message.event === 'unsubscribe' && message.channel) {
          socket.subscriptions.delete(message.channel)
        }
      } catch {
        socket.send(JSON.stringify({ error: 'Invalid message format' }))
      }
    })

    socket.on('close', () => {
      ctx.wsClients.delete(socket)
    })

    socket.on('error', () => {
      ctx.wsClients.delete(socket)
    })
  }
}]
