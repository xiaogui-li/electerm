/**
 * widgets related functions
 */

import message from '../components/common/message'
import {
  settingMap,
  settingPanelMobileBreakpoint
} from '../common/constants'
import getInitItem from '../common/init-setting-item'
import deepCopy from 'json-deep-copy'
import generate from '../common/uid'
import { noteWidgets } from '../common/credential-provider.jsx'
import { safeGetItemJSON, safeSetItemJSON } from '../common/safe-local-storage'
import { currentLang, localizeWidgetInfo } from '../common/widget-i18n'
import {
  withPersistedApiKeys
} from '../common/widget-api-key'
import {
  stripApiKeys,
  dedupeAutoRunWidgets,
  upsertAutoRunWidget
} from '../common/widget-auto-run-utils'

const builtinNameKeys = new Map([
  ['batch-op', 'batchOperation'],
  ['local-file-server', 'staticFileServer'],
  ['local-ftp-server', 'localFtpServer'],
  ['mcp-server', 'mcpServer'],
  ['rename', 'fileRenamer'],
  ['ssh-server', 'sshServer']
])

function builtinName (widgetId, fallback) {
  const key = builtinNameKeys.get(widgetId)
  return window.getLang()?.[key] ? window.translate(key) : fallback
}

// A widget with its own UI has no generated form: it keeps its config through
// window.electerm.updateConfig, which lands in localStorage. Autorun should
// start with the latest values (e.g. a provider switched in the widget panel),
// not with the config snapshot taken when it was first started.
function savedWidgetConfig (widgetId) {
  const stored = safeGetItemJSON(`widget-config-${widgetId}`, {})
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
}

// The widget manifests, as the main process reported them. Which config
// fields hold a secret is decided by the manifest, so the launch list has to
// know it before it can keep a key out of the db or resolve one on a start.
const widgetConfigs = new Map()

/**
 * The manifest config entries of a widget.
 * @param {string} widgetId the widget id
 * @return {object[]} the config entries, empty when the widget is unknown
 * @author xiaogui
 * @since 2026-11-20 12:42:45
 */
function configsOf (widgetId) {
  return widgetConfigs.get(widgetId) || []
}

