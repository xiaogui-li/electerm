import { loadAttachAddon } from './xterm-loader.js'

// Cursor-positioning sequences stripped from the head of surviving output
// after a drop. These are either relative (ESC[nA rewinds n rows) or restore
// state saved by content we just discarded (ESC[8 / CSI u); left in place
// they yank the cursor back into already-rendered history and overwrite it.
// Safe leading sequences (colours, erase, cursor visibility, etc.) are kept.
const ESC = String.fromCharCode(27)
const CURSOR_CSI_FINALS = new Set([
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', '`', 'a', 'd', 'e', 'f', 's', 'u'
])
const CURSOR_ESC_FINALS = new Set(['7', '8', 'D', 'E', 'M'])

// Upper bound on output buffered while suppression is active (UTF-16 code
// units). Past this the rest of the hidden output is dropped instead of
// growing the buffer without limit.
const MAX_SUPPRESSED_CHARS = 200000

// How long a silent suppression window waits for the output to go quiet
// before it ends.
//
// The heartbeat redraw reaches the client as several writes: the echoed
// newline, the shell integration report and the prompt text. They can land
// in different chunks, so a silent window can not close on the report
// alone - the prompt text would then arrive with the window already closed
// and show up on the screen. Closing the window after a short quiet period
// keeps the heartbeat invisible, and still closes fast enough that a
// keystroke typed right after it is not swallowed.
const SUPPRESS_QUIET_MS = 150

function ansiSequenceEnd (str, start) {
  const type = str[start + 1]
  if (!type) {
    return -1
  }
  if (type === '[') {
    for (let i = start + 2; i < str.length; i++) {
      const code = str.charCodeAt(i)
      if (code >= 0x40 && code <= 0x7e) {
        return i + 1
      }
    }
    return -1
  }
  if (type === ']' || type === 'P' || type === '^' || type === '_') {
    for (let i = start + 2; i < str.length; i++) {
      if (str.charCodeAt(i) === 7) {
        return i + 1
      }
      if (str[i] === ESC && str[i + 1] === '\\') {
        return i + 2
      }
    }
    return -1
  }
  for (let i = start + 1; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code >= 0x30 && code <= 0x7e) {
      return i + 1
    }
    if (code < 0x20 || code > 0x2f) {
      return start + 2
    }
  }
  return -1
}

export function stripLeadingCursorOps (str) {
  let index = 0
  let safePrefix = ''
  while (index < str.length) {
    if (str[index] === '\r') {
      index += 1
      continue
    }
    if (str[index] !== ESC) {
      break
    }
    const end = ansiSequenceEnd(str, index)
    if (end < 0) {
      break
    }
    const type = str[index + 1]
    const final = str[end - 1]
    const isCursorOp = type === '['
      ? CURSOR_CSI_FINALS.has(final)
      : CURSOR_ESC_FINALS.has(type)
    if (!isCursorOp) {
      safePrefix += str.slice(index, end)
    }
    index = end
  }
  return safePrefix + str.slice(index)
}

function startAfterPartialAnsi (str, start) {
  if (start <= 0) {
    return start
  }
  const esc = str.lastIndexOf(ESC, start - 1)
  const newline = str.lastIndexOf('\n', start - 1)
  if (esc <= newline) {
    return start
  }
  const end = ansiSequenceEnd(str, esc)
  return end < 0 || end > start ? Math.max(start, end < 0 ? str.length : end) : start
}

function truncationMarker (dropped) {
  const kb = Math.round(dropped / 1024)
  return `\r\n...[electerm] output truncated, ${kb}K skipped...\r\n`
}

export function truncateTerminalOutput (str, maxChars) {
  if (str.length <= maxChars) {
    return { output: str, dropped: 0 }
  }
  if (maxChars < truncationMarker(str.length).length) {
    return { output: '', dropped: str.length }
  }
  let marker = truncationMarker(str.length - maxChars)
  let output = ''
  let dropped = str.length
  for (let i = 0; i < 3; i++) {
    const payloadBudget = Math.max(0, maxChars - marker.length)
    let start = Math.max(0, str.length - payloadBudget)
    const newline = str.indexOf('\n', start)
    if (newline >= 0 && newline < str.length - 1) {
      start = newline + 1
    } else {
      start = startAfterPartialAnsi(str, start)
      if (start > 0 && str.charCodeAt(start) >= 0xdc00 && str.charCodeAt(start) <= 0xdfff) {
        start += 1
      }
    }
    output = stripLeadingCursorOps(str.slice(start))
    dropped = str.length - output.length
    const nextMarker = truncationMarker(dropped)
    if (nextMarker === marker && marker.length + output.length <= maxChars) {
      break
    }
    marker = nextMarker
  }
  if (marker.length + output.length > maxChars) {
    output = output.slice(marker.length + output.length - maxChars)
    dropped = str.length - output.length
    marker = truncationMarker(dropped)
  }
  return {
    output: (marker + output).slice(0, maxChars),
    dropped
  }
}

export default class AttachAddonCustom {
  constructor (term, socket, isWindowsShell) {
    this.term = term
    this.socket = socket
    this.isWindowsShell = isWindowsShell
    this.outputSuppressed = false
    this.suppressedData = []
    this.suppressedChars = 0
    // Tail of an escape sequence that was cut off by a chunk boundary
    // while the output was suppressed; see findIncompleteSequenceStart.
    this._suppressTail = ''
    // Whether the report that ends a suppression window is written with a
    // leading newline; see startOutputSuppression.
    this._suppressLeadingNewline = true
    // Whether the window hides everything it receives instead of writing
    // the report and the prompt that follows it; see startOutputSuppression.
    this._suppressSilent = false
    // Timer that ends a silent window once the output goes quiet.
    this._suppressQuietTimer = null
    this.suppressTimeout = null
    this.onSuppressionEndCallback = null
    this.hasReceivedInitialData = false
    this.onInitialDataCallback = null
    this._bidirectional = true
    this._disposables = []
    this._socket = socket
    this.decoder = new TextDecoder('utf-8')
    this._lastDataTime = Date.now()
    this._lastInputTime = Date.now()
    // Set for the lifetime of the connection; every async helper below
    // bails out on it so a disposed addon can never leave a pending promise
    // (and the startup queue waiting on it) hanging.
    this.disposed = false
    this._keepaliveTimer = null
    this._keepaliveInterval = 3000
    // Characters typed on the current command line and not yet submitted.
    // Only a hint: the keepalive decision is made against the terminal buffer
    // (see _lineHasUnsubmittedInput), because escape sequences put text on the
    // line without sending a printable character.
    this._pendingInputLength = 0
    // Set by an escape sequence (cursor keys, history recall, bracketed paste)
    // until the line is submitted or cleared: from then on the byte count above
    // can not be trusted, because Up can recall a whole command.
    this._pendingInputUnknown = false
    // The command line as the shell last drew it with nothing typed on it:
    // { row, length }. Captured after output is parsed, so the keepalive can
    // ask the screen "is there anything past the prompt?" instead of guessing
    // from keystrokes.
    this._lineBaseline = null
    this._lastOutputLine = ''
    this._passwordPromptDetected = false
    this._pendingEchoCheck = null
    this._echoCheckTimer = null
    // Write coalescing: terminal output is buffered and flushed on a short
    // timer so that heavy bursts (e.g. `yum install` download progress, which
    // rewrites the same line with \r + clear-line thousands of times per
    // second) collapse into a few term.write() calls per frame instead of
    // blocking the main thread on every WebSocket message.
    this._writeBuffer = []
    this._bufferChars = 0
    this._flushScheduled = false
    this._flushTimer = null
    // Coalescing window. Output is flushed at most once per interval.
    // 16ms ~= one frame; low enough that interactive echo feels instant,
    // high enough to merge a multi-MB/s flood into ~60 writes/s.
    this._flushIntervalMs = 16
    // Time of the last actual flush. Drives the interactive fast path in
    // _enqueueWrite: output arriving after an idle gap (keystroke echo,
    // command result) is flushed immediately instead of paying the
    // coalescing delay. 0 = the first chunk ever flushes immediately.
    this._lastFlushTime = 0
    // Soft cap on buffered-but-unflushed characters (UTF-16 code units, not
    // bytes — see _enqueueWrite). Under a sustained flood the producer outruns
    // the renderer; once pending output exceeds this we drop the OLDEST data
    // (preserving the newest, visible tail and the line currently being
    // rewritten). Normal interactive output is many orders of magnitude
    // smaller and is never dropped.
    //
    // 2M, up from 256K: TUI apps (claude, codex, ...) repaint by rewinding
    // with ESC[nA, and Ink-style rewinds reach 50+ rows. At 256K the cap was
    // tripped routinely by ordinary TUI output, and dropping out of the middle
    // of such a stream corrupted the screen — surviving frames still carried
    // rewinds that then pointed at output we never wrote (see
    // _dropOldestUntil, which now strips them). 2M is ~200 full-screen
    // repaints of a 200x50 terminal, so only genuinely runaway output (yes,
    // `cat` of a huge file) trips it.
    this._maxBufferChars = 2 * 1024 * 1024
    this._droppedChars = 0
    this._droppedWarned = false
    // Automation taps: subscribers receive the decoded string BEFORE write
    // coalescing (see writeToTerminal). Suppressed output never reaches taps.
    this._dataTaps = new Set()
  }

  addDataTap = (fn) => {
    this._dataTaps.add(fn)
    return () => {
      this._dataTaps.delete(fn)
    }
  }

  _initBase = async () => {
    const AttachAddon = await loadAttachAddon()
    const base = new AttachAddon(this._socket, { bidirectional: this._bidirectional })
    this._sendData = base._sendData.bind(base)
  }

  onInitialData = (callback) => {
    if (this.disposed) {
      // Never let a caller wait on a dead connection.
      return
    }
    if (this.hasReceivedInitialData) {
      callback()
    } else {
      this.onInitialDataCallback = callback
    }
  }

  // Timestamp of the last chunk that arrived from the shell, updated even
  // while output is suppressed. This is what "has the terminal gone quiet?"
  // is measured against.
  getLastOutputTime = () => {
    return this._lastDataTime
  }

  /**
   * Resolve once the shell has produced no output for `idleMs`.
   * Used to pace queued startup work (shell integration injection, run
   * scripts) so the next command is never typed into a shell that is still
   * drawing the previous prompt - that race is what made run scripts get
   * dropped when sftp path following was on.
   * Never rejects and never hangs: resolves false on timeout or when the
   * connection is gone.
   */
  waitForOutputIdle = ({ idleMs = 400, timeoutMs = 3000 } = {}) => {
    if (this.disposed || !this.term) {
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      let done = false
      const finish = (result) => {
        if (done) {
          return
        }
        done = true
        clearInterval(pollTimer)
        clearTimeout(capTimer)
        resolve(result)
      }
      const step = Math.max(50, Math.min(idleMs, 200))
      const pollTimer = setInterval(() => {
        if (this.disposed || !this.term) {
          return finish(false)
        }
        if (Date.now() - this._lastDataTime >= idleMs) {
          finish(true)
        }
      }, step)
      const capTimer = setTimeout(() => finish(false), Math.max(idleMs, timeoutMs))
    })
  }

  /**
   * Hide the terminal output for a while.
   *
   * Two kinds of window exist:
   *
   *  - the injection window (shell integration): the echoed command is
   *    swallowed, so the report and the prompt that follows it are written
   *    back, with a leading newline so the fresh prompt starts on a line of
   *    its own.
   *  - the heartbeat window (session keepalive): the shell redraws its
   *    prompt after the heartbeat woke it up, and that redraw must not be
   *    visible at all - it would put a second prompt on the screen every
   *    few seconds. A silent window therefore writes nothing and ends once
   *    the output goes quiet.
   *
   * @author xiaogui
   * @since 2026-11-23 17:12:41
   * @param {number} timeout - hard limit of the window, in ms
   * @param {Function} onEnd - called when the window ends
   * @param {boolean} discardOnTimeout - drop the buffered output on timeout
   * @param {object} options - window behaviour
   * @param {boolean} options.leadingNewline - write a newline before the report
   * @param {boolean} options.silent - hide everything the window receives
   * @returns {void}
   */
  startOutputSuppression = (timeout = 3000, onEnd = null, discardOnTimeout = false, options = {}) => {
    if (this.disposed) {
      onEnd?.()
      return
    }
    const { leadingNewline = true, silent = false } = options
    // A suppression may already be running (e.g. the 500ms keepalive one).
    // Starting another must end it first - otherwise its timer stays armed
    // and fires in the middle of the new window, ending it early and
    // flushing half-collected output (the shell integration echo) to screen.
    if (this.outputSuppressed) {
      const previous = this.onSuppressionEndCallback
      this.onSuppressionEndCallback = null
      if (this.suppressTimeout) {
        clearTimeout(this.suppressTimeout)
        this.suppressTimeout = null
      }
      this._clearSuppressQuietTimer()
      this.outputSuppressed = false
      previous?.()
    }
    this.outputSuppressed = true
    this.suppressedData = []
    this.suppressedChars = 0
    // A new window starts with no carry-over: the previous window's tail
    // belongs to a sequence that was already dropped.
    this._suppressTail = ''
    // Whether the report that ends this window is written with a leading
    // newline.
    //
    // The injection window needs it: the echoed command is swallowed, so the
    // screen is left sitting on the injection line and the fresh prompt has
    // to start on a line of its own.
    //
    // The keepalive window must not have it: that window swallows a
    // heartbeat which never drew anything, and the newline would show up as
    // a blank line on every idle tick - one every few seconds, for as long
    // as the session sits there.
    this._suppressLeadingNewline = leadingNewline
    // A silent window writes nothing at all - see the note above.
    this._suppressSilent = silent
    this.onSuppressionEndCallback = onEnd
    this.suppressTimeout = setTimeout(() => {
      if (!discardOnTimeout) {
        console.warn('[AttachAddon] Output suppression timeout reached, resuming')
      }
      this.stopOutputSuppression(discardOnTimeout)
    }, timeout)
  }

  /**
   * The plain text that follows the last shell integration sequence in a
   * chunk, or null when the chunk holds no sequence at all.
   *
   * The heartbeat redraw is the echoed newline, the report and the prompt
   * text. The prompt text is what tells the client the redraw is over: as
   * soon as it has been seen the silent window can close right away,
   * instead of waiting for a quiet period - otherwise a keystroke typed in
   * that period would be swallowed together with the redraw.
   *
   * @author xiaogui
   * @since 2026-11-23 17:21:07
   * @param {string} str - The chunk to inspect
   * @returns {string|null} The text after the last sequence, or null
   */
  shellIntegrationTail = (str) => {
    const reportIdx = this.indexOfShellIntegration(str)
    if (reportIdx === -1) {
      return null
    }
    const ESC = String.fromCharCode(27)
    let end = -1
    for (let i = reportIdx; i < str.length; i++) {
      if (str[i] === '\x07') {
        end = i + 1
      } else if (str[i] === ESC && str[i + 1] === '\\') {
        end = i + 2
      }
    }
    if (end === -1) {
      return null
    }
    return str.slice(end)
  }

  /**
   * (Re)arm the timer that ends a silent window once the output goes quiet.
   *
   * The timer is only armed by data that actually arrived, so a window that
   * never sees the redraw still ends on its own hard timeout.
   *
   * @author xiaogui
   * @since 2026-11-23 17:13:52
   * @returns {void}
   */
  _armSuppressQuietTimer = () => {
    this._clearSuppressQuietTimer()
    this._suppressQuietTimer = setTimeout(() => {
      this._suppressQuietTimer = null
      if (this.outputSuppressed && this._suppressSilent) {
        this.stopOutputSuppression(true)
      }
    }, SUPPRESS_QUIET_MS)
  }

  /**
   * Drop the pending quiet timer, if any.
   *
   * @author xiaogui
   * @since 2026-11-23 17:14:26
   * @returns {void}
   */
  _clearSuppressQuietTimer = () => {
    if (this._suppressQuietTimer) {
      clearTimeout(this._suppressQuietTimer)
      this._suppressQuietTimer = null
    }
  }

  stopOutputSuppression = (discard = true) => {
    if (this.suppressTimeout) {
      clearTimeout(this.suppressTimeout)
      this.suppressTimeout = null
    }
    this._clearSuppressQuietTimer()
    this.outputSuppressed = false

    const pending = this.suppressedData
    this.suppressedData = []
    this.suppressedChars = 0
    // The next window decides for itself; see startOutputSuppression.
    this._suppressLeadingNewline = true
    this._suppressSilent = false
    if (!discard && pending.length > 0 && this.term) {
      for (const data of pending) {
        this.writeToTerminalDirect(data)
      }
    }

    if (this.onSuppressionEndCallback) {
      const callback = this.onSuppressionEndCallback
      this.onSuppressionEndCallback = null
      callback()
    }
  }

  activate = async (terminal = this.term) => {
    await this._initBase()
    this.addSocketListener(this._socket, 'message', this.onMsg)

    if (this._bidirectional) {
      this._disposables.push(terminal.onData((data) => this.sendToServer(data)))
      this._disposables.push(terminal.onBinary((data) => this.sendToServer(new Uint8Array(data))))
    }

    this._disposables.push(this.addSocketListener(this._socket, 'close', () => this.dispose()))
    this._disposables.push(this.addSocketListener(this._socket, 'error', () => this.dispose()))
  }

  onMsg = (ev) => {
    this._lastDataTime = Date.now()
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data)
        const controlActions = [
          'zmodem-event',
          'trzsz-event',
          'xmodem-event',
          // serial line status, see session/serial-control.jsx
          'serial-event',
          // how the pty ended, consumed by the terminal component
          'session-exit'
        ]
        if (controlActions.includes(msg.action)) {
          return
        }
      } catch (e) {}
    }

    this.writeToTerminal(ev.data)
  }

  static passwordPromptPatterns = [
    /password\s*[:\]>]\s*$/i,
    /\[sudo\]\s*password\s+for\s+\S+\s*:\s*$/i,
    /enter\s+passphrase/i,
    /enter\s+password/i,
    /密码[：:]\s*$/,
    /パスワード[：:]\s*$/,
    /mot de passe\s*[:\]]\s*$/i,
    /passwort[:\]]\s*$/i,
    /contraseña[:\]]\s*$/i
  ]

  _checkPasswordPrompt = (str) => {
    // Extract last non-empty line from the output
    const lines = str.split(/\r?\n|\r/)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line) {
        this._lastOutputLine = line
        break
      }
    }
    return AttachAddonCustom.passwordPromptPatterns.some(
      p => p.test(this._lastOutputLine)
    )
  }

  _onEchoCheckTimeout = () => {
    // No echo received within timeout → confirms password mode
    this._pendingEchoCheck = null
  }

  _handleEchoDetection = (str) => {
    if (this._pendingEchoCheck) {
      // Server sent data back while we were waiting → echo is ON → not password
      if (str.includes(this._pendingEchoCheck.char)) {
        this._passwordPromptDetected = false
        clearTimeout(this._echoCheckTimer)
        this._pendingEchoCheck = null
        this._echoCheckTimer = null
        // Cancel the password dropdown if it was shown
        this.term?.parent?.onPasswordPromptCancelled?.()
      }
    }
  }

  // Index of the first shell integration sequence in the chunk, or -1.
  //
  // OSC 633 is electerm's own protocol and OSC 1337 is iTerm2's - both
  // carry the working directory, so both have to end the suppression
  // window. Only OSC 633 used to be looked for, and a shell that only
  // speaks 1337 kept its window open until the timeout, which threw the
  // directory report away with it.
  indexOfShellIntegration = (str) => {
    const ESC = String.fromCharCode(27)
    const osc633 = str.indexOf(ESC + ']633;')
    const osc1337 = str.indexOf(ESC + ']1337;')
    if (osc633 === -1) {
      return osc1337
    }
    if (osc1337 === -1) {
      return osc633
    }
    return Math.min(osc633, osc1337)
  }

  /**
   * Where an unfinished escape sequence starts in a chunk, or -1.
   *
   * A shell integration sequence can be split across two TCP chunks: the
   * first ends in the middle of `ESC ] 633 ; P ; Cwd=/...` and the second
   * carries the rest. Searching each chunk on its own never finds the
   * introducer, so the window stays open until the timeout and the
   * directory the shell reported is dropped with the discarded buffer.
   * The tail of the previous chunk is therefore kept and prepended to the
   * next one, so the sequence is seen whole.
   *
   * A sequence is finished when its terminator is there, and a terminator
   * depends on the kind of sequence (ECMA-48):
   *  - OSC (`ESC ]`) ends with BEL (`\x07`) or ST (`ESC \`)
   *  - CSI (`ESC [`) ends with a final byte in the range 0x40-0x7e
   *  - DCS/SOS/PM/APC (`ESC P/X/^/_`) end with ST
   * Getting this wrong is not a cosmetic issue: a *complete* sequence that
   * is mistaken for an unfinished one is held back as a carry-over and
   * prepended to the next chunk, so it is written to the screen twice -
   * and since the keepalive heartbeat writes `ESC [ K` on every idle
   * tick, that produced a new prompt line every few seconds.
   *
   * @author xiaogui
   * @since 2026-11-23 12:36:20
   * @param {string} str - The chunk to inspect
   * @returns {number} The index of the incomplete sequence, or -1
   */
  findIncompleteSequenceStart = (str) => {
    const ESC = String.fromCharCode(27)
    const idx = str.lastIndexOf(ESC)
    if (idx === -1) {
      return -1
    }
    const rest = str.slice(idx)
    // A terminated sequence needs no carry-over.
    if (rest.includes('\x07')) {
      return -1
    }
    if (rest.includes(ESC + '\\')) {
      return -1
    }
    // CSI (`ESC [`) is finished by its final byte, which is in the range
    // 0x40-0x7e (`@` to `~`). Parameter and intermediate bytes are below
    // 0x40, so the first byte in that range closes the sequence.
    // `ESC [ K` (erase in line) - what the keepalive heartbeat writes - is
    // such a sequence and must not be carried over.
    if (rest[1] === '[') {
      for (let i = 2; i < rest.length; i++) {
        const code = rest.charCodeAt(i)
        if (code >= 0x40 && code <= 0x7e) {
          return -1
        }
      }
      return idx
    }
    return idx
  }

  writeToTerminalDirect = (data) => {
    const { term } = this
    if (!term || term.parent?.onZmodem) {
      return
    }
    if (typeof data === 'string') {
      return term.write(data, this._recordLineBaseline)
    }
    term.write(data, this._recordLineBaseline)
  }

  writeToTerminal = (data) => {
    const { term } = this
    if (term.parent?.onZmodem) {
      return
    }

    if (!this.hasReceivedInitialData) {
      this.hasReceivedInitialData = true
      if (this.onInitialDataCallback) {
        const callback = this.onInitialDataCallback
        this.onInitialDataCallback = null
        setTimeout(callback, 0)
      }
    }

    // Decode once, synchronously. The previous implementation routed binary
    // chunks through `new Blob()` + `FileReader.readAsArrayBuffer()` and decoded
    // in an async `onRead` callback; that async round-trip (plus a per-chunk
    // Blob allocation) showed up in the profile and fragmented main-thread work.
    // We already hold a TextDecoder, so decode inline like the suppression path.
    let str = data
    if (typeof data !== 'string') {
      try {
        // Decode in streaming mode: slow SSH servers (e.g. embedded router
        // CLIs) often deliver a multi-byte UTF-8 char (CJK = 3 bytes) split
        // across TCP segments, and the server-side idle fast path may forward
        // the first segment immediately. Without { stream: true } the decoder
        // would turn each partial fragment into U+FFFD instead of carrying the
        // trailing bytes over to the next chunk and reassembling the char.
        str = this.decoder.decode(
          data instanceof ArrayBuffer ? data : new Uint8Array(data),
          { stream: true }
        )
      } catch (e) {
        str = ''
      }
    }

    if (this.outputSuppressed) {
      if (this._suppressSilent) {
        // A silent window (the session heartbeat) writes nothing at all.
        //
        // The heartbeat wakes the shell up, and the shell answers with a
        // full prompt redraw: the echoed newline, the shell integration
        // report and the prompt text. Writing any part of it shows a second
        // prompt on the screen - that is the "keepalive adds a line every
        // few seconds" artefact - so the whole redraw is dropped.
        //
        // The window ends as soon as the redraw is over. The prompt text
        // that follows the report is the marker for that; when it has not
        // arrived yet the window waits for the output to go quiet, because
        // the report and the prompt text are separate writes and can land
        // in different chunks.
        const tail = this.shellIntegrationTail(str)
        if (tail === null || tail.length === 0) {
          this._armSuppressQuietTimer()
          return
        }
        this.stopOutputSuppression(true)
        return
      }
      // A shell integration sequence can straddle two TCP chunks. The tail
      // of the previous chunk is prepended here so the sequence is seen
      // whole - otherwise the introducer is never found, the window stays
      // open until the timeout and the directory report is dropped with
      // the discarded buffer.
      const pending = this._suppressTail || ''
      this._suppressTail = ''
      const combined = pending + str
      const oscIdx = this.indexOfShellIntegration(combined)
      if (oscIdx !== -1) {
        // Shell integration is confirmed active. The pty often coalesces the
        // tail of the echoed injection command and the first OSC 633 output
        // into one chunk, so write only from the first OSC sequence on —
        // everything before it is echo and stays hidden. A leading newline
        // keeps the fresh prompt off the injection-time prompt line.
        const leading = this._suppressLeadingNewline ? '\r\n' : ''
        this.stopOutputSuppression(true)
        this._enqueueWrite(leading + combined.slice(oscIdx))
        return
      }
      // Keep an unfinished escape sequence for the next chunk.
      const tailStart = this.findIncompleteSequenceStart(combined)
      if (tailStart !== -1) {
        this._suppressTail = combined.slice(tailStart)
      }
      // Bounded: a slow login banner or a chatty MOTD during the injection
      // window must not buffer without limit while output is hidden.
      if (this.suppressedChars < MAX_SUPPRESSED_CHARS) {
        this.suppressedChars += str.length
        this.suppressedData.push(data)
      }
      return
    }

    // Prompt/echo detection runs per chunk (cheap) so password prompts and
    // shell integration are still detected promptly.
    this._handleEchoDetection(str)
    if (this._checkPasswordPrompt(str) && !this._passwordPromptDetected) {
      this._passwordPromptDetected = true
      // Show password dropdown immediately after terminal renders the prompt
      setTimeout(() => {
        this.term?.parent?.onPasswordPromptDetected?.()
      }, 100)
    }

    // Coalesce the actual write (see _enqueueWrite). notifyOnData /
    // onTerminalWrite fire once per flush instead of once per chunk.
    // Automation taps run here on the decoded string, before coalescing
    // (and after the suppression early-return above, so suppressed
    // keepalive/shell-integration echo never triggers automations).
    if (this._dataTaps.size) {
      for (const fn of this._dataTaps) {
        try {
          fn(str)
        } catch (e) {
          console.error('[dataTap]', e)
        }
      }
    }
    this._enqueueWrite(str)
  }

  // Buffer decoded output and flush it on a short timer so a burst of messages
  // becomes a single (size-capped) term.write() call, keeping the main thread
  // free to handle UI events and input between flushes.
  _enqueueWrite = (str) => {
    if (!this.term || !str) {
      return
    }
    this._writeBuffer.push(str)
    this._bufferChars += str.length
    if (this._bufferChars > this._maxBufferChars) {
      this._dropOldestUntil()
    }
    // A hidden window gets its timers throttled by Chromium (Electron's
    // backgroundThrottling defaults to true), which would stall the flush
    // timer and force the cap to drop real output. Nothing is painted
    // while hidden, so coalescing buys nothing — flush synchronously.
    if (document.hidden) {
      clearTimeout(this._flushTimer)
      this._flushWrites()
      return
    }
    // Interactive fast path: if the last flush was longer ago than the
    // coalescing window (keystroke echo, command result after idle), flush
    // immediately so typing adds zero latency. Only output arriving inside
    // a burst window pays the coalescing delay — which is exactly the flood
    // case coalescing exists for.
    const elapsed = Date.now() - this._lastFlushTime
    if (elapsed >= this._flushIntervalMs) {
      clearTimeout(this._flushTimer)
      this._flushWrites()
      return
    }
    if (!this._flushScheduled) {
      this._flushScheduled = true
      this._flushTimer = setTimeout(this._flushWrites, this._flushIntervalMs - elapsed)
    }
  }

  // Under heavy flood the producer outruns the renderer; once pending output
  // exceeds the cap we drop the OLDEST chunks (preserving the newest, visible
  // tail and the line currently being rewritten). The first kept chunk is
  // trimmed to the next newline so we never render a half line / broken escape.
  //
  // Dropping is lossy but must never corrupt the stream. The discarded tail
  // usually ended mid-repaint, so a surviving frame can still open with a
  // rewind (ESC[nA) or a cursor restore (ESC[8) aimed at output we never
  // wrote — left in, those yank the cursor back over already-rendered history
  // and overwrite it, which is far worse than the dropped data. Stripping them
  // (see stripLeadingCursorOps) degrades output to appending from wherever the
  // cursor actually is.
  _dropOldestUntil = () => {
    const buffered = this._writeBuffer.join('')
    if (buffered.length <= this._maxBufferChars) {
      return
    }
    const { output, dropped } = truncateTerminalOutput(buffered, this._maxBufferChars)
    this._writeBuffer = [output]
    this._bufferChars = output.length
    this._droppedChars += dropped
    if (!this._droppedWarned) {
      this._droppedWarned = true
      console.warn('[AttachAddon] Heavy output detected; coalescing writes and dropping intermediate output to keep the UI responsive.')
    }
  }

  _flushWrites = () => {
    this._flushScheduled = false
    this._flushTimer = null
    const buf = this._writeBuffer
    if (!buf.length || !this.term) {
      this._writeBuffer = []
      this._bufferChars = 0
      return
    }
    this._writeBuffer = []
    this._bufferChars = 0
    const data = buf.length === 1 ? buf[0] : buf.join('')
    const { term } = this
    this._lastFlushTime = Date.now()
    // The callback fires once xterm has parsed the chunk into the buffer; that
    // is the moment the prompt (and any echo) is actually on screen, which is
    // what _recordLineBaseline samples.
    term.write(data, this._recordLineBaseline)
    // Notify parent that the terminal buffer has been updated (echo received),
    // once per flush instead of once per chunk.
    term?.parent?.notifyOnData()
    term?.parent?.onTerminalWrite?.()
  }

  // Best-effort bookkeeping of what sits on the current command line. Only
  // answers "could there be input we saw no printable character for?"; whether
  // a newline is safe to send is decided by _lineHasUnsubmittedInput.
  _trackPendingInput = (data) => {
    if (typeof data !== 'string') {
      // Mouse reports in the default (X10) encoding arrive through
      // terminal.onBinary as a Uint8Array. They never type a character, and
      // this runs before _sendData, so throwing here would swallow the click.
      return
    }
    if (data.startsWith(ESC)) {
      // Cursor keys, history recall, bracketed paste: the resulting line
      // content is unknown (Up can put a whole command on the line).
      this._pendingInputUnknown = true
      return
    }
    for (const ch of data) {
      if (ch === '\r' || ch === '\n' || ch === '\x03' || ch === '\x15') {
        this._pendingInputLength = 0
        this._pendingInputUnknown = false
      } else if (ch === '\x7f' || ch === '\b') {
        this._pendingInputLength = Math.max(0, this._pendingInputLength - 1)
      } else if (ch >= ' ') {
        this._pendingInputLength += 1
      }
    }
  }

  sendToServer = (data) => {
    this._lastInputTime = Date.now()
    this._trackPendingInput(data)
    // Start echo detection when password prompt is suspected
    if (this._passwordPromptDetected && !this._pendingEchoCheck && data !== '\r' && data !== '\n' && data !== '\x03') {
      this._pendingEchoCheck = { char: data, time: Date.now() }
      clearTimeout(this._echoCheckTimer)
      this._echoCheckTimer = setTimeout(this._onEchoCheckTimeout, 200)
    }
    // Reset password state on Enter or Ctrl+C
    if (data === '\r' || data === '\n' || data === '\x03') {
      if (this._passwordPromptDetected) {
        this.term?.parent?.onPasswordPromptCancelled?.()
      }
      this._passwordPromptDetected = false
      this._lastOutputLine = ''
      this._pendingEchoCheck = null
      clearTimeout(this._echoCheckTimer)
      this._echoCheckTimer = null
    }
    this._sendData(data)
  }

  _startKeepalive = () => {
    this._stopKeepalive()
    this._keepaliveTimer = setInterval(this._checkKeepalive, this._keepaliveInterval)
  }

  _stopKeepalive = () => {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer)
      this._keepaliveTimer = null
    }
  }

  // The input line as the terminal renders it: absolute buffer row plus text,
  // trailing blanks trimmed. null when there is nothing to read (no terminal,
  // or a full-screen app owns the alternate screen).
  _readInputLine = () => {
    const buf = this.term?.buffer?.active
    if (!buf || buf.type === 'alternate' || typeof buf.getLine !== 'function') {
      return null
    }
    const row = (buf.baseY || 0) + (buf.cursorY || 0)
    const line = buf.getLine(row)
    return line ? { row, text: line.translateToString(true) } : null
  }

  // Sample the input line once xterm has parsed a chunk. While nothing is
  // pending this is a prompt with an empty line - exactly the state a keepalive
  // newline is harmless in - so it becomes the reference to compare against.
  // Skipped while input is pending or of unknown length, so the echo of what
  // the user typed (or a recalled command) never becomes the new reference.
  _recordLineBaseline = () => {
    if (this.disposed || this._pendingInputLength > 0 || this._pendingInputUnknown) {
      return
    }
    const info = this._readInputLine()
    this._lineBaseline = info ? { row: info.row, length: info.text.length } : null
  }

  // Would writing \n to the PTY submit something the user did not submit?
  _lineHasUnsubmittedInput = () => {
    // Never type into a password prompt: an empty password attempt can burn an
    // auth attempt (and retry limits), a skipped keepalive only risks an idle
    // timeout.
    if (this._passwordPromptDetected) {
      return true
    }
    // Typed characters with no echo back (read -s, a hidden prompt in a nested
    // program): the screen can not show them, only the byte count knows.
    if (this._pendingInputLength > 0) {
      return true
    }
    const buf = this.term?.buffer?.active
    if (buf && buf.type === 'alternate') {
      // vim/less/top own the screen; a newline there inserts a line or pages
      // forward instead of hitting an empty shell line.
      return true
    }
    const info = this._readInputLine()
    const base = this._lineBaseline
    if (!info || !base) {
      // No readable line yet: fall back to the keystroke tracking alone.
      return this._pendingInputUnknown
    }
    // A longer line than the bare prompt - or a line on a different row, which
    // is what a wrapped or recalled command looks like - means content.
    return info.row !== base.row || info.text.length > base.length
  }

  _checkKeepalive = () => {
    if (this.outputSuppressed) {
      return
    }
    // The keepalive makes the server write a newline to the PTY, which would
    // submit a command the user has typed but not yet run.
    if (this._lineHasUnsubmittedInput()) {
      return
    }
    const now = Date.now()
    const idleSinceData = now - this._lastDataTime
    const idleSinceInput = now - this._lastInputTime
    if (idleSinceData >= this._keepaliveInterval && idleSinceInput >= this._keepaliveInterval) {
      // Tell the server to write \n to the PTY so bash's read() wakes up and
      // resets the TMOUT alarm. The user has explicitly enabled keepalive and
      // accepts the side-effect of an occasional echoed newline / re-prompt.
      // Start output suppression to hide the echoed prompt.
      //
      // The window is a silent one: the heartbeat only makes the shell
      // redraw its prompt, and that redraw must not reach the screen at all
      // - writing it leaves a second prompt behind on every idle tick.
      const sock = this._socket
      if (sock && sock.readyState === 1 /* OPEN */) {
        this.startOutputSuppression(500, null, true, { silent: true })
        sock.send(JSON.stringify({ action: 'keepalive' }))
      }
    }
  }

  setKeepalive = (enabled) => {
    if (enabled) {
      this._startKeepalive()
    } else {
      this._stopKeepalive()
    }
  }

  addSocketListener = (socket, type, handler) => {
    socket.addEventListener(type, handler)
    return {
      dispose: () => {
        if (!handler) {
          return
        }
        socket.removeEventListener(type, handler)
      }
    }
  }

  dispose = () => {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this._stopKeepalive()
    clearTimeout(this._echoCheckTimer)
    this._echoCheckTimer = null
    // End any pending suppression *before* dropping `term`, so the callback
    // (and the promise the startup queue is awaiting) is released instead of
    // hanging forever on a connection that is already gone.
    this.stopOutputSuppression(true)
    this.onInitialDataCallback = null
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    this._flushScheduled = false
    this._writeBuffer = []
    this._bufferChars = 0
    this._dataTaps.clear()
    // Reset the streaming decoder so any partial multi-byte sequence held
    // over from this connection can not leak into a reused instance.
    this.decoder = new TextDecoder('utf-8')
    this.term = null
    this._disposables.forEach(d => d.dispose())
    this._disposables.length = 0
  }
}
