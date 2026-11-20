const { before, describe, test } = require('node:test')
const assert = require('node:assert/strict')

let resolveKeepaliveStart
let defaultKeepaliveMode
let keepaliveModeValues

before(async () => {
  const mod = await import('../../client/common/keepalive-default.js')
  resolveKeepaliveStart = mod.resolveKeepaliveStart
  defaultKeepaliveMode = mod.defaultKeepaliveMode
  keepaliveModeValues = mod.keepaliveModeValues
})

describe('resolveKeepaliveStart', () => {
  test('an explicit tab state beats the bookmark override and the global switch', () => {
    assert.equal(resolveKeepaliveStart({
      tabKeepaliveEnabled: true,
      tabKeepaliveMode: keepaliveModeValues.off,
      globalDefault: false
    }), true)
    assert.equal(resolveKeepaliveStart({
      tabKeepaliveEnabled: false,
      tabKeepaliveMode: keepaliveModeValues.on,
      globalDefault: true
    }), false)
  })

  test('the bookmark override beats the global switch', () => {
    assert.equal(resolveKeepaliveStart({
      tabKeepaliveMode: keepaliveModeValues.on,
      globalDefault: false
    }), true)
    assert.equal(resolveKeepaliveStart({
      tabKeepaliveMode: keepaliveModeValues.off,
      globalDefault: true
    }), false)
  })

  test('inherit follows the global switch', () => {
    assert.equal(resolveKeepaliveStart({
      tabKeepaliveMode: keepaliveModeValues.inherit,
      globalDefault: true
    }), true)
    assert.equal(resolveKeepaliveStart({
      tabKeepaliveMode: keepaliveModeValues.inherit,
      globalDefault: false
    }), false)
  })

  test('nothing configured leaves the heartbeat off', () => {
    assert.equal(resolveKeepaliveStart(), false)
    assert.equal(resolveKeepaliveStart({}), false)
  })

  test('the global switch only counts when it is exactly true', () => {
    assert.equal(resolveKeepaliveStart({ globalDefault: 1 }), false)
    assert.equal(resolveKeepaliveStart({ globalDefault: 'true' }), false)
    assert.equal(resolveKeepaliveStart({ globalDefault: undefined }), false)
  })

  test('an unknown bookmark mode falls back to the global switch', () => {
    assert.equal(resolveKeepaliveStart({
      tabKeepaliveMode: 'maybe',
      globalDefault: true
    }), true)
    assert.equal(resolveKeepaliveStart({
      tabKeepaliveMode: 'maybe',
      globalDefault: false
    }), false)
  })
})

describe('defaultKeepaliveMode', () => {
  test('a new bookmark has no opinion and inherits the global switch', () => {
    assert.equal(defaultKeepaliveMode(), keepaliveModeValues.inherit)
  })
})
