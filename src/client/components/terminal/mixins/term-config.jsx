import message from '../../common/message'
import ExternalLink from '../../common/external-link.jsx'
import { isWin, rendererTypes } from '../../../common/constants.js'
import {
  getWebglCircuitSnapshot,
  resetWebglCircuit
} from '../terminal-webgl-circuit-breaker.mjs'

/**
 * Reacting to config changes that cannot be handled by a re-render: they need
 * the live xterm instance (font/renderer) or the shell integration sequence.
 */

// The shell integration is injected right after the toggle is switched on and
// the directory only arrives with the next prompt, so the check waits a moment
// before it tells the user that nothing came in.
const sftpFollowCheckDelayMs = 5000

export const configMixin = {
  getValue (props, type, name) {
    return type === 'glob'
      ? props.config[name]
      : props.tab[name] || props.config[name]
  },

  checkConfigChange (prevProps, props) {
    for (const k of this.terminalConfigProps) {
      const { name, type } = k
      const prev = this.getValue(prevProps, type, name)
      const curr = this.getValue(props, type, name)
      if (
        prev !== curr
      ) {
        this.term.options[name] = curr
        if (['fontFamily', 'fontSize'].includes(name)) {
          this.onResize()
        }
        if (name === 'fontSize') {
          this.originalFontSize = curr
          this.setState({ fontSizeChanged: false })
        }
      }
    }

    // Handle renderer type changes (dom <-> webGL) by letting the lifecycle
    // controller pick the new renderer, then refreshing the theme so the
    // background color matches the renderer actually in use.
    // WebGL -> DOM never resets anything; DOM -> WebGL is the only runtime
    // reset of the page-level circuit breaker and of this terminal's
    // activation-failure flag (the two are reset together, nowhere else).
    const prevRendererType = prevProps.config.rendererType
    const nextRendererType = props.config.rendererType
    if (
      prevRendererType !== nextRendererType &&
      this.term
    ) {
      if (
        prevRendererType === rendererTypes.dom &&
        nextRendererType === rendererTypes.webGL
      ) {
        // The flag must be cleared first: resetWebglCircuit() broadcasts
        // synchronously, so this terminal's own subscription re-enters
        // reconcileRenderer at that instant. While the flag is still true that
        // re-entry reads a target which is about to be overruled and runs a
        // pointless deactivate.
        this.webglActivationFailed = false
        resetWebglCircuit()
      }
      this.webglCircuitState = getWebglCircuitSnapshot().state
      this.reconcileRenderer('renderer type change')
        .then(() => this.applyTerminalTheme())
        .catch(e => console.error('renderer type change failed', e))
    }

    // Check for shell integration related config changes
    const prevShowSuggestions = prevProps.config.showCmdSuggestions
    const currShowSuggestions = props.config.showCmdSuggestions
    const prevSftpFollow = prevProps.sftpPathFollowSsh
    const currSftpFollow = props.sftpPathFollowSsh
    const prevRestoreTerminal = prevProps.config.restoreTerminalSessionOnReload
    const currRestoreTerminal = props.config.restoreTerminalSessionOnReload

    if (
      (!prevShowSuggestions && currShowSuggestions) ||
      (!prevSftpFollow && currSftpFollow) ||
      (!prevRestoreTerminal && currRestoreTerminal)
    ) {
      // Config was toggled to true, try to inject shell integration if not already done
      if (this.startupQueue.canInjectShellIntegration() && !this.startupQueue.shellInjected) {
        this.startupQueue.enqueueShellIntegration(currSftpFollow)
      } else if (this.startupQueue.shellInjected && currSftpFollow) {
        this.getCwd()
      }
    }
    if (
      !prevSftpFollow &&
      currSftpFollow &&
      this.isLocal() &&
      isWin &&
      // PowerShell reports its cwd (see shell.js), so the follow feature does
      // work there; only the shells that cannot report one are unsupported.
      this.startupQueue.getLocalShellType() !== 'powershell'
    ) {
      return this.warnSftpFollowUnsupported()
    }
    // The follow feature only works while the shell reports its working
    // directory. When the toggle is switched on and nothing arrives, say
    // so - otherwise the file manager just stays in the home directory with
    // no hint at all.
    if (!prevSftpFollow && currSftpFollow) {
      this.scheduleSftpFollowCheck()
    }
  },

  /**
   * Warn when the follow feature is on but the shell reports no directory.
   *
   * The shell integration is injected right after the toggle is switched on
   * and the directory arrives one prompt later, so the check waits before it
   * calls the feature broken.
   *
   * @author xiaogui
   * @since 2026-11-23 11:29:40
   */
  scheduleSftpFollowCheck () {
    clearTimeout(this.timers.sftpFollowCheck)
    this.timers.sftpFollowCheck = setTimeout(() => {
      this.timers.sftpFollowCheck = null
      if (this.startupQueue?.isClosed()) {
        return
      }
      // A reported directory is what the feature needs. The shell
      // integration flag alone is not enough: OSC 1337 reports a directory
      // without ever setting that flag.
      if (this.cmdAddon?.getCwd() || this.cmdAddon?.hasShellIntegration()) {
        return
      }
      message.warning(
        <span>
          {window.translate('sftpFollowSshNotWorking')}. See: <ExternalLink to='https://github.com/electerm/electerm/wiki/Warning-about-sftp-follow-ssh-path-function'>wiki</ExternalLink>
        </span>
        , 8)
    }, sftpFollowCheckDelayMs)
  },

  warnSftpFollowUnsupported () {
    message.warning(
      <span>
        Fish shell/windows shell is not supported for SFTP follow SSH path feature. See: <ExternalLink to='https://github.com/electerm/electerm/wiki/Warning-about-sftp-follow-ssh-path-function'>wiki</ExternalLink>
      </span>
      , 7)
  }
}
