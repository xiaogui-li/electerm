const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../../client/components/terminal/shell.js')
const loadTracker = () => import('../../client/components/terminal/command-tracker-addon.js')

// Issue #4610: telnet to a Huawei VRP switch. The remote `$SHELL` probe was
// answered with a CLI error banner, which was read as "some sh-compatible
// shell", so the PS1 integration script was typed into a device that cannot
// run `eval`. The device echoed it, the screen stayed frozen for the whole
// suppression window and the text ended up in the scrollback.
describe('remote shell probe parsing', () => {
  test('reads a normal shell path', async () => {
    const { parseRemoteShell } = await load()
    assert.equal(parseRemoteShell('/bin/bash\n'), 'bash')
    assert.equal(parseRemoteShell('/usr/local/bin/zsh'), 'zsh')
    assert.equal(parseRemoteShell('/usr/bin/fish\n'), 'fish')
    assert.equal(parseRemoteShell('/bin/dash\n'), 'sh')
  })

  test('is not fooled by an error banner or a prompt', async () => {
    const { parseRemoteShell } = await load()
    // Huawei VRP answers an unknown command like this
    assert.equal(parseRemoteShell('Error: Unrecognized command found at \'^\' position.\n'), '')
    assert.equal(parseRemoteShell('<HUAWEI>'), '')
    assert.equal(parseRemoteShell('% Invalid input detected\n'), '')
    // empty answer: $SHELL unset, or the command was swallowed
    assert.equal(parseRemoteShell(''), '')
    assert.equal(parseRemoteShell('   \r\n'), '')
    assert.equal(parseRemoteShell(undefined), '')
  })
})

describe('shell detection', () => {
  test('recognizes PowerShell, including a full path and pwsh', async () => {
    const { detectShellType } = await load()
    for (const shell of [
      'powershell',
      'powershell.exe',
      'pwsh',
      'pwsh.exe',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"'
    ]) {
      assert.equal(detectShellType(shell), 'powershell', shell)
    }
  })

  // cmd is detected only so that nothing is injected into it: it cannot run any
  // script we have, and the POSIX `sh` default used to be the wrong answer.
  test('detects cmd without falling back to sh', async () => {
    const { detectShellType, shellIntegrationTypes } = await load()
    assert.equal(detectShellType('System32/cmd.exe'), 'cmd')
    assert.equal(detectShellType('C:\\Windows\\System32\\cmd.exe'), 'cmd')
    assert.equal(shellIntegrationTypes.has('cmd'), false)
  })

  test('leaves the POSIX detection alone', async () => {
    const { detectShellType } = await load()
    assert.equal(detectShellType('/bin/bash'), 'bash')
    assert.equal(detectShellType('/bin/zsh'), 'zsh')
    assert.equal(detectShellType('/usr/bin/fish'), 'fish')
    assert.equal(detectShellType('/bin/dash'), 'sh')
    assert.equal(detectShellType(''), 'sh')
    assert.equal(detectShellType(undefined), 'sh')
  })
})

// #4737: PowerShell has no PROMPT_COMMAND, so the prompt function is wrapped.
// It is what tells the app the live cwd a ctrl+clicked relative path is
// resolved against. A Windows local pty gets the script as a spawn argument
// (see powershell-spawn-integration.spec.js); typing it is only left for `pwsh`
// used as a local shell on macOS/Linux.
describe('PowerShell shell integration', () => {
  test('is sent raw and reports the cwd from the prompt', async () => {
    const { getShellIntegrationCommand } = await load()
    const cmd = getShellIntegrationCommand('powershell')
    // `eval '...'` is bash syntax, not PowerShell
    assert.equal(cmd.includes("eval '"), false)
    assert.equal(cmd.endsWith('\r'), true)
    assert.match(cmd, /ELECTERM_SHELL_INTEGRATION/)
    assert.match(cmd, /633;P;Cwd=/)
    assert.match(cmd, /633;A/)
    // the path is escaped the way OSC 633 expects (`\` -> `\\`, `;` -> `\x3b`)
    assert.ok(cmd.includes(String.raw`.Replace('\','\\')`), 'doubles the backslashes')
    assert.ok(cmd.includes(String.raw`.Replace(';','\x3b')`), 'escapes the semicolons')
    // and the user's own prompt still has to be drawn, before anything is
    // written: oh-my-posh reads `$?` first, and [Console]::Write resets it
    assert.ok(
      cmd.includes('$x=if($global:__e_prompt){& $global:__e_prompt}else{'),
      'calls the original prompt first'
    )
    // the same string travels as one command line argument to powershell.exe
    assert.equal(cmd.includes('"'), false, 'no double quotes')
  })
})

