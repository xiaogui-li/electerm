/**
 * API keys for built-in widgets that need one (today: the MCP server).
 *
 * The key has to outlive a restart. It used to be "optional": the run form
 * reset to an empty field on every visit, so the only way to keep
 * authentication on was to re-type the key on each launch — and in practice
 * everyone left it empty, which is how the MCP server ended up answering
 * unauthenticated requests from anything on the machine, including a
 * DNS-rebound web page.
 *
 * So: generate once, remember it, keep using it until the user types a
 * different one. localStorage is where this app already keeps per-widget form
 * state (components/widgets/custom-widget-form.jsx), and going through
 * safe-local-storage means the key is not sitting in plaintext next to the
 * rest of the profile.
 *
 * A field counts as a generated secret when its config entry sets
 * `showGenerator` — the flag the run form already uses to render the
 * "Generate" button, so the two stay in sync by construction.
 */

import { nanoid } from 'nanoid'
import { safeGetItem, safeSetItem } from './safe-local-storage'
import { isApiKeyField } from './widget-auto-run-utils'

const KEY_PREFIX = 'widget-api-key:'

export function apiKeyStorageKey (widgetId, fieldName) {
  return `${KEY_PREFIX}${widgetId}:${fieldName}`
}

export function readStoredApiKey (widgetId, fieldName) {
  return safeGetItem(apiKeyStorageKey(widgetId, fieldName))
}

export function rememberApiKey (widgetId, fieldName, key) {
  if (key) {
    safeSetItem(apiKeyStorageKey(widgetId, fieldName), key)
  }
}

// Same shape as the Generate button in config-fields.jsx, so a key that came
// from either path is recognisable.
export function generateApiKey () {
  return 'ett_' + nanoid()
}

/**
 * The saved keys of a widget's generated-secret fields.
 *
 * The run form shows them, so the field is never empty once a key exists:
 * an empty field means "keep the saved key", and a field that always looks
 * empty is what made the key look like something the user had to type again
 * on every launch.
 * @param {string} widgetId the widget the fields belong to
 * @param {object[]} [configs] the widget manifest config entries
 * @return {object} { fieldName: savedKey } for the fields that have one
 * @author xiaogui
 * @since 2026-11-20 12:42:45
 */
export function storedApiKeyValues (widgetId, configs) {
  const res = {}
  ;(configs || []).filter(isApiKeyField).forEach(c => {
    const stored = readStoredApiKey(widgetId, c.name)
    if (stored) {
      res[c.name] = stored
    }
  })
  return res
}

/**
 * Fill in every generated-secret field the caller left empty.
 *
 * An empty field means "use the saved key", never "no key": an unauthenticated
 * server is the vulnerability, so there is no way to ask for one. A non-empty
 * value is the user's own choice and replaces what was stored.
 *
 * Every start path goes through here -- the run form and the launch list --
 * so the key the server runs with is the same one on every launch.
 * @param {string} widgetId the widget the fields belong to
 * @param {object[]} [configs] the widget manifest config entries
 * @param {object} [config] the config to fill in
 * @return {object} a copy with every generated-secret field filled
 * @author xiaogui
 * @since 2026-11-20 12:42:45
 */
export function withPersistedApiKeys (widgetId, configs, config) {
  const secretConfigs = (configs || []).filter(isApiKeyField)
  if (!secretConfigs.length) {
    return config
  }
  const next = { ...(config || {}) }
  for (const c of secretConfigs) {
    const typed = next[c.name]
    if (typeof typed === 'string' && typed.trim()) {
      next[c.name] = typed.trim()
      rememberApiKey(widgetId, c.name, next[c.name])
      continue
    }
    const stored = readStoredApiKey(widgetId, c.name)
    if (stored) {
      next[c.name] = stored
      continue
    }
    next[c.name] = generateApiKey()
    rememberApiKey(widgetId, c.name, next[c.name])
  }
  return next
}
