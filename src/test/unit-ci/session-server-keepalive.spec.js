const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// The server half of the session keepalive. session-server.js pulls in
// electron and ssh2, so it can not be imported here - the wake sequence is
// pinned on the source instead.
const ROOT = path.join(__dirname, '..', '..', '..')
const src = fs.readFileSync(
  path.join(ROOT, 'src/app/server/session-server.js'),
  'utf8'
)

describe('session keepalive wake sequence', () => {
  test('the heartbeat writes a single newline to the pty', () => {
    const matched = src.match(/const wake = '([^']*)'/)
    assert.ok(matched, 'the wake sequence must be defined')
    // '\n' - and nothing else.
    assert.equal(matched[1], '\\n')
  })

  test('the heartbeat does not write a carriage return', () => {
    // A CR is a second line terminator under ICRNL, so one heartbeat made
    // bash accept two empty lines and redraw the prompt twice.
    const matched = src.match(/const wake = '([^']*)'/)
    assert.ok(!matched[1].includes('\\r'), 'no carriage return')
  })

  test('the heartbeat does not write an erase sequence', () => {
    // 'ESC [ K' stays in the tty input buffer - only a newline ends a
    // canonical line - and was delivered to readline as part of the next
    // command line, where it rang the unbound-key bell.
    const matched = src.match(/const wake = '([^']*)'/)
    assert.ok(!matched[1].includes('\\x1b'), 'no escape sequence')
  })
})
