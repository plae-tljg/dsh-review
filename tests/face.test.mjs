/**
 * Behaviour tests for the tab's async half.
 *
 * These drive `reviewFace` against a stub Remote and a real store instance, so
 * they cover the path a browser bug would live on: an outcome that never
 * reaches the store leaves the tab saying "Reading…" and nothing else.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewFace } from '../src/client/face.js'
import { createReviewStore } from '../src/client/store.js'

/** A store instance plus the actions the face writes through. */
function seededStore(tabId = 't1') {
  const engine = createReviewStore().create(tabId)
  engine.actions.start(tabId)
  return engine
}

/** A report shaped as the Host sends it. */
const REPORT = {
  isRepository: true, root: '/repo', branch: 'main', detached: false, upstream: null,
  ahead: 0, behind: 0, added: 0, removed: 0, truncated: false,
  files: [], tree: { directories: [], files: [] },
}

test('a resolved read lands in the store', async () => {
  const engine = seededStore()
  const face = reviewFace({ workspaceReview: { changes: async () => ({ ok: true, value: REPORT }) } })
  face('s1', engine.actions).start('t1', new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const tab = engine.getSnapshot().byTab.t1
  assert.equal(tab.report.kind, 'ready')
  assert.equal(tab.report.report.branch, 'main')
})

test('a failed read lands as a failure, not as loading', async () => {
  const engine = seededStore()
  const face = reviewFace({
    workspaceReview: {
      changes: async () => ({ ok: false, error: { code: 'workspace-review/not-repository', message: 'nope' } }),
    },
  })
  face('s1', engine.actions).start('t1', new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const tab = engine.getSnapshot().byTab.t1
  assert.equal(tab.report.kind, 'failed')
  assert.equal(tab.report.code, 'workspace-review/not-repository')
})

test('a read that never settles becomes a stated timeout', async () => {
  // The failure this exists for: a namespace that did not mount leaves the
  // promise pending, and the tab would say "Reading…" forever.
  const engine = seededStore()
  const never = new Promise(() => {})
  const face = reviewFace({ workspaceReview: { changes: () => never } })
  face('s1', engine.actions).start('t1', new AbortController().signal)
  assert.equal(engine.getSnapshot().byTab.t1.report.kind, 'loading')
  await new Promise(resolve => setTimeout(resolve, 20_100))
  const tab = engine.getSnapshot().byTab.t1
  assert.equal(tab.report.kind, 'failed')
  assert.equal(tab.report.code, 'client/timeout')
})

test('a rejecting read lands as a failure', async () => {
  const engine = seededStore()
  const face = reviewFace({ workspaceReview: { changes: () => Promise.reject(new Error('carrier gone')) } })
  face('s1', engine.actions).start('t1', new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const tab = engine.getSnapshot().byTab.t1
  assert.equal(tab.report.kind, 'failed')
  assert.equal(tab.report.message, 'carrier gone')
})

test('a refresh retires the read still in flight', async () => {
  const engine = seededStore()
  let answer = () => new Promise(() => {})
  const face = reviewFace({ workspaceReview: { changes: () => answer() } })
  const actions = face('s1', engine.actions)
  actions.start('t1', new AbortController().signal)
  answer = async () => ({ ok: true, value: { ...REPORT, branch: 'second' } })
  actions.refresh('t1', new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(engine.getSnapshot().byTab.t1.report.report.branch, 'second')
})

test('an unmounted namespace is a stated wiring failure', () => {
  assert.throws(() => reviewFace({}), /remote\.workspaceReview is not mounted/)
})
