/**
 * The id a message is filed under.
 *
 * A message that carries its own key replaces the message already on screen
 * under that key instead of stacking a second copy of it. Without this,
 * several terminals reporting the same problem at once pile up copies that
 * each have to be closed one by one - and closing one makes another take
 * its place, which reads as "the close button does not work".
 *
 * The key of a React element lives outside of its props, so the caller
 * reads it and passes it in; this module stays free of a react dependency.
 *
 * @author xiaogui
 * @since 2026-11-23 12:47:20
 * @param {object} config - The message config, may carry a `key`
 * @param {string} [elementKey] - The key of the content, when it is a React element
 * @returns {string|null} The id to use, or null when the message has none
 */
export function resolveMessageId (config = {}, elementKey = null) {
  if (config.key) {
    return config.key
  }
  if (elementKey) {
    return elementKey
  }
  return null
}
