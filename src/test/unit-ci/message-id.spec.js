const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const loadMessageId = () => import('../../client/common/message-id.js')

describe('the id a message is filed under', () => {
  test('the config key wins', async () => {
    const { resolveMessageId } = await loadMessageId()

    assert.equal(resolveMessageId({ key: 'from-config' }, 'from-element'), 'from-config')
  })

  test('the element key is used when there is no config key', async () => {
    const { resolveMessageId } = await loadMessageId()

    assert.equal(resolveMessageId({}, 'from-element'), 'from-element')
  })

  test('a message without any key has none', async () => {
    const { resolveMessageId } = await loadMessageId()

    assert.equal(resolveMessageId({}, null), null)
  })
})