describe('OSC 633 value unescaping', () => {
  const deserialize = async (value) => {
    const { CommandTrackerAddon } = await loadTracker()
    return new CommandTrackerAddon()._deserializeOscValue(value)
  }

  test('collapses escaped backslashes', async () => {
    assert.equal(await deserialize('D:\\\\work\\\\project'), 'D:\\work\\project')
  })

  test('decodes escaped semicolons', async () => {
    assert.equal(await deserialize('E:\\\\a\\x3bb'), 'E:\\a;b')
  })

  // A Windows path may contain the characters `\x` followed by hex digits. The
  // old two-pass version decoded `\x..` *before* collapsing `\\`, so `D:\\x86`
  // came back as `D:V`: every path with a directory starting with `x`+hex broke.
  test('does not read a real backslash as the start of an escape', async () => {
    assert.equal(await deserialize('D:\\\\x86\\\\build'), 'D:\\x86\\build')
    assert.equal(await deserialize('C:\\\\x41bc'), 'C:\\x41bc')
  })

  test('keeps a lone backslash and unknown escapes as they are', async () => {
    assert.equal(await deserialize('C:\\work\\z'), 'C:\\work\\z')
    assert.equal(await deserialize('a\\qb'), 'a\\qb')
    assert.equal(await deserialize(''), '')
  })

  test('round-trips a path containing a semicolon', async () => {
    const { CommandTrackerAddon } = await loadTracker()
    const path = 'D:\\work;x\\[a]\\b'
    const escaped = path.replace(/\\/g, '\\\\').replace(/;/g, '\\x3b')
    assert.equal(new CommandTrackerAddon()._deserializeOscValue(escaped), path)
  })
})

// OSC 1337 is iTerm2's own protocol. Its CurrentDir key carries the working
// directory, so a host that already reports it (a profile copied from iTerm2,
// or any tool following the iTerm2 convention) drives the SFTP follow feature
// on its own - electerm does not have to inject anything for it.
//
// @author xiaogui
// @since 2026-11-23 11:36:40
describe('OSC 1337 CurrentDir', () => {
  const feed = async (data) => {
    const { CommandTrackerAddon } = await loadTracker()
    const addon = new CommandTrackerAddon()
    const seen = []
    addon.onCwdChanged(cwd => seen.push(cwd))
    const handled = addon._handleOsc1337(data)
    return { addon, seen, handled }
  }

  test('reads the directory out of the iTerm2 payload', async () => {
    const { addon, seen, handled } = await feed('CurrentDir=/tmp/work')
    assert.equal(handled, true)
    assert.equal(addon.getCwd(), '/tmp/work')
    assert.deepEqual(seen, ['/tmp/work'])
  })

  test('ignores the other iTerm2 keys', async () => {
    const { addon } = await feed('CurrentDir=/tmp;ShellIntegrationVersion=1')
    assert.equal(addon.getCwd(), '/tmp')
  })

  // iTerm2 sends the path raw, unlike the OSC 633 value which the shell side
  // escapes - so a backslash has to survive as a backslash.
  test('keeps the path raw, unlike the escaped OSC 633 value', async () => {
    const { addon } = await feed('CurrentDir=D:\\x86\\build')
    assert.equal(addon.getCwd(), 'D:\\x86\\build')
  })

  test('does nothing without a CurrentDir key', async () => {
    const { addon, seen, handled } = await feed('ShellIntegrationVersion=1')
    assert.equal(handled, false)
    assert.equal(addon.getCwd(), '')
    assert.deepEqual(seen, [])
  })
})

// A server profile that exports PROMPT_COMMAND passes it down to every nested
// shell, but shell functions are never inherited - so the nested shell would
// run a PROMPT_COMMAND calling `__e_cmd`, which it does not have: "command
// not found" before every prompt, and no OSC 633 at all, so the SFTP follow
// silently stops there. Exporting the functions keeps it working.
//
// @author xiaogui
// @since 2026-11-23 11:37:25
describe('bash shell integration', () => {
  test('exports the functions so nested shells inherit them', async () => {
    const { getInlineShellIntegration } = await load()
    const cmd = getInlineShellIntegration('bash')
    assert.ok(
      cmd.includes('export -f __e_esc __e_pre __e_cmd'),
      'exports the functions'
    )
    assert.ok(
      cmd.indexOf('__e_cmd() {') < cmd.indexOf('export -f'),
      'defines them before exporting them'
    )
  })

  test('the exported functions survive the one-liner joining', async () => {
    const { getShellIntegrationCommand } = await load()
    const cmd = getShellIntegrationCommand('bash')
    assert.ok(cmd.includes('export -f __e_esc __e_pre __e_cmd'))
    assert.ok(cmd.endsWith('\r'))
  })
})
