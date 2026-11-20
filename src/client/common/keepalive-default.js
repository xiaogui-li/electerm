/**
 * Keepalive default resolution.
 *
 * Two different things in electerm are called "keepalive" and they must not
 * be mixed up:
 *
 *   - the transport level probe (`config.keepaliveInterval`, sent by the ssh2
 *     client in the server process), and
 *   - the per session heartbeat (the heart icon in the session toolbar),
 *     which makes the server write a newline into the PTY so the shell's
 *     idle timer (TMOUT) is reset.
 *
 * This module resolves the second one: whether a freshly opened session
 * should start with the heartbeat on.
 *
 * The heartbeat flag on a tab (`tab.keepaliveEnabled`) is runtime state - it
 * says what the terminal is actually doing right now. A value already stored
 * there means the user made a decision for this tab (the heart icon or the
 * MCP tool), and that decision is never overridden.
 *
 * Dependency-free on purpose: it is imported by the client bundle and loaded
 * directly by the unit tests in src/test/unit-ci.
 */

// The three states a bookmark can be in. `inherit` means "no opinion", the
// global switch decides.
export const keepaliveModeValues = {
  inherit: 'inherit',
  on: 'on',
  off: 'off'
}

/**
 * Work out whether a session should start with the heartbeat enabled.
 *
 * Precedence, strongest first:
 *   1. an explicit per tab state (the user clicked the heart icon) wins,
 *      because it is the only thing that reflects the live terminal;
 *   2. the bookmark override (`on` / `off`);
 *   3. the global switch.
 *
 * @author xiaogui
 * @since 2026-11-19 16:33:00
 * @param {object} opts
 * @param {boolean|undefined} opts.tabKeepaliveEnabled the live flag of the
 *   tab, undefined when the user never touched it
 * @param {string|undefined} opts.tabKeepaliveMode the bookmark override,
 *   one of keepaliveModeValues
 * @param {boolean|undefined} opts.globalDefault the global switch
 * @returns {boolean} true when the heartbeat should be on
 */
export function resolveKeepaliveStart ({
  tabKeepaliveEnabled,
  tabKeepaliveMode,
  globalDefault
} = {}) {
  if (tabKeepaliveEnabled === true) {
    return true
  }
  if (tabKeepaliveEnabled === false) {
    return false
  }
  if (tabKeepaliveMode === keepaliveModeValues.on) {
    return true
  }
  if (tabKeepaliveMode === keepaliveModeValues.off) {
    return false
  }
  return globalDefault === true
}

/**
 * The bookmark override a new bookmark starts with. `inherit` keeps the
 * global switch in charge until the user says otherwise.
 *
 * @author xiaogui
 * @since 2026-11-19 16:33:00
 * @returns {string} one of keepaliveModeValues
 */
export function defaultKeepaliveMode () {
  return keepaliveModeValues.inherit
}
