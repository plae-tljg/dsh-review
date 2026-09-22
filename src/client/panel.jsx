/**
 * The Review tab inside `dsh-better-sidebar`'s panel.
 *
 * That panel keeps its own tab registry and its own store, so this module
 * bridges the two: it mints the view state from the same `createReviewStore`
 * factory the native seat uses, drives the same Remote reads through the same
 * face, and renders the same `ReviewBody`. Only the data plumbing differs — the
 * panel hands a component `{ store, scope, tab, visible }` instead of the native
 * seat's framework hooks, so this module binds the missing hook itself.
 *
 * The important part is the subscription: the panel gives no reactive
 * `useStore`, and a bare read of `engine.getSnapshot()` would never re-render
 * when the face writes a report, leaving the tab on "Reading…" forever. The
 * snapshot is therefore observed with `useSyncExternalStore` and the selector
 * hook is rebuilt from each new snapshot.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { ReviewBody } from './ReviewBody.jsx'

/** The tab id this package registers in the panel. */
export const REVIEW_PANEL_ID = 'dsh-review:panel'

/**
 * One abort controller per tab, kept outside the component so a re-render never
 * mints a second one: the store's `start` registers its `forget` cleanup on the
 * signal, and two controllers would mean two cleanups for one bucket.
 */
const lifetime = new Map()

/**
 * The abort controller a tab's record lives under.
 * @param {string} tabId - The panel tab's id.
 * @returns {AbortController} The controller, created on first use.
 */
function controllerFor(tabId) {
  let controller = lifetime.get(tabId)
  if (controller === undefined) {
    controller = new AbortController()
    lifetime.set(tabId, controller)
  }
  return controller
}

/** Drop a closed tab's controller, ending its record's lifetime. */
function releaseTab(tabId) {
  const controller = lifetime.get(tabId)
  if (controller !== undefined) {
    controller.abort()
    lifetime.delete(tabId)
  }
}

/**
 * The panel tab's body.
 * @param {object} props - Panel props plus the review face and dictionary.
 * @returns {import('react').ReactNode} The tab body.
 */
export function ReviewPanelBody({ scope, tab, face, store, t, openFile }) {
  const tabId = tab.id
  const sessionId = scope.sessionId

  // One store instance for this component's lifetime; the panel remounts the
  // body on a tab switch, so a per-tab bucket is the natural key.
  const engine = useMemo(() => store.create(tabId), [store, tabId])
  const actions = engine.actions

  // Observe the engine so every write (loading, loaded, failed) re-renders.
  const subscribe = useMemo(() => (listener) => engine.subscribe(listener), [engine])
  const getSnapshot = useMemo(() => () => engine.getSnapshot(), [engine])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const useStore = useMemo(() => (select) => select(snapshot), [snapshot])

  const controller = controllerFor(tabId)

  // A closed tab ends its record's lifetime, which is what releases the bucket.
  useEffect(() => () => releaseTab(tabId), [tabId])

  // The whole face for this session, including the conversation source the
  // Rounds view subscribes to.
  const bridge = useMemo(() => face(sessionId, actions), [face, sessionId, actions])

  const start = useMemo(() => (id, signal) => { bridge.start(id, signal) }, [bridge])
  const refresh = useMemo(() => (id) => { bridge.refresh(id, controller.signal) }, [bridge, controller])
  const select = useMemo(() => (id, path, held) => { bridge.select(id, path, held, controller.signal) }, [bridge, controller])
  const open = useMemo(() => (id, path) => { bridge.open(id, path, controller.signal) }, [bridge, controller])
  const listCommits = useMemo(() => (id, signal) => { bridge.listCommits(id, signal) }, [bridge])
  const openCommit = useMemo(() => (id, oid, signal) => { bridge.openCommit(id, oid, signal) }, [bridge])
  const openCommitDiff = useMemo(() => (id, oid, path, signal) => { bridge.openCommitDiff(id, oid, path, signal) }, [bridge])

  return (
    <ReviewBody
      useTabInfo={() => ({ tab: { id: tabId, signal: controller.signal } })}
      useStore={useStore}
      actions={actions}
      start={start}
      refresh={refresh}
      select={select}
      open={open}
      listCommits={listCommits}
      openCommit={openCommit}
      openCommitDiff={openCommitDiff}
      conversation={bridge.conversation}
      sessionId={sessionId}
      openFile={openFile}
      t={t}
    />
  )
}
