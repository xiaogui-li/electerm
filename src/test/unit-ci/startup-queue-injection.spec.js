const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

global.window = {
  et: { isWin: true, isMac: false },
  store: { triggerResize: () => {} },
  initFolder: ''
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

const loadQueue = () => import('../../client/components/terminal/startup-queue.js')

// A stub of the attach addon with the three pieces the injection uses: the
// idleness clock (`getLastOutputTime`, updated even while output is hidden),
// the suppression switch, and the data channel. `feed()` simulates the shell
// writing something.
let addonSeq = 0
const makeAddon = () => {
  addonSeq++
  const addon = {
    id: addonSeq,
    disposed: false,
    outputSuppressed: false,
    lastOutput: Date.now(),
    // The real addon raises this on the first chunk it receives. The queue
    // reads it to tell "the shell already said something" from "the shell
    // has not said anything yet".
    hasReceivedInitialData: false,
    sent: [],
    stoppedWith: [],
    onEnd: null,
    getLastOutputTime: () => addon.lastOutput,
    feed: () => {
      addon.lastOutput = Date.now()
      addon.hasReceivedInitialData = true
    },
    _sendData: data => addon.sent.push(data),
    onInitialData: cb => setTimeout(cb, 0),
    startOutputSuppression: (timeout, onEnd, discardOnTimeout) => {
      addon.outputSuppressed = true
      addon.onEnd = onEnd
      addon.discardOnTimeout = discardOnTimeout
      addon.timeout = timeout
    },
    stopOutputSuppression: (discard = true) => {
      if (!addon.outputSuppressed) {
        return
      }
      addon.outputSuppressed = false
      addon.stoppedWith.push(discard)
      const cb = addon.onEnd
      addon.onEnd = null
      cb?.()
    },
    waitForOutputIdle: () => Promise.resolve(true)
  }
  return addon
}

const makeQueue = async (
  addon,
  { setup, remote = false, localStart = '', detectRemoteShell = () => Promise.resolve('bash'), onInjectionFailed } = {}
) => {
  const { StartupQueue } = await loadQueue()
  const host = {
    attachAddon: addon,
    localShell: 'powershell.exe',
    props: {
      tab: remote
        ? { type: 'ssh' }
        : { type: 'local', startDirectoryLocal: localStart },
      // A remote probe needs something to ask for the integration.
      config: { execWindows: 'powershell.exe', showCmdSuggestions: remote }
    },
    isLocal: () => !remote,
    isSsh: () => remote
  }
  const queue = new StartupQueue(host, {
    detectRemoteShell,
    onInjectionFailed
  })
  if (setup) {
    setup(queue)
  }
  queue.runInitScript('powershell.exe')
  return queue
}

// #4737: on Windows local PowerShell the integration is a spawn argument
// (`-NoExit -Command <script>`, see powershell-spawn-integration.spec.js), so
// the queue has nothing to type - the typed form is what used to end up on
// screen. What it still owns is the *wait*: nothing queued behind it may be
// typed into a shell that is still booting.
describe('local PowerShell startup', () => {
  test('never types the script, and opens no suppression window', async () => {
    const addon = makeAddon()
    const queue = await makeQueue(addon)
    await tick(50)
    addon.feed()
    await tick(queue.promptReadyQuietMs + 250)
    assert.deepEqual(addon.sent, [], 'the pty was spawned with the integration')
    assert.deepEqual(addon.stoppedWith, [], 'nothing to hide, so nothing was hidden')
    assert.equal(queue.shellInjected, true, 'the shell reports its cwd by itself')
    queue.dispose()
  })

  test('holds the start directory command until the shell has a prompt', async () => {
    const addon = makeAddon()
    const queue = await makeQueue(addon, { localStart: 'D:\\work' })
    await tick(50)
    assert.deepEqual(addon.sent, [], 'no keystroke into a shell that is still booting')

    // conpty's own init sequences are not a prompt: they arrive before it.
    addon.feed()
    await tick(100)
    assert.deepEqual(addon.sent, [], 'the pty talking is not the shell listening')

    // ... the prompt, and then silence.
    addon.feed()
    await tick(queue.promptReadyQuietMs + 250)
    assert.deepEqual(addon.sent, ["Set-Location -LiteralPath 'D:\\work'\r"])
    queue.dispose()
  })

  test('never types the script into a shell that never settles', async () => {
    const addon = makeAddon()
    const queue = await makeQueue(addon, {
      localStart: 'D:\\work',
      setup: q => {
        q.promptReadyTimeoutMs = 300
        q.promptReadyQuietMs = 100
      }
    })
    // A shell that never stops talking (a flooding MOTD, a loop in a profile).
    const flood = setInterval(() => addon.feed(), 50)
    await tick(700)
    clearInterval(flood)
    // The start directory is still sent - it is one short line, and dropping it
    // would lose a session restore - but nothing of the injection itself.
    assert.deepEqual(
      addon.sent.filter(data => /ELECTERM_SHELL_INTEGRATION/.test(data)),
      []
    )
    queue.dispose()
  })

  // A reconnect spawns a fresh pty, so "already injected" belongs to the old
  // one: the new shell has to be waited for again, or the start directory is
  // typed into a booting console.
  test('starts over on a new connection', async () => {
    const addon = makeAddon()
    const queue = await makeQueue(addon, { localStart: 'D:\\work' })
    await tick(50)
    addon.feed()
    await tick(queue.promptReadyQuietMs + 250)
    assert.equal(addon.sent.length, 1)

    addon.sent.length = 0
    queue.shellInjected = true
    queue.runInitScript('powershell.exe')
    await tick(50)
    assert.deepEqual(addon.sent, [], 'the new pty is waited for as well')

    addon.feed()
    await tick(queue.promptReadyQuietMs + 250)
    assert.equal(addon.sent.length, 1)
    queue.dispose()
  })
})

// A remote shell can not be spawned by us, so the script is still typed there -
// and the window that hides its echo still has to behave: nothing before the
// prompt, and on giving up the buffered echo is discarded, never flushed.
describe('remote shell integration window', () => {
  test('types nothing until the shell has drawn a prompt', async () => {
    const addon = makeAddon()
    const queue = await makeQueue(addon, { remote: true })
    await tick(50)
    assert.deepEqual(addon.sent, [], 'no keystroke into a shell that is still booting')
    assert.equal(addon.outputSuppressed, false, 'nothing to hide yet, so nothing is hidden')

    // The login banner is not the prompt.
    addon.feed()
    await tick(200)
    assert.deepEqual(addon.sent, [], 'a trickling banner is not a prompt')

    // ... the prompt, and then a quiet long enough for a network round trip.
    addon.feed()
    await tick(1500 + 300)
    assert.equal(addon.sent.length, 1, 'the script is typed at the prompt')
    assert.match(addon.sent[0], /ELECTERM_SHELL_INTEGRATION/)
    assert.equal(addon.outputSuppressed, true, 'and hidden while it echoes')
    queue.dispose()
  })

  test('skips the injection when the shell never settles', async () => {
    const addon = makeAddon()
    const queue = await makeQueue(addon, {
      remote: true,
      setup: q => {
        q.promptReadyTimeoutMs = 300
        q.promptReadyQuietMs = 100
      }
    })
    const flood = setInterval(() => addon.feed(), 50)
    await tick(700)
    clearInterval(flood)
    assert.deepEqual(addon.sent, [], 'never typed into a shell that never settles')
    assert.equal(queue.shellInjected, false)
    assert.deepEqual(addon.stoppedWith, [], 'no window was ever opened')
    queue.dispose()
  })

  test('keeps hiding while the shell is silent, and never flushes the echo', async () => {
    const addon = makeAddon()
    const queue = await makeQueue(addon, { remote: true })
    await tick(40)
    addon.feed()
    await tick(1500 + 300)
    assert.equal(addon.sent.length, 1)

    // The echo arrives but the prompt never confirms OSC 633 (a profile that
    // replaced `prompt` afterwards), so the window must end without writing
    // anything back to the screen.
    addon.feed()
    await tick(2700)
    assert.equal(addon.outputSuppressed, false, 'gave up on a silent shell')
    assert.deepEqual(addon.stoppedWith, [true], 'buffered echo is discarded, not flushed')
    assert.equal(queue.shellInjected, false, 'no confirmation, so not marked as injected')
    queue.dispose()
  })
})

// The shell often draws its prompt in the very first chunk and then stays
// quiet until the user types something. The wait used to demand a *second*
// chunk after it had begun, so those sessions never became "ready": the wait
// ran into its ceiling and the injection was skipped for good. The session
// stayed a plain terminal until the user clicked the paperclip, which is
// what "it only injects after a while" felt like.
describe('a shell whose first screen is already complete', () => {
  test('injects once that screen went quiet', async () => {
    const addon = makeAddon()
    const queue = await makeQueue(addon, { remote: true })

    // The whole first screen in one chunk, and then silence.
    addon.feed()
    await tick(1500 + 400)

    assert.equal(addon.sent.length, 1, 'the script is typed at the prompt')
    assert.match(addon.sent[0], /ELECTERM_SHELL_INTEGRATION/)
    queue.dispose()
  })
})

// A remote login draws its banner and its prompt in one go and then stays
// quiet for good, so the remote wait has to accept the output that arrived
// *before* it started - otherwise such a session never becomes ready, the wait
// runs into its ceiling and the injection is skipped for good.
//
// A local pty must not: its first bytes are conpty's own init sequences,
// printed before any prompt exists, and counting them would type the script
// into a booting console (#4737).
describe('which output counts as the shell speaking', () => {
  test('a local shell does not count the output from before the wait', async () => {
    const { StartupQueue } = await loadQueue()
    const addon = makeAddon()
    // conpty's init sequences, printed before any prompt exists.
    addon.feed()
    const queue = new StartupQueue({
      attachAddon: addon,
      onClose: false,
      props: { tab: { type: 'local' } },
      isLocal: () => true,
      isSsh: () => false
    })
    queue.promptReadyTimeoutMs = 300
    const ready = await queue.waitForFirstPrompt(addon, {
      quietMs: 100,
      allowPreExistingOutput: false
    })
    assert.equal(ready, false, 'the init bytes are not a prompt')
    queue.dispose()
  })

  test('a remote shell counts the output from before the wait', async () => {
    const { StartupQueue } = await loadQueue()
    const addon = makeAddon()
    // The banner and the prompt, in one chunk.
    addon.feed()
    const queue = new StartupQueue({
      attachAddon: addon,
      onClose: false,
      props: { tab: { type: 'ssh' } },
      isLocal: () => false,
      isSsh: () => true
    })
    const ready = await queue.waitForFirstPrompt(addon, {
      quietMs: 100,
      allowPreExistingOutput: true
    })
    assert.equal(ready, true, 'the screen the shell drew is a prompt')
    queue.dispose()
  })

  test('the local session does not use the remote shortcut', async () => {
    const addon = makeAddon()
    const calls = []
    const queue = await makeQueue(addon, {
      localStart: 'D:\\work',
      setup: q => {
        q.waitForFirstPrompt = (a, opts) => {
          calls.push(opts)
          return Promise.resolve(true)
        }
      }
    })
    await tick(50)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].allowPreExistingOutput, false)
    queue.dispose()
  })

  test('the remote session does use it', async () => {
    const addon = makeAddon()
    const calls = []
    const queue = await makeQueue(addon, {
      remote: true,
      setup: q => {
        q.waitForFirstPrompt = (a, opts) => {
          calls.push(opts)
          return Promise.resolve(true)
        }
      }
    })
    await tick(50)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].allowPreExistingOutput, true)
    queue.dispose()
  })
})

