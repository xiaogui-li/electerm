/**
 * local locale patch
 *
 * The upstream language pack lives in the npm package
 * @electerm/electerm-locales, so texts introduced by fork-only features can
 * never reach it. This module overlays a few extra keys onto the loaded
 * language map, so window.translate keeps resolving them without touching
 * the upstream package.
 *
 * @author xiaogui
 * @since 2026-11-17 09:08:30
 */

const zhCn = {
  onStartBookmarksDesc: '勾选的书签会在启动时自动打开；一个都不勾选时，启动后停留在空白页，不会自动打开任何标签页',
  startWithDefaultTab: '启动时打开默认选项卡',
  startWithDefaultTabDesc: '没有勾选任何启动书签时生效；勾选了书签就只打开书签',
  startupBookmarkMissing: '启动书签已失效，已跳过',
  startupBookmarkAllMissing: '启动书签全部失效，未打开任何标签页',
  startupBookmarkAllMissingWithTab: '启动书签全部失效，已打开默认选项卡',
  // the heart icon in the session toolbar. No upstream language pack has a
  // "keepalive" key, so the tooltip used to show the bare key.
  keepalive: 'Keepalive',
  // fork: the session heartbeat (the heart icon), not the transport probe
  defaultKeepalive: '默认开启 Keepalive',
  defaultKeepaliveDesc: '新开的标签页默认打开会话心跳（工具栏里的心形图标），省得每个标签页都点一次；与下面的「Keepalive 间隔」不是一回事，后者是 SSH 传输层探活',
  keepaliveMode: 'Keepalive 模式',
  keepaliveModeInherit: '跟随全局设置',
  keepaliveModeOn: '总是开启',
  keepaliveModeOff: '总是关闭'
}

const enUs = {
  onStartBookmarksDesc: 'The selected bookmarks open on start; with nothing selected the app stays on the blank welcome page and opens no tab',
  startWithDefaultTab: 'open default tab when app start',
  startWithDefaultTabDesc: 'Applies only when no startup bookmark is selected; with bookmarks selected, only they open',
  startupBookmarkMissing: 'A startup bookmark no longer exists and was skipped',
  startupBookmarkAllMissing: 'All startup bookmarks are gone, no tab was opened',
  startupBookmarkAllMissingWithTab: 'All startup bookmarks are gone, a default tab was opened',
  keepalive: 'Keepalive',
  defaultKeepalive: 'enable keepalive by default',
  defaultKeepaliveDesc: 'New tabs start with the session heartbeat (the heart icon in the toolbar) already on, so it does not have to be clicked per tab. This is not the "Keepalive interval" below - that one is the SSH transport level probe',
  keepaliveMode: 'keepalive mode',
  keepaliveModeInherit: 'follow the global setting',
  keepaliveModeOn: 'always on',
  keepaliveModeOff: 'always off'
}

// languages without a local translation fall back to English: a readable
// sentence is better than the raw key leaking into the UI
const patch = {
  zh_cn: zhCn,
  zh_tw: zhCn,
  en_us: enUs
}

/**
 * Overlay the local texts onto every language of the given language map.
 * Existing upstream translations are never overwritten.
 * @author xiaogui
 * @since 2026-11-17 09:08:30
 * @param {object} langMap the language map loaded from the upstream package
 * @returns {object} the same langMap, patched in place
 */
export function applyLocalePatch (langMap) {
  if (!langMap) {
    return langMap
  }
  Object.keys(langMap).forEach(id => {
    const lang = langMap[id]?.lang
    if (!lang) {
      return
    }
    const add = patch[id] || patch.en_us
    Object.keys(add).forEach(key => {
      if (!lang[key]) {
        lang[key] = add[key]
      }
    })
  })
  return langMap
}
