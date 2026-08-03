'use strict'

const test = require('brittle')
const { capCheck } = require('../../../workers/lib/server/lib/capCheck')

test('capCheck - has permissions', async (t) => {
  const mockCtx = {
    authLib: {
      tokenHasPerms: async (token, write, perms) => {
        t.is(token, 'test-token', 'should pass token')
        t.is(write, true, 'should pass write flag')
        t.is(perms[0], 'test:perm', 'should pass permissions')
        return true
      }
    }
  }

  const mockReq = {
    _info: {
      authToken: 'test-token'
    }
  }

  const mockRep = {}

  await capCheck(mockCtx, mockReq, mockRep, ['test:perm'], true)
  t.pass()
})

test('capCheck - no permissions', async (t) => {
  const mockCtx = {
    authLib: {
      tokenHasPerms: async () => false
    }
  }

  const mockReq = {
    _info: {
      authToken: 'test-token'
    }
  }

  const mockRep = {
    status: function (code) {
      t.is(code, 401, 'should return 401 status')
      return this
    },
    send: function (data) {
      t.is(data.message, 'ERR_AUTH_FAIL_NO_PERMS', 'should return ERR_AUTH_FAIL_NO_PERMS')
      return this
    }
  }

  await capCheck(mockCtx, mockReq, mockRep, ['test:perm'], true)
  t.pass()
})

test('capCheck - write flag false', async (t) => {
  const mockCtx = {
    authLib: {
      tokenHasPerms: async (token, write, perms) => {
        t.is(write, false, 'should pass write flag as false')
        return true
      }
    }
  }

  const mockReq = {
    _info: {
      authToken: 'test-token'
    }
  }

  const mockRep = {}

  await capCheck(mockCtx, mockReq, mockRep, ['test:perm'], false)
  t.pass()
})

test('capCheck - admin_external allowed to read users list (users:r, write=false)', async (t) => {
  const mockCtx = {
    authLib: {
      tokenHasPerms: async (token, write, perms) => {
        t.is(token, 'admin-external-token', 'should pass through the auth token')
        t.is(write, false, 'should request a read-level check, not write')
        t.is(perms[0], 'users:r', 'should request the users:r permission')
        return true
      }
    }
  }

  const mockReq = {
    _info: {
      authToken: 'admin-external-token'
    }
  }

  let denied = false
  const mockRep = {
    status: function () { denied = true; return this },
    send: function () { return this }
  }

  await capCheck(mockCtx, mockReq, mockRep, ['users:r'], false)
  t.ok(!denied, 'should not deny admin_external reading the users list')
  t.pass()
})

test('capCheck - admin_external denied when checked with write=true', async (t) => {
  const mockCtx = {
    authLib: {
      // Mirrors AuthLib.tokenHasPerms: admin_external lacks actions:w,
      // so any write=true check is denied regardless of the requested perm.
      tokenHasPerms: async (token, write, perms) => !write
    }
  }

  const mockReq = {
    _info: {
      authToken: 'admin-external-token'
    }
  }

  const mockRep = {
    status: function (code) {
      t.is(code, 401, 'should return 401 status')
      return this
    },
    send: function (data) {
      t.is(data.message, 'ERR_AUTH_FAIL_NO_PERMS', 'should return ERR_AUTH_FAIL_NO_PERMS')
      return this
    }
  }

  await capCheck(mockCtx, mockReq, mockRep, ['users:r'])
  t.pass()
})
