const { before, describe, test } = require('node:test')
const assert = require('node:assert/strict')

// The pure half of the widget launch list (client/common/widget-auto-run-utils.js):
// one row per widget, and no secret in a row — a row is written to the db as
// plain JSON, and a stale key there would win over the saved one.

let isApiKeyField
let secretFieldNames
let stripApiKeys
let dedupeAutoRunWidgets
let upsertAutoRunWidget

const CONFIGS = [
  { name: 'host', type: 'string' },
  { name: 'port', type: 'number' },
  { name: 'apiKey', type: 'string', showGenerator: true }
]

before(async () => {
  const mod = await import('../../client/common/widget-auto-run-utils.js')
  isApiKeyField = mod.isApiKeyField
  secretFieldNames = mod.secretFieldNames
  stripApiKeys = mod.stripApiKeys
  dedupeAutoRunWidgets = mod.dedupeAutoRunWidgets
  upsertAutoRunWidget = mod.upsertAutoRunWidget
})

describe('widget auto run list', () => {
  test('only a generated field is a secret', () => {
    assert.equal(isApiKeyField({ name: 'apiKey', showGenerator: true }), true)
    assert.equal(isApiKeyField({ name: 'host' }), false)
    assert.equal(isApiKeyField(null), false)
    assert.deepStrictEqual(secretFieldNames(CONFIGS), ['apiKey'])
  })

  test('a secret is taken out of the config that is stored', () => {
    const config = { host: '127.0.0.1', port: 30837, apiKey: 'ett_secret' }
    const cleaned = stripApiKeys(CONFIGS, config)
    assert.deepStrictEqual(cleaned, { host: '127.0.0.1', port: 30837 })
    // the input is not touched: the caller keeps the key it was given
    assert.equal(config.apiKey, 'ett_secret')
  })

  test('a widget without a secret keeps its config as it is', () => {
    const config = { host: '127.0.0.1' }
    assert.deepStrictEqual(stripApiKeys([{ name: 'host' }], config), { host: '127.0.0.1' })
    assert.deepStrictEqual(stripApiKeys([], config), { host: '127.0.0.1' })
  })

  test('a known secret is taken out even without the manifest', () => {
    // the manifest arrives over IPC: a launch row written before it did must
    // still not keep the key in the db
    const cleaned = stripApiKeys([], { host: '127.0.0.1', apiKey: 'ett_secret' })
    assert.deepStrictEqual(cleaned, { host: '127.0.0.1' })
  })

  test('the same widget is launched once, with its newest config', () => {
    const list = [
      { id: '1', widgetId: 'mcp-server', config: { port: 1 } },
      { id: '2', widgetId: 'other', config: {} },
      { id: '3', widgetId: 'mcp-server', config: { port: 2 } }
    ]
    const deduped = dedupeAutoRunWidgets(list)
    assert.equal(deduped.length, 2)
    // the newest row wins, and it keeps the place of the first one
    assert.equal(deduped[0].widgetId, 'mcp-server')
    assert.deepStrictEqual(deduped[0].config, { port: 2 })
    assert.equal(deduped[1].widgetId, 'other')
  })

  test('an empty or malformed list is not a crash', () => {
    assert.deepStrictEqual(dedupeAutoRunWidgets(null), [])
    assert.deepStrictEqual(dedupeAutoRunWidgets([]), [])
    assert.deepStrictEqual(dedupeAutoRunWidgets([{ id: '1' }]), [])
  })

  test('a new row goes to the end and keeps the others where they are', () => {
    const list = [{ id: '1', widgetId: 'a', config: {} }]
    const next = upsertAutoRunWidget(list, 'b', { id: '2', widgetId: 'b', config: {} })
    assert.deepStrictEqual(next.map(w => w.widgetId), ['a', 'b'])
  })

  test('replacing a row keeps its place in the launch order', () => {
    const list = [
      { id: '1', widgetId: 'a', config: { port: 1 } },
      { id: '2', widgetId: 'b', config: {} }
    ]
    const next = upsertAutoRunWidget(list, 'a', { id: '1', widgetId: 'a', config: { port: 9 } })
    assert.deepStrictEqual(next.map(w => w.widgetId), ['a', 'b'])
    assert.equal(next[0].id, '1')
    assert.deepStrictEqual(next[0].config, { port: 9 })
  })

  test('removing a widget takes every row of it away', () => {
    const list = [
      { id: '1', widgetId: 'a', config: {} },
      { id: '2', widgetId: 'b', config: {} },
      { id: '3', widgetId: 'b', config: {} }
    ]
    const next = upsertAutoRunWidget(list, 'b', null)
    assert.deepStrictEqual(next.map(w => w.widgetId), ['a'])
  })
})
