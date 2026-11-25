/**
 * Startup queue for a terminal session.
 *
 * Everything that has to be typed into a freshly connected shell goes through
 * here, strictly one item at a time:
 *
 *   shell integration injection  ->  cd/startDirectory  ->  runScripts
 *
 * Two rules keep it reliable:
 *
 * 1. Only one drain loop owns the queue at a time, and every queue generation
 *    carries a token. A reconnect (or a config toggle that rebuilds the queue)
 *    bumps the token, so a loop still waiting on the *old* connection stops
 *    instead of stealing items from the new queue - that used to silently drop
 *    the remaining run scripts.
 * 2. After each script we wait for the shell to settle (a fresh prompt, or a
 *    quiet period) before typing the next one, so nothing is ever typed into a
 *    shell that is still busy. Every wait is bounded, so a hung shell can only
 *    delay the queue, never stop it.
 */
import {
  getShellIntegrationCommand,
  detectShellType,
  shellIntegrationTypes
} from './shell.js'
import {
  createRestoreCwdCommand,
  createWindowsRestoreCwdCommand,
  isPowerShellExecutable,
  isRestorableTerminalTab
} from './ssh-reload-state.js'
import { getPowerShellSpawnArgs } from '../../common/powershell-integration.js'
import { isMac, isWin } from '../../common/platform.js'

// Pacing: `settleIdleMs` of silence counts as "the shell is done",
// `settleTimeoutMs` caps the wait so a script that never returns can not
// stall the queue.
const settleIdleMs = 400
const settleTimeoutMs = 3000
// Ceiling for the best-effort remote shell probe. detectRemoteShell opens an
// extra exec channel and runCmd has no timeout of its own, so a server that
// never answers would otherwise block the whole queue forever.
//
// The ceiling has to sit well above the time the *server* is willing to wait
// for that channel (15s, see session-common.js): a connection that was just
// established often needs a couple of seconds before the sshd accepts a
// second channel, and a ceiling below that turned the probe into a coin
// toss. An empty answer then ended the injection - silently, with nothing
// on screen to show for it - and the session stayed a plain terminal until
// the user clicked the paperclip, which is what "it only injects after a
// while" felt like.
const remoteShellDetectTimeoutMs = 6000
// A probe that came back empty is usually a channel that was not ready yet,
// not a device that can not run a shell. One more attempt a moment later
// recovers the sessions that would otherwise never get the integration.
const remoteShellDetectRetryDelayMs = 600
const remoteShellDetectMaxAttempts = 2
// How often the wait for the shell's first prompt is tried before the
// injection is given up on.
const promptReadyMaxAttempts = 2
// Shell integration injection window. `injectionQuietMs` of silence from the
// shell without an OSC 633 confirmation means the prompt will not report its
// cwd, and `injectionMaxWaitMs` is the ceiling for a shell that never answers
// at all; both are measured from the shell's own output, never from the clock
// at send time (see injectShellIntegration).
const injectionQuietMs = 1500
const injectionMaxWaitMs = 10000
// How long a shell is given to draw its first prompt before injection is
// skipped. Typing earlier is what put the script on screen (#4737): the
// console holds the keystrokes until the line editor starts, which can be
// seconds later and long after the suppression window has closed.
const promptReadyQuietMs = 400
const promptReadyTimeoutMs = 8000

export class StartupQueue {
  /**
   * @param {object} term - the terminal component (host)
   * @param {object} [deps] - `detectRemoteShell` needs the network, so it is
   *   injected: it keeps this module free of the app runtime and makes the
   *   queue testable on its own.
   */
  constructor (term, deps = {}) {
    this.term = term
    this.detectRemoteShell = deps.detectRemoteShell || (() => Promise.resolve('sh'))
    // Told when the injection did not happen at all, so the host can say
    // so instead of leaving a grey icon behind. See injectShellIntegration.
    this.onInjectionFailed = deps.onInjectionFailed
    this.queue = []
    this.token = 0
    this.running = false
    this.shellInjected = false
    this.shellType = null
    // True while an injection is in flight; see injectShellIntegration.
    this.shellIntegrationPending = false
    // Why the last injection attempt did not happen ('' = it did). See
    // injectShellIntegration.
    this.shellInjectionError = ''
    this.timers = new Set()
    // The polling intervals are kept apart from the timeouts: they need
    // clearInterval, and a queue that was disposed must not keep a timer
    // running - a poll that outlives its queue spins on the event loop and
    // steals time from everything else.
    this.intervals = new Set()
    // Timings of the "is the shell listening yet?" wait (see
    // waitForFirstPrompt). Instance fields so a test can shorten them.
    this.promptReadyQuietMs = promptReadyQuietMs
    this.promptReadyTimeoutMs = promptReadyTimeoutMs
    // Timings of the remote shell probe (see detectRemoteShellType).
    this.remoteShellDetectTimeoutMs = remoteShellDetectTimeoutMs
    this.remoteShellDetectRetryDelayMs = remoteShellDetectRetryDelayMs
  }

