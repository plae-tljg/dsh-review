/**
 * Per-session view-state persistence.
 *
 * The tab's own bucket lives in memory and dies with a page reload, so the few
 * choices a reader makes — which source, the rail width, the filter, which file
 * is open — are mirrored to `localStorage` under the session id. Nothing here is
 * business data: the report, the diffs and the file contents are always re-read.
 *
 * Storage is optional: a browser that refuses it (private mode, quota) simply
 * does not persist, and a non-browser (the test runner) is a no-op.
 */

const VERSION = 1

/** The storage key for one session's view state. */
function keyFor(sessionId) {
  return `dsh-review:view:${sessionId}`
}

/** A usable `localStorage`, or null when there is none. */
function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * Read one session's saved view state.
 * @param {string} sessionId - The session.
 * @returns {object} The saved state, or `{}` when there is none or it is stale.
 */
export function loadView(sessionId) {
  const store = storage()
  if (store === null || typeof sessionId !== 'string' || sessionId === '') return {}
  try {
    const parsed = JSON.parse(store.getItem(keyFor(sessionId)) ?? 'null')
    if (parsed === null || parsed.v !== VERSION || typeof parsed.d !== 'object' || parsed.d === null) return {}
    return parsed.d
  } catch {
    return {}
  }
}

/**
 * Write one session's view state.
 * @param {string} sessionId - The session.
 * @param {object} data - The state to save.
 * @returns {void}
 */
export function saveView(sessionId, data) {
  const store = storage()
  if (store === null || typeof sessionId !== 'string' || sessionId === '') return
  try {
    store.setItem(keyFor(sessionId), JSON.stringify({ v: VERSION, d: data }))
  } catch {
    // Quota exceeded or storage disabled: view state simply does not persist.
  }
}
