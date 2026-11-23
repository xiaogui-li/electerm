/**
 * The state of the "SFTP follows the terminal path" toggle.
 *
 * @author xiaogui
 * @since 2026-11-23 11:35:20
 */
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../../client/common/sftp-follow-state.js')

describe('resolveSftpFollowState', () => {
  test('is off when the toggle is off', async () => {
    const { resolveSftpFollowState, sftpFollowStates } = await load()
    assert.equal(
      resolveSftpFollowState({ enabled: false, cwd: '' }),
      sftpFollowStates.off
    )
    // a reported directory does not turn the toggle on by itself
    assert.equal(
      resolveSftpFollowState({ enabled: false, cwd: '/tmp' }),
      sftpFollowStates.off
    )
  })

  test('is pending when the toggle is on but no directory arrived', async () => {
    const { resolveSftpFollowState, sftpFollowStates } = await load()
    assert.equal(
      resolveSftpFollowState({ enabled: true, cwd: '' }),
      sftpFollowStates.pending
    )
  })

  test('is on once the shell reported a directory', async () => {
    const { resolveSftpFollowState, sftpFollowStates } = await load()
    assert.equal(
      resolveSftpFollowState({ enabled: true, cwd: '/var/log' }),
      sftpFollowStates.on
    )
  })

  test('survives missing arguments', async () => {
    const { resolveSftpFollowState, sftpFollowStates } = await load()
    assert.equal(resolveSftpFollowState(), sftpFollowStates.off)
    assert.equal(resolveSftpFollowState({}), sftpFollowStates.off)
    assert.equal(
      resolveSftpFollowState({ enabled: true }),
      sftpFollowStates.pending
    )
  })
})
