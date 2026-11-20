/**
 * The pure half of the widget launch list — no storage, no window, so
 * `node --test` can load it (see test/unit-ci/widget-auto-run.spec.js).
 * The store side is in ../store/widgets.js.
 *
 * The launch list (store.autoRunWidgets) holds one row per widget: the row
 * says "start this widget on launch" and carries the config it starts with.
 * Two rules matter and both were broken before:
 *
 *   1. One row per widget. Every toggle used to append a row, so the list
 *      could hold the same widget several times; a launch then tried to start
 *      it again and the main process refused the second start (singleInstance).
 *   2. The row keeps its place. Replacing a row must not move the widget to
 *      the end of the list, or the launch order would change under the user.
 *
 * A secret never belongs in a row: the launch list is written to the db as
 * plain JSON, so a key kept there would be a second copy of a credential —
 * and the stale copy would win over the saved key when the widget starts
 * again. The secret fields are therefore removed before a row is stored, and
 * resolved from the widget's own key store on every start.
 */

// A field counts as a generated secret when its config entry sets
// `showGenerator` — the flag the run form already uses to render the
// "Generate" button, so the two stay in sync by construction.
export function isApiKeyField (config) {
  return !!config && !!config.showGenerator
}

// The names of the generated-secret fields of a widget.
export function secretFieldNames (configs) {
  return (configs || []).filter(isApiKeyField).map(c => c.name)
}

// The secret field names the app knows without a manifest. The manifest is
// the precise source, but it arrives over IPC: a launch row written before
// the widget list arrived would keep its key in the db, where the key sits in
// plaintext. The fallback covers the field names that exist today.
const KNOWN_SECRET_FIELDS = ['apiKey']

/**
 * A copy of `config` without the known secret fields, for the case where the
 * manifest has not arrived yet.
 * @param {object} [config] the config to clean
 * @return {object} a copy without the known secret fields
 */
export function stripKnownSecrets (config) {
  const next = { ...(config || {}) }
  KNOWN_SECRET_FIELDS.forEach(name => {
    delete next[name]
  })
  return next
}

/**
 * A copy of `config` without the generated-secret fields.
 *
 * The manifest is the precise source; the known field names are the
 * fallback for when it has not arrived yet. Both are applied, so a secret
 * never reaches the db.
 * @param {object[]} [configs] the widget manifest config entries
 * @param {object} [config] the config to clean
 * @return {object} a copy without the secret fields
 */
export function stripApiKeys (configs, config) {
  const names = secretFieldNames(configs)
  const next = stripKnownSecrets(config)
  if (!names.length) {
    return next
  }
  names.forEach(name => {
    delete next[name]
  })
  return next
}

/**
 * The launch list with one row per widget.
 *
 * The last row of a widget wins, since it carries the newest config; the row
 * keeps the position of the first one, so the launch order does not change.
 * @param {object[]} list the launch list
 * @return {object[]} the list with one row per widget
 */
export function dedupeAutoRunWidgets (list) {
  const byId = new Map()
  const order = []
  for (const item of list || []) {
    if (!item || !item.widgetId) {
      continue
    }
    if (!byId.has(item.widgetId)) {
      order.push(item.widgetId)
    }
    byId.set(item.widgetId, item)
  }
  return order.map(id => byId.get(id))
}

/**
 * The launch list with `widgetId` set to `item`, or without it when `item`
 * is null (the widget is not launched any more).
 *
 * The row that was already there keeps its place, and the rows of other
 * widgets keep theirs.
 * @param {object[]} current the launch list
 * @param {string} widgetId the widget the row belongs to
 * @param {object|null} item the new row, null to remove the widget
 * @return {object[]} the new launch list
 */
export function upsertAutoRunWidget (current, widgetId, item) {
  const next = []
  let replaced = false
  for (const row of current || []) {
    if (row.widgetId !== widgetId) {
      next.push(row)
      continue
    }
    // only the first row of this widget keeps its place; the others are
    // duplicates and go
    if (replaced) {
      continue
    }
    replaced = true
    if (item) {
      next.push(item)
    }
  }
  if (item && !replaced) {
    next.push(item)
  }
  return next
}
