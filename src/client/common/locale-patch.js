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
  startupBookmarkAllMissingWithTab: '启动书签全部失效，已打开默认选项卡'
}

const enUs = {
  onStartBookmarksDesc: 'The selected bookmarks open on start; with nothing selected the app stays on the blank welcome page and opens no tab',
  startWithDefaultTab: 'open default tab when app start',
  startWithDefaultTabDesc: 'Applies only when no startup bookmark is selected; with bookmarks selected, only they open',
  startupBookmarkMissing: 'A startup bookmark no longer exists and was skipped',
  startupBookmarkAllMissing: 'All startup bookmarks are gone, no tab was opened',
  startupBookmarkAllMissingWithTab: 'All startup bookmarks are gone, a default tab was opened'
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