  dispose = () => {
    for (const t of this.timers) {
      clearTimeout(t)
    }
    this.timers.clear()
    for (const i of this.intervals) {
      clearInterval(i)
    }
    this.intervals.clear()
    this.queue = []
    this.running = false
  }

  // ---- host accessors ----

  get addon () {
    return this.term.attachAddon
  }

  get cmdAddon () {
    return this.term.cmdAddon
  }

  isClosed = () => {
    return !!this.term.onClose
  }

  isSsh = () => {
    return this.term.isSsh ? this.term.isSsh() : this.getTabType() === 'ssh'
  }

  isLocal = () => {
    return this.term.isLocal ? this.term.isLocal() : this.getTabType() === 'local'
  }

  getTabType = () => {
    return this.term.props?.tab?.type
  }

  isTelnet = () => {
    if (this.term.isTelnet) {
      return this.term.isTelnet()
    }
    return this.getTabType() === 'telnet'
  }

  isSerial = () => {
    if (this.term.isSerial) {
      return this.term.isSerial()
    }
    return this.getTabType() === 'serial'
  }

  isRemoteShell = () => {
    return this.isSsh() || this.isTelnet() || this.isSerial()
  }

  isRestorable = () => {
    const tab = this.term.props?.tab || {}
    if (typeof this.term.isShellTerminal === 'function') {
      return this.term.isShellTerminal()
    }
    return isRestorableTerminalTab(tab)
  }

