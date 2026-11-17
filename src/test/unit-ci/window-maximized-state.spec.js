/**
 * The window remembers whether it was maximized when the app was closed, so
 * the next launch opens it the same way.
 *
 * The state lives in the main process only: the renderer has to guess the
 * maximized state from the window size, and on Windows a maximized window's
 * bounds do not match the work area (the invisible resize border makes them
 * larger), so the guess is wrong exactly when it matters.
 *
 * These tests drive src/app/lib/window-control.js with a fake last-state
 * store and a fake screen, so neither Electron nor a database is needed.
 */

const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const appLib = path.resolve(__dirname, '../../app/lib')

const lastStateStore = new Map()
const lastStateWrites = []

const fakeLastState = {
  set: (key, value) => {
    lastStateWrites.push({ key, value })
    lastStateStore.set(key, value)
    return Promise.resolve()
  },
  get: async key => (lastStateStore.has(key) ? lastStateStore.get(key) : null),
  clear: async key => {
    lastStateStore.delete(key)
  }
}

const primaryDisplay = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  workAreaSize: { width: 1920, height: 1040 },
  scaleFactor: 1
}

const fakeElectron = {
  screen: {
    getDisplayMatching: () => primaryDisplay,
    getDisplayNearestPoint: () => primaryDisplay,
    getAllDisplays: () => [primaryDisplay],
    getPrimaryDisplay: () => primaryDisplay
  }
}

function inject (id, exports) {
  const filename = require.resolve(id)
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
    children: [],
    paths: []
  }
}

inject('electron', fakeElectron)
inject(path.join(appLib, 'last-state.js'), fakeLastState)
// runtime-constants reads src/app/package.json, which only exists in a built
// app; the values that matter here are the window minimums.
inject(path.join(appLib, '..', 'common', 'runtime-constants.js'), {
  isDev: false,
  minWindowWidth: 320,
  minWindowHeight: 400
})

const windowControl = require(path.join(appLib, 'window-control.js'))
const globalState = require(path.join(appLib, 'glob-state.js'))

describe('the maximized state of the window', () => {
  beforeEach(() => {
    lastStateStore.clear()
    lastStateWrites.length = 0
    globalState.set('win', null)
  })

  test('remembers that the window was maximized', () => {
    windowControl.setWindowMaximized(true)
    assert.deepEqual(lastStateWrites, [
      { key: 'windowState', value: { maximized: true } }
    ])
  })

  test('remembers that the window was restored', () => {
    windowControl.setWindowMaximized(false)
    assert.deepEqual(lastStateWrites, [
      { key: 'windowState', value: { maximized: false } }
    ])
  })

  test('opens un-maximized when nothing was remembered', async () => {
    // The very first launch: there is no record, so the default behaviour
    // applies and the window is not maximized.
    const result = await windowControl.getWindowSizeDep()
    assert.equal(result.maximized, false)
  })

  test('opens maximized when the window was maximized when the app closed', async () => {
    lastStateStore.set('windowState', { maximized: true })
    const result = await windowControl.getWindowSizeDep()
    assert.equal(result.maximized, true)
  })

  test('opens un-maximized when the window was restored before the app closed', async () => {
    lastStateStore.set('windowState', { maximized: false })
    const result = await windowControl.getWindowSizeDep()
    assert.equal(result.maximized, false)
  })

  test('keeps the position of a maximized window', () => {
    // A maximized window sits at the corner of its display, not where the
    // user put it: storing that would move the window to the corner of the
    // screen on the next launch.
    globalState.set('win', { isMaximized: () => true })
    windowControl.setWindowPos({ x: 100, y: 120 })
    assert.deepEqual(lastStateWrites, [])
  })

  test('keeps the position of a normal window', () => {
    globalState.set('win', { isMaximized: () => false })
    windowControl.setWindowPos({ x: 100, y: 120 })
    assert.deepEqual(lastStateWrites, [
      { key: 'windowPos', value: { x: 100, y: 120 } }
    ])
  })

  test('does not save the geometry of a maximized window', () => {
    globalState.set('win', { isMaximized: () => true })
    assert.equal(windowControl.canSaveWindowGeometry(), false)

    globalState.set('win', { isMaximized: () => false })
    assert.equal(windowControl.canSaveWindowGeometry(), true)

    // No window yet (the geometry is read before it is created).
    globalState.set('win', null)
    assert.equal(windowControl.canSaveWindowGeometry(), true)
  })
})
