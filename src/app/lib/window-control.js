/**
 * manage window size save read and set
 */

const lastStateManager = require('./last-state')
const {
  isDev,
  minWindowWidth,
  minWindowHeight
} = require('../common/runtime-constants')
const globalState = require('./glob-state')
const { resolveWindowStartup } = require('./window-restore')

exports.getScreenCurrent = () => {
  const rect = globalState.get('win')
    ? globalState.get('win').getBounds()
    : {
        x: 0,
        y: 0,
        height: minWindowHeight,
        width: minWindowWidth
      }
  const { screen } = require('electron')
  return screen.getDisplayMatching(rect)
}

exports.getScreenSize = () => {
  const screen = exports.getScreenCurrent()
  return {
    ...screen.workAreaSize,
    x: screen.workArea.x,
    y: screen.workArea.y
  }
}

exports.maximize = () => {
  const win = globalState.get('win')
  // Keep the rectangle the window had before it was maximized: restoring it
  // later must bring back the size the user picked, not the screen.
  if (!win.isMaximized()) {
    globalState.set('oldRectangle', win.getBounds())
  }
  win.maximize()
}

exports.unmaximize = () => {
  const oldRectangle = globalState.get('oldRectangle') || {
    width: minWindowWidth,
    height: minWindowHeight,
    x: 200,
    y: 200
  }
  globalState.get('win').unmaximize()
  globalState.get('win').setBounds(oldRectangle)
}

/**
 * Remember whether the window was maximized, so the next launch can open it
 * the same way.
 *
 * Only the main process may write this: the renderer has to guess the state
 * from the window size, and on Windows a maximized window's bounds do not
 * match the work area (the invisible resize border makes them larger), so
 * the guess is wrong exactly when it matters.
 *
 * @author xiaogui
 * @since 2026-11-17 15:38:24
 * @param {boolean} maximized
 */
exports.setWindowMaximized = (maximized) => {
  lastStateManager.set('windowState', { maximized: !!maximized })
}

// macOS only. After switching between apps in native fullscreen, the Spaces
// transition can leave the window frame itself stuck at an intermediate
// (about half height) size — no resize event follows, and the terminal keeps
// rendering in the top half. When fullscreen content bounds do not cover the
// screen, snap the window back to the full screen bounds; the resulting
// resize event lets the renderer recover with its normal logic.
exports.repairFullScreenGeometry = () => {
  const win = globalState.get('win')
  if (!win || !win.isFullScreen()) {
    return false
  }
  const { screen } = require('electron')
  const display = screen.getDisplayMatching(win.getBounds())
  const { width, height } = win.getContentBounds()
  const { width: screenWidth, height: screenHeight } = display.bounds
  // Small tolerance for the menu bar / rounding on some displays.
  if (width >= screenWidth - 2 && height >= screenHeight - 2) {
    return false
  }
  win.setBounds(display.bounds)
  return true
}

exports.getWindowSize = async () => {
  return exports.getWindowSizeDep()
}

exports.getWindowSizeDep = async () => {
  const windowSizeLastState = await lastStateManager.get('windowSize')
  const windowPosLastState = await lastStateManager.get('windowPos')
  const windowState = await lastStateManager.get('windowState')
  const { screen } = require('electron')
  return resolveWindowStartup({
    // No record at all means the very first launch, which keeps the default
    // behaviour: the window opens maximized=false.
    savedMaximized: !!(windowState && windowState.maximized),
    screen,
    windowSizeLastState,
    windowPosLastState,
    isDev,
    minWindowWidth,
    minWindowHeight
  })
}

/**
 * Whether the window geometry may be stored right now.
 *
 * A maximized window reports the size of the screen, not the size the user
 * picked, and sits at the corner of its display rather than where the user
 * put it. Storing that would make the next launch open a screen-filling
 * window that can no longer be restored to a normal size.
 *
 * @author xiaogui
 * @since 2026-11-17 15:58:27
 * @returns {boolean}
 */
exports.canSaveWindowGeometry = () => {
  const win = globalState.get('win')
  return !(win && win.isMaximized())
}

exports.setWindowPos = (pos) => {
  if (!exports.canSaveWindowGeometry()) {
    return
  }
  lastStateManager.set('windowPos', pos)
}
