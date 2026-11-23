/**
 * State of the "SFTP follows the terminal path" toggle.
 *
 * The toggle can be on while the feature does not work: the shell has to
 * report its working directory (OSC 633 `P;Cwd=` or OSC 1337 `CurrentDir`),
 * and a shell that cannot - or a server that blocks the injection - leaves
 * the file manager sitting in the home directory with no hint at all. The
 * icon therefore tells "off" from "on but nothing came in yet", so the user
 * can see that the toggle alone is not enough.
 *
 * @author xiaogui
 * @since 2026-11-23 11:24:30
 */

/**
 * The visible states of the follow toggle.
 *
 * @author xiaogui
 * @since 2026-11-23 11:25:02
 */
export const sftpFollowStates = {
  // the toggle is off
  off: 'off',
  // the toggle is on, the shell has not reported a directory yet
  pending: 'pending',
  // the toggle is on and the shell reports its directory
  on: 'on'
}

/**
 * Decide which state the follow toggle is in.
 *
 * A reported directory always wins: once the shell has spoken, the feature
 * works, no matter how long it took.
 *
 * @author xiaogui
 * @since 2026-11-23 11:25:44
 * @param {object} options
 * @param {boolean} options.enabled - the toggle is on
 * @param {string} options.cwd - the last directory the shell reported
 * @returns {string} one of sftpFollowStates
 */
export function resolveSftpFollowState ({ enabled, cwd } = {}) {
  if (!enabled) {
    return sftpFollowStates.off
  }
  return cwd ? sftpFollowStates.on : sftpFollowStates.pending
}
