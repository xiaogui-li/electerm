/**
 * CommandTrackerAddon - Tracks the current command in the terminal
 *
 * This addon uses Shell Integration via OSC 633 escape sequences for reliable
 * command tracking. The shell emits special sequences that tell us:
 * - OSC 633 ; A - Prompt started
 * - OSC 633 ; B - Command input started (ready for typing)
 * - OSC 633 ; C - Command execution started (output begins)
 * - OSC 633 ; D ; <exitCode> - Command finished
 * - OSC 633 ; E ; <command> - The command line being executed
 * - OSC 633 ; P ; Cwd=<path> - Current working directory
 *
 * This properly handles:
 * - Command history (arrow up/down)
 * - Tab completion
 * - Paste operations
 * - Shell-side editing (readline, vi-mode)
 * - Multi-line commands
 * - Any custom prompt
 */

export class CommandTrackerAddon {
  constructor () {
    this.terminal = undefined
    this._disposables = []

    // Shell integration state
    this.currentCommand = '' // Command being typed
    this.executedCommand = '' // Last executed command
    this.lastExitCode = null
    this.cwd = ''
    this.shellIntegrationActive = false

    // Event callbacks for shell integration events
    this._onCommandExecuted = null // Called when OSC 633;E is received
    this._onCwdChanged = null // Called when OSC 633;P;Cwd= is received
    // Multi-subscriber "a fresh prompt was drawn" signal. Used to pace
    // scripted input: OSC 633;A means the previous command has finished and
    // the shell is ready for the next one.
    this._promptListeners = new Set()
  }

  /**
   * Subscribe to "prompt started" (OSC 633;A).
   * @param {function} callback
   * @returns {function} unsubscribe
   */
  onPrompt (callback) {
    if (typeof callback !== 'function') {
      return () => {}
    }
    this._promptListeners.add(callback)
    return () => {
      this._promptListeners.delete(callback)
    }
  }

  /**
   * Register callback for when a command is executed (received via OSC 633;E)
   * @param {function} callback - Called with (command: string)
   */
  onCommandExecuted (callback) {
    this._onCommandExecuted = callback
  }

  /**
   * Register callback for when CWD changes (received via OSC 633;P;Cwd=)
   * @param {function} callback - Called with (cwd: string)
   */
  onCwdChanged (callback) {
    this._onCwdChanged = callback
  }

  /**
   * Register the OSC handlers and start listening.
   *
   * @author xiaogui
   * @since 2026-11-23 11:17:27
   * @param {object} terminal - the xterm instance
   */
  activate (terminal) {
    this.terminal = terminal

    // Register OSC 633 handler for shell integration
    // OSC 633 is the VS Code / modern terminal shell integration protocol
    if (terminal.parser && terminal.parser.registerOscHandler) {
      const oscHandler = terminal.parser.registerOscHandler(633, (data) => {
        return this._handleOsc633(data)
      })
      this._disposables.push(oscHandler)
      // OSC 1337 is iTerm2's own protocol. Its CurrentDir key carries the
      // working directory, so a host that already reports it (a profile
      // copied from iTerm2, or any tool following the iTerm2 convention)
      // now drives the SFTP follow feature on its own - electerm does not
      // have to inject anything for it.
      const itermHandler = terminal.parser.registerOscHandler(1337, (data) => {
        return this._handleOsc1337(data)
      })
      this._disposables.push(itermHandler)
    }
  }

  dispose () {
    this.terminal = null
    this._promptListeners.clear()
    this._onCommandExecuted = null
    this._onCwdChanged = null
    if (this._disposables) {
      this._disposables.forEach(d => d.dispose())
      this._disposables.length = 0
    }
  }

  /**
   * Handle OSC 633 shell integration sequences
   * @param {string} data - The OSC data after "633;"
   * @returns {boolean} Whether the sequence was handled
   */
  _handleOsc633 (data) {
    if (!data) return false

    // Parse the sequence: first char is the command type
    const command = data.charAt(0)
    const args = data.length > 1 ? data.substring(2) : '' // Skip "X;" part

    switch (command) {
      case 'A': { // Prompt started — the previous command is done
        this.shellIntegrationActive = true
        // Reset current command when new prompt appears
        this.currentCommand = ''
        for (const cb of this._promptListeners) {
          try {
            cb()
          } catch (e) {
            console.error('[CommandTracker] prompt listener failed', e)
          }
        }
        return true
      }

      case 'B': // Command input started (after prompt)
        return true

      case 'C': // Command execution started
        return true

      case 'D': // Command finished
        // Parse exit code if provided
        if (args) {
          this.lastExitCode = parseInt(args, 10)
        } else {
          this.lastExitCode = null
        }
        return true

      case 'E': // Command line
        // The actual command being executed
        this.executedCommand = this._deserializeOscValue(args)
        this.currentCommand = this.executedCommand
        // Call the callback if registered
        if (this._onCommandExecuted && this.executedCommand) {
          this._onCommandExecuted(this.executedCommand)
        }
        return true

      case 'P': // Property (e.g., Cwd=<path>)
        this._handleProperty(args)
        return true

      default:
        return false
    }
  }

