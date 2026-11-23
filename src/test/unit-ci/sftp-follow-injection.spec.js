const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

global.window = global.window || { xtermAddons: {} }
global.window.xtermAddons = global.window.xtermAddons || {}
global.document = global.document || { hidden: true }

const ESC = String.fromCharCode(27)

const loadAttachAddon = () => import('../../client/components/terminal/attach-addon-custom.js')
const loadStartupQueue = () => import('../../client/components/terminal/startup-queue.js')

describe('shell integration sequence detection', () => {
  test('finds an OSC 633 sequence', async () => {
    const { default: AttachAddonCustom } = await loadAttachAddon()
    const addon = new AttachAddonCustom({}, {})
    const str = 'noise' + ESC + ']633;P;Cwd=/tmp' + '\x07'

    assert.equal(addon.indexOfShellIntegration(str), 5)
  })

  test('finds an OSC 1337 sequence too', async () => {
    const { default: AttachAddonCustom } = await loadAttachAddon()
    const addon = new AttachAddonCustom({}, {})
    const str = 'noise' + ESC + ']1337;CurrentDir=/tmp' + '\x07'

    assert.equal(addon.indexOfShellIntegration(str), 5)
  })

  test('returns the earliest sequence when both are present', async () => {
    const { default: AttachAddonCustom } = await loadAttachAddon()
    const addon = new AttachAddonCustom({}, {})
    const str = ESC + ']1337;CurrentDir=/a' + '\x07' + ESC + ']633;P;Cwd=/b' + '\x07'

    assert.equal(addon.indexOfShellIntegration(str), 0)
  })

  test('finds nothing in ordinary output', async () => {
    const { default: AttachAddonCustom } = await loadAttachAddon()
    const addon = new AttachAddonCustom({}, {})

    assert.equal(addon.indexOfShellIntegration('plain output'), -1)
  })
})

describe('a shell integration sequence split across two chunks', () => {
  test('the tail of a chunk is detected as an unfinished sequence', async () => {
    const { default: AttachAddonCustom } = await loadAttachAddon()
    const addon = new AttachAddonCustom({}, {})
    const str = 'prompt$' + ESC + ']633;P;Cwd=/ho'

    assert.equal(addon.findIncompleteSequenceStart(str), 7)
  })

  test('a finished sequence leaves nothing to carry over', async () => {
    const { default: AttachAddonCustom } = await loadAttachAddon()
    const addon = new AttachAddonCustom({}, {})
    const str = ESC + ']633;P;Cwd=/home\x07'

    assert.equal(addon.findIncompleteSequenceStart(str), -1)
  })

  test('a sequence terminated by ST leaves nothing to carry over', async () => {
    const { default: AttachAddonCustom } = await loadAttachAddon()
    const addon = new AttachAddonCustom({}, {})
    const str = ESC + ']633;P;Cwd=/home' + ESC + '\\'

    assert.equal(addon.findIncompleteSequenceStart(str), -1)
  })

  test('output without an escape sequence leaves nothing to carry over', async () => {
    const { default: AttachAddonCustom } = await loadAttachAddon()
    const addon = new AttachAddonCustom({}, {})

    assert.equal(addon.findIncompleteSequenceStart('plain output'), -1)
  })
})

const createAddon = (overrides = {}) => ({
  disposed: false,
  outputSuppressed: false,
  sent: [],
  _lineHasUnsubmittedInput: () => false,
  onInitialData: () => {},
  _sendData (data) {
    this.sent.push(data)
  },
  ...overrides
})

const createTerm = (addon, extra = {}) => ({
  attachAddon: addon,
  onClose: false,
  isSsh: () => true,
  isLocal: () => false,
  props: {
    tab: { type: 'ssh' },
    config: {
      showCmdSuggestions: false,
      restoreTerminalSessionOnReload: false
    },
    sftpPathFollowSsh: true
  },
  ...extra
})

describe('asking the shell for a fresh prompt after the injection', () => {
  test('sends one enter so the shell reports its directory', async () => {
    const { default: StartupQueue } = await loadStartupQueue()
    const addon = createAddon()
    const queue = new StartupQueue(createTerm(addon))

    queue.requestFreshPrompt(addon)

    assert.deepEqual(addon.sent, ['\r'])
  })

  test('does nothing while the output is still suppressed', async () => {
    const { default: StartupQueue } = await loadStartupQueue()
    const addon = createAddon({ outputSuppressed: true })
    const queue = new StartupQueue(createTerm(addon))

    queue.requestFreshPrompt(addon)

    assert.deepEqual(addon.sent, [])
  })

  test('does nothing when the line holds unsubmitted input', async () => {
    const { default: StartupQueue } = await loadStartupQueue()
    const addon = createAddon({ _lineHasUnsubmittedInput: () => true })
    const queue = new StartupQueue(createTerm(addon))

    queue.requestFreshPrompt(addon)

    assert.deepEqual(addon.sent, [])
  })

  test('does nothing when the session is closed', async () => {
    const { default: StartupQueue } = await loadStartupQueue()
    const addon = createAddon()
    const term = createTerm(addon)
    term.onClose = true
    const queue = new StartupQueue(term)

    queue.requestFreshPrompt(addon)

    assert.deepEqual(addon.sent, [])
  })

  test('does nothing when the addon belongs to another session', async () => {
    const { default: StartupQueue } = await loadStartupQueue()
    const addon = createAddon()
    const queue = new StartupQueue(createTerm(addon))

    queue.requestFreshPrompt(createAddon())

    assert.deepEqual(addon.sent, [])
  })
})

describe('the injection is marked as pending while it runs', () => {
  test('pending is set while the remote shell is being probed', async () => {
    const { default: StartupQueue } = await loadStartupQueue()
    const addon = createAddon()
    let resolveProbe
    const probe = new Promise(resolve => {
      resolveProbe = resolve
    })
    const queue = new StartupQueue(createTerm(addon), {
      detectRemoteShell: () => probe
    })

    assert.equal(queue.shellIntegrationPending, false)
    const running = queue.injectShellIntegration()
    assert.equal(queue.shellIntegrationPending, true)

    resolveProbe('')
    await running

    assert.equal(queue.shellIntegrationPending, false)
  })

  test('pending stays false when the shell is already integrated', async () => {
    const { default: StartupQueue } = await loadStartupQueue()
    const addon = createAddon()
    const queue = new StartupQueue(createTerm(addon))
    queue.shellInjected = true

    await queue.injectShellIntegration()

    assert.equal(queue.shellIntegrationPending, false)
  })

  test('pending is cleared when the shell can not be detected', async () => {
    const { default: StartupQueue } = await loadStartupQueue()
    const addon = createAddon()
    const queue = new StartupQueue(createTerm(addon), {
      detectRemoteShell: () => Promise.resolve('')
    })

    await queue.injectShellIntegration()

    assert.equal(queue.shellIntegrationPending, false)
  })
})
