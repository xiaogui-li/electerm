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
  onStartBookmarksDesc: '勾选书签后，启动时只打开这些书签，不再打开默认选项卡；未勾选时按「打开默认选项卡当应用启动时」开关处理',
  startupBookmarkMissing: '启动书签已失效，已跳过',
  startupBookmarkAllMissing: '启动书签全部失效，已按「打开默认选项卡当应用启动时」处理'
}

const enUs = {
  onStartBookmarksDesc: 'When bookmarks are selected, only they open on start; otherwise the "open default tab on start" switch applies',
  startupBookmarkMissing: 'A startup bookmark no longer exists and was skipped',
  startupBookmarkAllMissing: 'All startup bookmarks are gone, falling back to the "open default tab on start" switch'
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