  /**
   * Handle the iTerm2 OSC 1337 sequence.
   *
   * The payload holds several `key=value` pairs separated by `;`, e.g.
   * `CurrentDir=/tmp;ShellIntegrationVersion=1`. Only CurrentDir matters here.
   *
   * @author xiaogui
   * @since 2026-11-23 11:18:03
   * @param {string} data - The OSC data after "1337;"
   * @returns {boolean} Whether the sequence was handled
   */
  _handleOsc1337 (data) {
    if (!data) return false
    const cwd = this._parseOsc1337CurrentDir(data)
    if (!cwd) return false
    this._applyCwd(cwd)
    return true
  }

  /**
   * Pull the CurrentDir value out of an OSC 1337 payload.
   *
   * iTerm2 sends the path raw: unlike the OSC 633 `Cwd=` value, which the
   * shell side escapes (`\` -> `\\`, `;` -> `\x3b`), there is nothing to
   * unescape here - a path that contains a backslash stays as it is.
   *
   * @author xiaogui
   * @since 2026-11-23 11:18:41
   * @param {string} data - The OSC data after "1337;"
   * @returns {string} The raw path, or '' when the key is absent
   */
  _parseOsc1337CurrentDir (data) {
    const match = /CurrentDir=([^;]*)/.exec(String(data))
    return match ? match[1] : ''
  }

  /**
   * Record a new working directory and notify the listener.
   *
   * Shared by the OSC 633 `P;Cwd=` property and the OSC 1337 `CurrentDir`
   * key: both are real path reports and only differ in how the value is
   * escaped, so they end up in the same place.
   *
   * @author xiaogui
   * @since 2026-11-23 11:19:15
   * @param {string} value - The unescaped path
   */
  _applyCwd (value) {
    const oldCwd = this.cwd
    this.cwd = value
    // Call the callback if registered and CWD actually changed
    if (this._onCwdChanged && oldCwd !== value) {
      this._onCwdChanged(value)
    }
  }

  /**
   * Handle OSC 633 ; P property sequences
   * @param {string} data - Property data like "Cwd=/path/to/dir"
   */
  _handleProperty (data) {
    const eqIndex = data.indexOf('=')
    if (eqIndex === -1) return

    const key = data.substring(0, eqIndex)
    const value = this._deserializeOscValue(data.substring(eqIndex + 1))

    switch (key) {
      case 'Cwd': {
        this._applyCwd(value)
        break
      }
      // Add more properties as needed
    }
  }

  /**
   * Deserialize OSC 633 escaped values
   * Handles: \\ -> \, \x3b -> ;
   *
   * Single pass on purpose: two chained regexes cannot tell an escaped
   * backslash from the start of an escape sequence once they are applied one
   * after the other. A Windows cwd like `D:\x86\build` (emitted as
   * `D:\\x86\\build`) was read back as `D:\x86\build` -> `D:V\build`, because
   * the `\x..` pass ran before `\\` was collapsed.
   * @param {string} value - Escaped value
   * @returns {string} Unescaped value
   */
  _deserializeOscValue (value) {
    if (!value) return ''
    let out = ''
    for (let i = 0; i < value.length; i++) {
      const char = value[i]
      if (char !== '\\') {
        out += char
        continue
      }
      const next = value[i + 1]
      if (next === '\\') {
        out += '\\'
        i++
        continue
      }
      const hex = value.substr(i + 2, 2)
      if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        i += 3
        continue
      }
      out += char
    }
    return out
  }

  /**
   * Get the current command (from shell integration)
   */
  getCurrentCommand () {
    return this.executedCommand || this.currentCommand || ''
  }

  /**
   * Get the last exit code (if available via shell integration)
   */
  getLastExitCode () {
    return this.lastExitCode
  }

  /**
   * Get current working directory (if available via shell integration)
   */
  getCwd () {
    return this.cwd
  }

  /**
   * Check if shell integration is active
   */
  hasShellIntegration () {
    return this.shellIntegrationActive
  }
}
