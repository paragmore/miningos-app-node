'use strict'

const {
  ENDPOINTS,
  HTTP_METHODS,
  AUTH_PERMISSIONS
} = require('../../constants')
const schemas = require('../schemas/work.orders.schemas')
const {
  createWorkOrder,
  createWorkOrdersBatch,
  listWorkOrders,
  getWorkOrder,
  updateWorkOrder,
  closeWorkOrder,
  cancelWorkOrder,
  reopenWorkOrder,
  assignWorkOrder,
  appendWorkLogEntry,
  getWorkOrderAudit,
  exportWorkOrder,
  exportWorkOrdersRma
} = require('../handlers/work.orders.handlers')
const { createAuthRoute, createCachedAuthRoute } = require('../lib/routeHelpers')
const { stableJsonString } = require('../../utils')

module.exports = (ctx) => [
  {
    method: HTTP_METHODS.POST,
    url: ENDPOINTS.WORK_ORDERS,
    schema: schemas.create,
    ...createAuthRoute(ctx, createWorkOrder, [AUTH_PERMISSIONS.WORK_ORDER])
  },
  {
    method: HTTP_METHODS.POST,
    url: ENDPOINTS.WORK_ORDERS_BATCH,
    schema: schemas.createBatch,
    ...createAuthRoute(ctx, createWorkOrdersBatch, [AUTH_PERMISSIONS.WORK_ORDER])
  },
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.WORK_ORDERS,
    schema: schemas.list,
    ...createCachedAuthRoute(
      ctx,
      (req) => [
        'work-orders',
        stableJsonString(req.query.query),
        stableJsonString(req.query.sort),
        stableJsonString(req.query.fields),
        req.query.offset,
        req.query.limit,
        req.query.q,
        req.query.assignee,
        req.query.creator,
        req.query.partId,
        req.query.status,
        req.query.type,
        req.query.from,
        req.query.to
      ],
      ENDPOINTS.WORK_ORDERS,
      listWorkOrders,
      [AUTH_PERMISSIONS.WORK_ORDER]
    )
  },
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.WORK_ORDER_BY_ID,
    schema: schemas.byId,
    ...createAuthRoute(ctx, getWorkOrder, [AUTH_PERMISSIONS.WORK_ORDER])
  },
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.WORK_ORDER_AUDIT,
    schema: schemas.audit,
    ...createCachedAuthRoute(
      ctx,
      (req) => ['work-orders/audit', req.params.id, req.query.start, req.query.end, req.query.offset, req.query.limit],
      ENDPOINTS.WORK_ORDER_AUDIT,
      getWorkOrderAudit,
      [AUTH_PERMISSIONS.WORK_ORDER]
    )
  },
  {
    method: HTTP_METHODS.PATCH,
    url: ENDPOINTS.WORK_ORDER_BY_ID,
    schema: schemas.update,
    ...createAuthRoute(ctx, updateWorkOrder, [AUTH_PERMISSIONS.WORK_ORDER])
  },
  {
    method: HTTP_METHODS.POST,
    url: ENDPOINTS.WORK_ORDER_CLOSE,
    schema: schemas.close,
    ...createAuthRoute(ctx, closeWorkOrder, [AUTH_PERMISSIONS.WORK_ORDER])
  },
  {
    method: HTTP_METHODS.POST,
    url: ENDPOINTS.WORK_ORDER_CANCEL,
    schema: schemas.cancel,
    ...createAuthRoute(ctx, cancelWorkOrder, [AUTH_PERMISSIONS.WORK_ORDER])
  },
  {
    method: HTTP_METHODS.POST,
    url: ENDPOINTS.WORK_ORDER_REOPEN,
    schema: schemas.reopen,
    ...createAuthRoute(ctx, reopenWorkOrder, [AUTH_PERMISSIONS.WORK_ORDER])
  },
  {
    method: HTTP_METHODS.POST,
    url: ENDPOINTS.WORK_ORDER_ASSIGN,
    schema: schemas.assign,
    ...createAuthRoute(ctx, assignWorkOrder, [AUTH_PERMISSIONS.WORK_ORDER])
  },
  {
    method: HTTP_METHODS.POST,
    url: ENDPOINTS.WORK_ORDER_LOG,
    schema: schemas.log,
    ...createAuthRoute(ctx, appendWorkLogEntry, [AUTH_PERMISSIONS.WORK_ORDER])
  },
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.WORK_ORDER_EXPORT,
    schema: schemas.export,
    ...createAuthRoute(ctx, exportWorkOrder, [AUTH_PERMISSIONS.WORK_ORDER])
  },
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.WORK_ORDER_EXPORT_RMA,
    schema: schemas.exportRma,
    ...createAuthRoute(ctx, exportWorkOrdersRma, [AUTH_PERMISSIONS.WORK_ORDER])
  }
]