// The probe opens a second channel on the ssh connection. A connection that
// was just established often needs a moment before the server accepts it,
// and the probe then times out - which used to end the injection, silently,
// with nothing on screen to show for it.
//
// A probe that *answers* (with a shell, or with nothing shell-like) is a
// different thing: the device answered, and asking again would only make
// the session wait longer for an outcome that will not change.
describe('the remote shell probe', () => {
  test('is tried again when the channel was not ready yet', async () => {
    const addon = makeAddon()
    let attempts = 0
    const queue = await makeQueue(addon, {
      remote: true,
      setup: q => {
        // The channel is not ready: the probe runs into its ceiling.
        q.remoteShellDetectTimeoutMs = 300
        q.remoteShellDetectRetryDelayMs = 50
      },
      detectRemoteShell: () => {
        attempts++
        // The first attempt never answers - the channel is still opening.
        if (attempts === 1) {
          return new Promise(() => {})
        }
        return Promise.resolve('bash')
      }
    })

    addon.feed()
    await tick(1500 + 1200)

    assert.equal(attempts, 2, 'the probe was tried again')
    assert.equal(addon.sent.length, 1, 'and the script was injected after all')
    queue.dispose()
  })

  test('is not asked again when the device answered', async () => {
    const addon = makeAddon()
    let attempts = 0
    const queue = await makeQueue(addon, {
      remote: true,
      setup: q => {
        q.remoteShellDetectTimeoutMs = 300
        q.remoteShellDetectRetryDelayMs = 50
      },
      detectRemoteShell: () => {
        attempts++
        return Promise.resolve('')
      }
    })

    addon.feed()
    await tick(1500 + 1200)

    assert.equal(attempts, 1, 'an answer is an answer')
    assert.deepEqual(addon.sent, [], 'nothing was typed into an unknown shell')
    queue.dispose()
  })

  test('reports the failure when the shell stays unknown', async () => {
    const addon = makeAddon()
    const failures = []
    const queue = await makeQueue(addon, {
      remote: true,
      setup: q => {
        q.remoteShellDetectTimeoutMs = 300
        q.remoteShellDetectRetryDelayMs = 50
      },
      detectRemoteShell: () => Promise.resolve(''),
      onInjectionFailed: reason => failures.push(reason)
    })

    addon.feed()
    await tick(1500 + 1200)

    assert.deepEqual(failures, ['probe'])
    assert.deepEqual(addon.sent, [], 'nothing was typed into an unknown shell')
    queue.dispose()
  })
})

// A poll that outlives its queue keeps spinning on the event loop and steals
// time from everything else - and the next session then waits longer than it
// has to. The queue therefore has to take its polling timers down with it.
describe('a queue that is disposed', () => {
  test('leaves no polling timer behind', async () => {
    const addon = makeAddon()
    const queue = await makeQueue(addon, { remote: true })

    await tick(50)
    assert.ok(queue.intervals.size > 0, 'the wait for the prompt is polling')

    queue.dispose()

    assert.equal(queue.intervals.size, 0, 'the poll was taken down')
  })
})