  /**
   * Wait for output followed by `quietMs` of silence. An SSH prompt may have
   * arrived before shell detection finished or SFTP follow was enabled.
   *
   * Both halves matter. Silence alone is not "ready" - a shell that is still
   * booting (profile loading, conpty starting OpenConsole) is silent too, and
   * typing into it does not echo immediately: the console buffers the
   * keystrokes and the line editor draws them whenever it finally starts, which
   * can be seconds later, long after the suppression window closed. That is how
   * the injected script still ended up on screen (#4737). Output alone is not
   * ready either - the first bytes a pty sends are conpty's own init sequences,
   * printed before any prompt exists.
   *
   * Output that arrived *before* the wait started counts as well - but only
   * where that is safe. A remote login draws its banner and its prompt in
   * one go, and then goes quiet for good: demanding another chunk after the
   * wait began meant that such a session never became ready, the wait ran
   * into its ceiling and the injection was skipped for good. Nothing would
   * have woken the shell up either - it stays quiet until the user types
   * something.
   *
   * A *local* shell must not use that shortcut: the first bytes a pty
   * sends are conpty's own init sequences, printed before any prompt
   * exists, so they say nothing about the shell being ready to be typed
   * into. There the first chunk is only the start of the wait, and the
   * prompt has to arrive as a chunk of its own.
   *
   * Returns false when the terminal went away or the shell never settled, in
   * which case the caller must not type anything at all.
   */
  waitForFirstPrompt = (addon, { quietMs = this.promptReadyQuietMs, timeoutMs = this.promptReadyTimeoutMs, allowPreExistingOutput = false } = {}) => {
    if (this.isClosed() || !addon || addon.disposed) {
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      const startedAt = Date.now()
      let last = addon.getLastOutputTime ? addon.getLastOutputTime() : startedAt
      let sawOutput = allowPreExistingOutput && !!addon.hasReceivedInitialData
      let done = false
      const finish = (result) => {
        if (done) {
          return
        }
        done = true
        clearInterval(pollTimer)
        this.intervals.delete(pollTimer)
        resolve(result)
      }
      const pollTimer = setInterval(() => {
        if (this.isClosed() || this.addon !== addon || addon.disposed) {
          return finish(false)
        }
        const now = Date.now()
        const seen = addon.getLastOutputTime ? addon.getLastOutputTime() : now
        if (seen > last) {
          last = seen
          sawOutput = true
        }
        if (sawOutput && now - last >= quietMs) {
          return finish(true)
        }
        if (now - startedAt >= timeoutMs) {
          finish(false)
        }
      }, 100)
      this.intervals.add(pollTimer)
    })
  }

  /**
   * Wait for the shell's first prompt, and try again when it did not settle.
   *
   * The first attempt can lose the race against a shell that was still
   * drawing its first screen: the wait gave up while the prompt was on its
   * way, and the injection was skipped. One more attempt costs a couple of
   * seconds and turns that session into a working one.
   *
   * @author xiaogui
   * @since 2026-11-23 15:08:36
   * @param {object} addon - The attach addon of this session
   * @returns {Promise<boolean>} true when the shell has a prompt
   */
  waitForShellPrompt = async (addon) => {
    for (let attempt = 0; attempt < promptReadyMaxAttempts; attempt++) {
      // The shell has to have said *something* before "it is quiet" means
      // anything: a shell that is still booting is silent too, and a script
      // typed into it does not echo until the console finally starts. So the
      // first output is a gate of its own, and only after it arrived does the
      // silence below carry any meaning.
      const spoke = await this.waitForInitialOutput(addon)
      if (!spoke) {
        return false
      }
      // The remote case has to accept the output that arrived *before* this
      // wait started: a remote login draws its banner and its prompt in one
      // go and then stays quiet for good, so demanding a fresh chunk meant
      // that such a session never became ready and the injection was skipped
      // for good. A local shell must not - its first bytes are conpty's init
      // sequences, printed before any prompt exists, and treating them as
      // "the shell spoke" would type the script into a booting console
      // (#4737).
      const remote = this.isRemoteShell()
      const ready = await this.waitForFirstPrompt(addon, {
        quietMs: remote ? 1500 : this.promptReadyQuietMs,
        allowPreExistingOutput: remote
      })
      if (ready) {
        return true
      }
      if (this.isClosed() || this.addon !== addon || addon.disposed) {
        return false
      }
    }
    return false
  }

  /**
   * Wait until the shell has produced its first output.
   *
   * Resolves false when the session went away instead of hanging forever.
   *
   * @author xiaogui
   * @since 2026-11-23 15:33:12
   * @param {object} addon - The attach addon of this session
   * @returns {Promise<boolean>} true when the shell said something
   */
  waitForInitialOutput = (addon) => {
    if (this.isClosed() || !addon || addon.disposed) {
      return Promise.resolve(false)
    }
    // The addon knows whether it already received data: the first chunk may
    // have arrived before this wait was even started.
    if (addon.hasReceivedInitialData) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      let done = false
      const finish = (result) => {
        if (done) {
          return
        }
        done = true
        clearTimeout(timer)
        this.timers.delete(timer)
        resolve(result)
      }
      const timer = setTimeout(() => finish(false), this.promptReadyTimeoutMs)
      this.timers.add(timer)
      addon.onInitialData(() => finish(true))
    })
  }

  /**
   * Find out which shell the far side runs.
   *
   * The probe opens a second channel on the ssh connection, and a connection
   * that was just established often needs a moment before the server accepts
   * it. An empty answer therefore does not mean "there is no shell here" - it
   * means the channel was not ready yet, and giving up on the first empty
   * answer skipped the injection for good.
   *
   * @author xiaogui
   * @since 2026-11-23 15:09:48
   * @returns {Promise<string>} the shell type, or '' when it stays unknown
   */
  detectRemoteShellType = async () => {
    for (let attempt = 0; attempt < remoteShellDetectMaxAttempts; attempt++) {
      if (attempt > 0) {
        await this.sleep(this.remoteShellDetectRetryDelayMs)
        if (this.isClosed()) {
          return ''
        }
      }
      let timer = null
      let timedOut = false
      const shellType = await Promise.race([
        this.detectRemoteShell(this.term.pid),
        new Promise(resolve => {
          timer = setTimeout(() => {
            timedOut = true
            resolve('')
          }, this.remoteShellDetectTimeoutMs)
          this.timers.add(timer)
        })
      ])
      clearTimeout(timer)
      this.timers.delete(timer)
      if (shellType) {
        return shellType
      }
      if (!timedOut) {
        // The probe answered - it just did not name a shell. That is an
        // answer, not a broken channel: a device that refuses the exec
        // channel has no shell to integrate. Retrying would only make the
        // session wait longer for an outcome that will not change.
        return ''
      }
    }
    return ''
  }

  /**
   * The executable and arguments this local tab was spawned with.
   *
   * Mirrors the `execOpts` branch in term-socket.js: a bookmark-level value
   * wins over the global setting, and the arguments come from the same level as
   * the executable. The server receives exactly these, so asking the same
   * question here gives the same answer it did.
   *
   * @returns {{shell: string, args: string[]}}
   */
  getLocalExec = () => {
    const { config, tab = {} } = this.term.props
    const prop = isWin ? 'execWindows' : isMac ? 'execMac' : 'execLinux'
    const args = (tab[prop] ? tab[`${prop}Args`] : config[`${prop}Args`]) || []
    return {
      // `localShell` is what the session actually spawned, when the host knows
      shell: this.term.localShell || tab[prop] || config[prop] || '',
      args
    }
  }

  /**
   * The shell a *local* tab actually spawned: the bookmark's (profile-applied)
   * executable first, then the global setting.
   */
  getLocalShellType = () => detectShellType(this.getLocalExec().shell)

  /**
   * Did the pty already load the shell integration as a spawn argument?
   * See common/powershell-integration.js.
   */
  isSpawnInjectedShell = (shellType) => {
    if (!this.isLocal() || shellType !== 'powershell') {
      return false
    }
    const { shell, args } = this.getLocalExec()
    return getPowerShellSpawnArgs(shell, args) !== null
  }

  sleep = (ms) => {
    if (ms <= 0) {
      return Promise.resolve()
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        resolve()
      }, ms)
      this.timers.add(timer)
    })
  }

  // ---- queue ----

  runInitScript = (localShell) => {
    const { term } = this
    window.store.triggerResize()
    const {
      startDirectory,
      startDirectoryLocal,
      runScripts
    } = term.props.tab

    const scripts = runScripts ? [...runScripts] : []
    const reloadCwd = term.props.config.restoreTerminalSessionOnReload && this.isRestorable()
      ? term.props.tab._reloadState?.cwd
      : ''
    // A local tab answers to the *local* start directory and nothing else: the
    // bookmark value, then the global setting, then the CLI `--init-folder`
    // that created the default tab. `startDirectory` is the far side's
    // directory (ssh/telnet/serial) and is meaningless on this machine - typing
    // it into a local shell would only move the user somewhere that does not
    // exist.
    const startFolder = reloadCwd ||
      (this.isLocal()
        ? startDirectoryLocal ||
          term.props.config.startDirectoryLocal ||
          window.initFolder
        : startDirectory)
    // Remember where the shell started: it is the base for resolving a relative
    // path the user ctrl+clicks, for the whole time shell integration has not
    // reported a live cwd yet (and forever, on shells that cannot report one).
    term.setInitialCwd?.(startFolder || '')
    let cwdCommand = ''
    if (startFolder) {
      // No `|| cd "<raw>"` fallback: these helpers return '' for a path they
      // refuse (control characters, over-long), and interpolating the raw value
      // instead would hand `startDirectory` - which a quick-connect link can
      // set - straight to the shell as a command.
      const shell = localShell || this.getLocalExec().shell
      const usePosix = this.isRemoteShell() || (this.isLocal() && !isWin && !isPowerShellExecutable(shell))
      cwdCommand = usePosix
        ? createRestoreCwdCommand(startFolder)
        : createWindowsRestoreCwdCommand(startFolder, shell)
    }
    if (cwdCommand) {
      scripts.unshift({ script: cwdCommand, delay: 0 })
    }

    const token = ++this.token
    this.queue = []
    // A new connection is a new pty: whatever was injected into the previous
    // one did not survive it, so the "already injected" answer has to be
    // forgotten - otherwise a reconnect would type the start directory into a
    // shell that is still booting, without waiting for its prompt.
    this.shellInjected = false
    this.shellType = null
    this.shellInjectionError = ''

    if (this.canInjectShellIntegration()) {
      this.queue.push({
        type: 'shell_integration',
        execute: async () => {
          await this.injectShellIntegration()
        }
      })
    }

    scripts.forEach((script, i) => {
      this.queue.push({
        type: 'delayed_script',
        script: script.script,
        delay: script.delay || 0,
        // Nothing follows the last one, so waiting for the shell to settle
        // would only add latency.
        isLast: i === scripts.length - 1,
        execute: () => {
          if (script.script && this.addon) {
            this.addon._sendData(script.script + '\r')
          }
        }
      })
    })

    this.start(token)
  }

  /**
   * Put a shell integration injection at the head of the queue.
   * Inserting - instead of firing it off immediately - keeps it serialized
   * against anything still queued and guarantees a single drain loop.
   */
  /**
   * Put a shell integration injection at the head of the queue.
   * Inserting - instead of firing it off immediately - keeps it serialized
   * against anything still queued and guarantees a single drain loop.
   *
   * @author xiaogui
   * @since 2026-11-25 11:08:38
   * @param {boolean} sendEnter - Request a fresh prompt when enabling path
   *   following after the injection already happened
   * @returns {void}
   */
  enqueueShellIntegration = (sendEnter) => {
    this.queue.unshift({
      type: 'shell_integration',
      execute: async () => {
        const injected = await this.injectShellIntegration()
        // A fresh prompt makes the shell emit OSC 633 ;P Cwd= right away.
        // injectShellIntegration already requested one when it did the
        // injection itself; only a later toggle needs one from here.
        if (sendEnter && !injected && this.shellInjected && this.addon) {
          this.requestFreshPrompt(this.addon)
        }
      }
    })
    this.start(this.token)
  }

  /**
   * Drain the queue one item at a time. Re-entrant calls only push items and
   * return, so two loops can never interleave or race for the same array.
   */
  start = async (token) => {
    if (this.running) {
      return
    }
    this.running = true
    try {
      while (
        !this.isClosed() &&
        token === this.token &&
        this.queue.length > 0
      ) {
        const item = this.queue.shift()
        try {
          await this.runItem(item)
        } catch (error) {
          console.error('[Shell Integration] Error processing queue item:', item.type, error)
        }
      }
    } finally {
      this.running = false
      // A newer queue was built while this loop was still draining (reconnect,
      // config toggle). Pick it up here, otherwise the fresh items would sit
      // in the array with nobody left to run them.
      if (
        !this.isClosed() &&
        token !== this.token &&
        this.queue.length > 0
      ) {
        this.start(this.token)
      }
    }
  }

  runItem = async (item) => {
    if (this.isClosed() || !this.addon) {
      return
    }
    if (item.type === 'shell_integration') {
      await item.execute()
      // Give the freshly injected prompt a moment to finish drawing before
      // anything is typed into it.
      await this.waitForSettle({ usePrompt: false })
      return
    }
    if (item.type !== 'delayed_script') {
      return
    }
    item.execute()
    if (item.isLast) {
      return
    }
    await this.sleep(item.delay)
    // Never type the next script into a shell that is still busy. Bounded, so
    // a script that never returns can not block the rest of the queue.
    await this.waitForSettle()
  }

  /**
   * Wait until the terminal stops producing output before typing the next
   * queued item. Resolves on whichever comes first:
   *  - a fresh prompt (OSC 633 ;A), when shell integration is active - the
   *    exact "previous command finished" signal
   *  - no output for `idleMs`
   * Always resolves; `timeoutMs` caps it.
   */
  waitForSettle = ({ timeoutMs = settleTimeoutMs, idleMs = settleIdleMs, usePrompt = true } = {}) => {
    const addon = this.addon
    if (this.isClosed() || !addon || !addon.waitForOutputIdle || addon.disposed) {
      return Promise.resolve(false)
    }
    const idle = addon.waitForOutputIdle({ idleMs, timeoutMs })
    if (!usePrompt || !this.cmdAddon || !this.cmdAddon.onPrompt) {
      return idle
    }
    return new Promise((resolve) => {
      let done = false
      let unsubscribe = null
      const finish = (result) => {
        if (done) {
          return
        }
        done = true
        clearTimeout(capTimer)
        if (unsubscribe) {
          unsubscribe()
        }
        resolve(result)
      }
      unsubscribe = this.cmdAddon.onPrompt(() => finish('prompt'))
      const capTimer = setTimeout(() => finish(false), timeoutMs + 200)
      this.timers.add(capTimer)
      idle.then(quiet => finish(quiet ? 'idle' : false))
    })
  }

  // ---- shell integration ----

  /**
   * Shell integration is a Bourne-shell script typed into the session, so it
   * may only go where a POSIX shell is known to be listening: locally, where
   * we spawned that shell ourselves, or over ssh, where `$SHELL` can be read
   * on an exec channel.
   *
   * Telnet and serial are raw byte pipes to whatever sits on the other end -
   * a Huawei VRP switch, a console server, a UART. Nothing can be probed
   * there, so the old `sh` fallback typed the script into CLIs that cannot
   * run it: the device echoes it, the suppression window freezes the screen
   * until it times out, and the text is then replayed into the scrollback.
   * See issue #4610.
   */
  canInjectShellIntegration = () => {
    const { config, sftpPathFollowSsh } = this.term.props
    const wanted =
      config.showCmdSuggestions ||
      sftpPathFollowSsh ||
      (config.restoreTerminalSessionOnReload && this.isRestorable())
    if (this.isSsh()) {
      return !!wanted
    }
    if (!this.isLocal()) {
      return false
    }
    if (isWin) {
      // Windows: only PowerShell can report its cwd from the prompt, and it is
      // worth doing unconditionally - a ctrl+clicked relative path is resolved
      // against that cwd, so the optional features above must not gate it.
      // `cmd` has no equivalent, so it stays a plain terminal (#4737).
      return this.getLocalShellType() === 'powershell'
    }
    return !!wanted
  }

  /**
   * Inject shell integration commands from client-side.
   * Replaces the server-side `source xxx.xxx` approach; output suppression
   * hides the injection command. Resolves when injection is complete - or
   * when it is given up on, never hangs.
   *
   * @author xiaogui
   * @since 2026-11-25 11:08:38
   * @returns {Promise<boolean>} true when this call typed the script itself
   *   and already asked for a fresh prompt; false when nothing new was done
   */
  injectShellIntegration = async () => {
    if (this.shellInjected) {
      return false
    }

    const addon = this.addon
    if (!addon) {
      return false
    }

    // Mark the injection as running. The caller uses the flag to tell
    // "the shell reported nothing yet" apart from "the injection has not
    // had its chance yet" - the injection needs the remote shell probe, the
    // wait for the first prompt and the output suppression window, all of
    // which take longer than one check interval.
    this.shellIntegrationPending = true
    try {
      const typedByUs = await this._doInjectShellIntegration(addon)
      // The injection is done and the output suppression window is closed,
      // so this is the first moment a prompt's OSC 633 ;P;Cwd= can reach
      // the client. Ask for a fresh prompt to get that report - without it
      // the directory the shell just reported stays hidden and the file
      // manager only starts following after the user runs a command.
      // Only do this once: enqueueShellIntegration used to send a second
      // Enter here as well, which drew two prompts.
      if (typedByUs) {
        this.requestFreshPrompt(addon)
      } else if (this.shellInjectionError) {
        // Nothing was injected and the server did not inject it either:
        // the session stays a plain terminal. Say so - otherwise the user
        // only sees a grey paperclip and no hint about why the file
        // manager does not follow the shell.
        this.onInjectionFailed?.(this.shellInjectionError)
      }
      return !!typedByUs
    } finally {
      this.shellIntegrationPending = false
    }
  }

  /**
   * The actual injection, see injectShellIntegration.
   *
   * @author xiaogui
   * @since 2026-11-23 12:42:30
   * @param {object} addon - The attach addon of this session
   * @returns {Promise<boolean>} Resolves to true when the script was typed
   *   into the shell by the client, false when the server had injected it
   *   already or nothing was injected at all
   */
  _doInjectShellIntegration = async (addon) => {
    // Wait for the shell's first prompt right away, in parallel with the
    // probe below. The two do not depend on each other, and running them in
    // series meant that the injection could only start after the probe had
    // answered *and* the shell had been quiet for a while - which is what
    // "it only injects after a while" felt like.
    const promptReady = this.waitForShellPrompt(addon)

    let shellType
    if (this.isLocal()) {
      shellType = this.getLocalShellType()
    } else if (this.isRemoteShell()) {
      shellType = await this.detectRemoteShellType()
    }

    // '' means the far side never said what shell it runs: the probe channel
    // was refused, answered with a CLI error banner, or timed out. Guessing
    // `sh` in that case is exactly what typed the script into a switch - skip
    // instead, and let the session stay a plain terminal.
    if (!shellType) {
      this.shellInjectionError = 'probe'
      return false
    }

    // `cmd` is detected only to keep it out: it cannot run any script we have.
    if (!shellIntegrationTypes.has(shellType)) {
      return false
    }

    this.shellType = shellType

    // A local PowerShell may already have the integration loaded: the server
    // hands it to the pty as `-NoExit -Command <script>` at spawn time
    // (server/session-local.js), so there is nothing to type here - and typing
    // it is exactly what used to leave the script on screen. The wait still
    // matters: the `cd` and run scripts queued behind this item must not be
    // typed into a shell that is still booting. Both sides ask the same helper,
    // so "the server injected" and "do not type" can not disagree.
    if (this.isSpawnInjectedShell(shellType)) {
      this.shellInjected = true
      await promptReady
      // The server injected it at spawn time: the shell already reports its
      // directory from every prompt, no extra one is needed.
      return false
    }

    // sh/ash only reports cwd via PS1 (no command tracking), so it is only
    // worth injecting when something actually needs the cwd: sftp follow or
    // session restore. Command suggestions alone stay disabled on sh.
    const { config, sftpPathFollowSsh } = this.term.props
    if (
      shellType === 'sh' &&
      !sftpPathFollowSsh &&
      !config.restoreTerminalSessionOnReload
    ) {
      return false
    }

    // The connection (or the whole terminal) can go away while
    // detectRemoteShell is in flight. Bail instead of registering callbacks
    // on a dead socket - that is what used to leave the queue, and every run
    // script behind it, waiting forever.
    if (this.isClosed() || this.addon !== addon || addon.disposed) {
      return false
    }

    const integrationCmd = getShellIntegrationCommand(shellType)

    return new Promise((resolve) => {
      let done = false
      let gaveUp = false
      let pollTimer = null
      // Whether the script really made it into the shell. The paths that
      // give up before that point must not type anything at all - a shell
      // that never settles must stay untouched.
      let typed = false
      const finish = () => {
        if (done) {
          return
        }
        done = true
        clearInterval(pollTimer)
        this.intervals.delete(pollTimer)
        pollTimer = null
        // true: the script was typed into the shell, so the caller has to
        // ask for a fresh prompt to get the directory report.
        resolve(typed)
      }
      // Stop hiding output *without* showing what was hidden: everything
      // buffered in this window is the echo of the injection itself, which is
      // exactly what the window exists to keep off the screen. Writing it out
      // is what made the injected script appear in a PowerShell tab (#4737).
      //
      // Nothing reached the terminal, so the screen is left at whatever it
      // showed before the injection - which, on a shell that drew its first
      // prompt inside the window, is nothing at all. The fresh prompt that
      // reports the working directory is asked for by the caller.
      const giveUp = () => {
        if (done) {
          return
        }
        gaveUp = true
        if (addon.outputSuppressed) {
          addon.stopOutputSuppression(true)
        }
        finish()
      }

      // The wait for the shell's first prompt started together with the
      // probe, so it is normally already resolved by now. Nothing is typed
      // until the shell is actually listening, so no keystroke can sit in
      // the console buffer and be drawn after the suppression window is
      // gone. A remote login banner trickles over the network, so its
      // "quiet" has to be longer - typing into a half-drawn login prompt is
      // how a password ends up in a log.
      promptReady.then((ready) => {
        if (done || this.addon !== addon || addon.disposed) {
          return finish()
        }
        // An SSH prompt may already carry typed input. Injecting a script on
        // top of a half-typed command would corrupt it, so skip this session
        // and keep the plain terminal instead.
        if (!ready || (this.isSsh() && addon._lineHasUnsubmittedInput?.())) {
          // Booting shell, or one that never settles. Skip the injection:
          // a plain terminal is a far better outcome than a screen full of
          // script.
          this.shellInjectionError = 'prompt'
          return finish()
        }
        const startedAt = Date.now()
        // A remote shell answers across the network, so its silence is worth
        // more than a local one's: one slow round trip must not read as "the
        // prompt will never confirm".
        const quietMs = this.isRemoteShell() ? 2500 : injectionQuietMs
        let sawOutput = false
        let lastSeen = startedAt

        // The deadline is measured from the last chunk the shell sent, not
        // from the moment we typed: a shell that has not answered yet has not
        // read the command, so hiding a little longer costs nothing, while an
        // elapsed-time deadline expires *before* the shell even echoes -
        // PowerShell can take seconds to draw its very first prompt (conpty +
        // profile load), which is precisely how the injection ended up on
        // screen. Once the shell does answer, `quietMs` of silence without an
        // OSC 633 confirmation means the prompt will never report the cwd
        // (wrapped too early, or the user's profile replaced `prompt`
        // afterwards), so give up instead of hiding output indefinitely.
        pollTimer = setInterval(() => {
          if (done) {
            return
          }
          if (this.addon !== addon || addon.disposed) {
            return giveUp()
          }
          const now = Date.now()
          const last = addon.getLastOutputTime()
          if (last > lastSeen) {
            lastSeen = last
            sawOutput = true
          }
          // The addon ended the window itself - OSC 633 was seen.
          if (!addon.outputSuppressed) {
            return
          }
          if (!sawOutput) {
            if (now - startedAt >= injectionMaxWaitMs) {
              giveUp()
            }
            return
          }
          if (now - lastSeen >= quietMs) {
            giveUp()
          }
        }, 200)
        this.intervals.add(pollTimer)

        // Start suppressing output before sending the integration command.
        // This hides the command and its output until OSC 633 is detected.
        // The addon's own timer is only a backstop: the poll above decides.
        // Marked before the suppression window opens: the window may end
        // synchronously, and the caller has to know that the script went
        // into the shell even then.
        typed = true
        addon.startOutputSuppression(injectionMaxWaitMs + 2000, () => {
          if (!gaveUp && !addon.disposed) {
            this.shellInjected = true
          }
          finish()
        }, true)
        addon._sendData(integrationCmd)
      })
    })
  }

  /**
   * Ask the shell for one fresh prompt.
   *
   * The working directory is reported from the prompt hook, so the report
   * that follows the injection is swallowed by the output suppression
   * window that was just closed - the window hides everything until the
   * first OSC sequence shows up, and that first sequence is the directory
   * report itself. Without a second prompt the client never learns the
   * directory, and the file manager stays in the home directory until the
   * user happens to run a command.
   *
   * One empty Enter gives the shell a prompt to draw, and that prompt's
   * report reaches the client. It is skipped when the line may hold
   * unsubmitted input (a password prompt, hidden input, a full-screen
   * program), where a stray Enter is worse than a bare line.
   *
   * @author xiaogui
   * @since 2026-11-25 11:08:38
   * @param {object} addon - The attach addon of this session
   */
  requestFreshPrompt = (addon) => {
    if (!addon || addon.disposed || this.isClosed()) {
      return
    }
    if (this.addon !== addon) {
      return
    }
    // The window has to be closed, otherwise the report is swallowed again.
    if (addon.outputSuppressed) {
      return
    }
    if (
      typeof addon._lineHasUnsubmittedInput === 'function' &&
      addon._lineHasUnsubmittedInput()
    ) {
      return
    }
    addon._sendData('\r')
  }
}

export default StartupQueue