export default Store => {
  Store.prototype.listWidgets = async () => {
    const widgets = await window.pre.runGlobalAsync('listWidgets')
    // remember the manifests: the launch list needs them to know which config
    // fields hold a secret
    for (const widget of widgets || []) {
      widgetConfigs.set(widget.id, (widget.info && widget.info.configs) || [])
    }
    // The manifest is English; a widget may ship its own translations in
    // electerm.i18n. The language lives here, in the renderer, so apply it
    // before any panel or list sees the info object.
    const lang = currentLang()
    const localized = widgets.map(widget => ({
      ...widget,
      info: widget.builtin
        ? { ...widget.info, name: builtinName(widget.id, widget.info.name) }
        : localizeWidgetInfo(widget.info, lang)
    }))
    // a password manager widget among them (bookmark form, connect)
    noteWidgets(localized)
    return localized
  }

  Store.prototype.runWidget = async (widgetId, config) => {
    // If this is MCP server widget, initialize MCP handler first
    if (widgetId === 'mcp-server') {
      window.store.initMcpHandler()
    }
    const result = await window.pre.runGlobalAsync('runWidget', widgetId, config)
    if (result && result.instanceId) {
      // the instance is the main process's, so re-read the list instead of
      // assembling one here (see refreshWidgetInstances)
      await window.store.refreshWidgetInstances()
    }
    return result
  }

  /**
   * Mirror the main process's running instances into the store.
   *
   * An instance only exists in the main process, so the renderer must not build
   * its own list from run results: a page reload (or a second window) would
   * then show nothing as running while the instances are still alive — and the
   * sidebar badge, the Run/Stop button and the instance detail panel all read
   * this array. Every start and stop path ends here.
   *
   * `autoRun` is the one field the renderer owns (store.autoRunWidgets), so it
   * is merged in rather than asked for.
   */
  Store.prototype.refreshWidgetInstances = async function () {
    const { store } = window
    let list
    try {
      list = await window.pre.runGlobalAsync('listWidgetInstances')
    } catch (err) {
      console.error('Failed to list widget instances:', err)
      return
    }
    const autoRun = new Map()
    for (const item of store.autoRunWidgets || []) {
      autoRun.set(item.widgetId, item)
    }
    store.widgetInstances = (list || []).map(item => {
      const auto = autoRun.get(item.widgetId)
      return {
        id: item.instanceId,
        title: `${builtinName(item.widgetId, item.name)} (${item.instanceId})`,
        widgetId: item.widgetId,
        serverInfo: item.serverInfo,
        // an AI config the widget offered to apply, whitelisted in the main
        // process (app/widgets/ai-config.js)
        aiConfig: item.aiConfig,
        config: item.config,
        startedAt: item.startedAt,
        autoRun: !!auto,
        autoRunId: auto ? auto.id : undefined
      }
    })
  }

  // Drop one renderer-side entry. Only for reconciling a row whose instance the
  // main process no longer has (crash, re-import): everything else reads the
  // list back from the main process instead (refreshWidgetInstances).
  Store.prototype.dropWidgetInstance = (instanceId) => {
    const {
      widgetInstances
    } = window.store
    // assigned, not spliced: an in-place mutation fires no subscriber, and the
    // instance list, the sidebar badge and the detail panel all read this array
    window.store.widgetInstances = widgetInstances.filter(w => w.id !== instanceId)
  }

  /**
   * Delete a running instance — the × on its row, labelled "delete", so it has
   * to stay deleted.
   *
   * Stopping alone is not enough: the widget is also in the launch list
   * (store.autoRunWidgets), and a reload starts everything in it, which put the
   * row straight back — that is why the green "autoRun" tag is the tell. So
   * stop it *and* take it out of the launch list.
   */
  Store.prototype.deleteWidgetInstance = async (instanceId) => {
    const { store } = window
    const instance = store.widgetInstances.find(w => w.id === instanceId)
    if (!instance) {
      return
    }
    const stopped = await store.stopWidget(instanceId)
    if (!stopped) {
      // still running: leave the launch entry alone rather than half-delete
      return
    }
    store.setWidgetAutoRun(instance.widgetId, false)
    if (store.settingItem && store.settingItem.id === instanceId) {
      store.closeWidgetInstance()
    }
  }

  // Selecting a running instance in the widgets list shows its detail + log in
  // the right column, the same way selecting a widget shows its run form.
  Store.prototype.selectWidgetInstance = (instance) => {
    const { store } = window
    store.setSettingItem(instance)
    // narrow panels drill into the right col content after picking an instance
    if (window.store.innerWidth <= settingPanelMobileBreakpoint) {
      window.store.settingMobileView = 'content'
    }
  }

  // back to the widget form — used when the instance being viewed is gone
  Store.prototype.closeWidgetInstance = () => {
    const { store } = window
    store.setSettingItem(getInitItem([], settingMap.widgets))
  }

  Store.prototype.stopWidget = async (instanceId) => {
    const {
      store
    } = window
    try {
      // the main process answers undefined for an instance it has already
      // lost, which is a stop that succeeded as far as the renderer cares: the
      // refresh below then drops the stale row
      await window.pre.runGlobalAsync('stopWidget', instanceId)
    } catch (err) {
      console.error('stopWidget error', err)
      message.error('Failed to stop widget: ' + err.message)
      return false
    }
    await store.refreshWidgetInstances()
    return true
  }

  Store.prototype.runWidgetFunc = async (instanceId, funcName, ...args) => {
    return window.pre.runGlobalAsync('runWidgetFunc', instanceId, funcName, ...args)
  }

  // Apply the AI config a widget proposed with its result (see
  // app/widgets/ai-config.js, which whitelists the fields in the main process).
  // The renderer writes it, on purpose: store.config is what the AI settings
  // form edits and what the watcher persists, so a widget's offer goes through
  // exactly the same path as a hand-typed one instead of around it.
  Store.prototype.applyWidgetAIConfig = (aiConfig) => {
    if (!aiConfig || typeof aiConfig !== 'object') {
      return
    }
    const patch = {}
    for (const key of Object.keys(aiConfig)) {
      if (typeof aiConfig[key] === 'string') {
        patch[key] = aiConfig[key]
      }
    }
    if (!Object.keys(patch).length) {
      return
    }
    window.store.updateConfig(patch)
    message.success('AI settings updated')
  }

  Store.prototype.openWidgetsModal = () => {
    const {
      store
    } = window
    store.setSettingItem(getInitItem([], settingMap.widgets))
    store.settingTab = settingMap.widgets
    store.openSettingModal()
  }

  // Autorun has two UIs: the sidebar thunderbolt and a UI widget's own switch.
  // One idempotent setter keeps the launch list, the sidebar badge and the
  // widget's stored choice on the same value, whichever one the user used.
  //
  // An existing row is replaced, not kept as it was: the user can change a
  // config field and press Run again, and the launch list has to start the
  // widget with what was just configured -- not with the snapshot from the
  // first launch. The secret fields are the exception: they are not written
  // here at all, they are resolved from the widget's own key store on every
  // start (see startAutoRunWidgets).
  Store.prototype.setWidgetAutoRun = (widgetId, enabled, config) => {
    const { store } = window
    const current = store.autoRunWidgets || []
    const existing = current.find(w => w.widgetId === widgetId)
    const item = enabled
      ? {
          id: (existing && existing.id) || generate(),
          widgetId,
          config: stripApiKeys(
            configsOf(widgetId),
            deepCopy(config || {})
          )
        }
      : null
    const next = upsertAutoRunWidget(current, widgetId, item)
    // assigned, not mutated: the watcher writes the list to the db
    store.autoRunWidgets = next
    const instance = store.widgetInstances.find(w => w.widgetId === widgetId)
    if (instance) {
      instance.autoRun = !!item
      instance.autoRunId = item ? item.id : undefined
    }
    const key = `widget-config-${widgetId}`
    const saved = safeGetItemJSON(key, {})
    const conf = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
    safeSetItemJSON(key, { ...conf, autoRun: !!enabled })
  }

  // Uninstall: the launch list is the renderer's, so the entry has to go here
  // as well — otherwise every launch tries to start a folder that is gone.
  Store.prototype.forgetWidgetAutoRun = (widgetId) => {
    const { store } = window
    if (!store.autoRunWidgets) {
      return
    }
    store.autoRunWidgets = store.autoRunWidgets.filter(w => w.widgetId !== widgetId)
  }

  Store.prototype.toggleAutoRunWidget = (instance) => {
    const { store } = window
    const { widgetId, config } = instance
    const current = store.autoRunWidgets || []
    if (instance.autoRun) {
      // every row of this widget goes, not just the one the instance points
      // at: a second row would start the widget a second time
      store.autoRunWidgets = current.filter(
        w => w.id !== instance.autoRunId && w.widgetId !== widgetId
      )
      instance.autoRun = false
      instance.autoRunId = undefined
    } else {
      const id = generate()
      const item = {
        id,
        widgetId,
        config: stripApiKeys(
          configsOf(widgetId),
          deepCopy(config || {})
        )
      }
      // one row per widget: an existing row of the same widget is replaced
      store.autoRunWidgets = upsertAutoRunWidget(current, widgetId, item)
      instance.autoRun = true
      instance.autoRunId = id
    }
    // A UI widget reads this value through getConfig, so the sidebar toggle
    // and the widget's own switch never disagree.
    const key = `widget-config-${widgetId}`
    const saved = safeGetItemJSON(key, {})
    const conf = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
    safeSetItemJSON(key, { ...conf, autoRun: !!instance.autoRun })
  }

  Store.prototype.startAutoRunWidgets = async function () {
    const { store } = window
    const items = store.autoRunWidgets
    if (!items || !items.length) {
      return
    }
    // the manifests decide which fields hold a secret, and they are needed
    // before the first widget starts
    try {
      await window.store.listWidgets()
    } catch (err) {
      console.error('Failed to list widgets for autorun:', err)
    }
    // one row per widget: a list that holds the same widget twice would try
    // to start it twice, and the second start is refused. The rows also lose
    // their secret fields -- an older version wrote the key into the db, and
    // a stale copy there would win over the saved key.
    const cleaned = dedupeAutoRunWidgets(items).map(item => ({
      ...item,
      config: stripApiKeys(configsOf(item.widgetId), item.config)
    }))
    if (JSON.stringify(cleaned) !== JSON.stringify(items)) {
      // assigned, not mutated: the watcher drops the extra rows from the db
      store.autoRunWidgets = cleaned
    }
    // A renderer that just loaded finds the instances still running in the main
    // process (refreshWidgetInstances runs first, see load-data.js): starting
    // them again would only raise "already has a running instance"
    const running = new Set(store.widgetInstances.map(i => i.widgetId))
    for (const item of cleaned) {
      if (running.has(item.widgetId)) {
        continue
      }
      try {
        const runConfig = {
          ...deepCopy(item.config),
          ...savedWidgetConfig(item.widgetId)
        }
        // The widget's own switch can turn autorun off without the list being
        // rewritten (older saved entries, or a config restored from backup).
        if (runConfig.autoRun === false) {
          continue
        }
        const configs = configsOf(item.widgetId)
        // The secret comes from the widget's own key store, never from the
        // saved config: that store keeps the key the user chose across
        // restarts, and a key generated for one launch is remembered there
        // instead of being a new one on the next launch.
        const finalConfig = withPersistedApiKeys(
          item.widgetId,
          configs,
          stripApiKeys(configs, runConfig)
        )
        // runWidget refreshes the instance list from the main process
        await store.runWidget(item.widgetId, finalConfig)
      } catch (err) {
        console.error(`Failed to autorun widget ${item.widgetId}:`, err)
      }
    }
  }
}
