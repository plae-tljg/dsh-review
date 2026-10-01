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

test('a non-numeric context degrades to three lines', async () => {
  const engine = seededStore()
  const seen = []
  const face = reviewFace({
    workspaceReview: {
      changes: async () => ({ ok: true, value: REPORT }),
      diff: async (_session, _path, context) => {
        seen.push(context)
        return { ok: true, value: {} }
      },
    },
  })
  const actions = face('s1', engine.actions)
  // The mistake this guards: the old call shape put the AbortSignal in the
  // context slot (a panel wrapper still supplied a real signal separately), and
  // the wire codec rejected it as "context".
  actions.select('t1', 'a.txt', false, new AbortController().signal, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(seen, [3])
})

/** One report carrying a single changed path. */
function reportWith(path, added) {
  const row = {
    path, status: 'modified', index: ' ', worktree: 'M', staged: false, unstaged: true,
    untracked: false, renamedFrom: null, added, removed: 1,
  }
  return { ...REPORT, files: [row], tree: { directories: [], files: [row] }, added, removed: 1 }
}

test('a refresh drops the cached body so the open path is read again', async () => {
  // The bug this exists for: a body read while the file was untracked stayed
  // "everything is an addition" after the file was committed and edited again —
  // the tree beside it carried the new counts, the body carried the old patch —
  // because the report kept every cached body whose path was still listed.
  const engine = seededStore()
  const bodies = [
    { untracked: true, truncated: false, patch: 'all additions', file: { path: 'a.txt', oldPath: null, binary: false, notice: null, hunks: [] } },
    { untracked: false, truncated: false, patch: 'one hunk', file: { path: 'a.txt', oldPath: null, binary: false, notice: null, hunks: [] } },
  ]
  const reads = []
  const face = reviewFace({
    workspaceReview: {
      changes: async () => ({ ok: true, value: reportWith('a.txt', reads.length === 0 ? 40 : 3) }),
      diff: async () => {
        reads.push(reads.length)
        return { ok: true, value: bodies[reads.length - 1] }
      },
    },
  })
  const actions = face('s1', engine.actions)
  const signal = new AbortController().signal
  actions.start('t1', signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  // The first read: the path was untracked, so the body is the whole file.
  actions.select('t1', 'a.txt', false, 3, signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(engine.getSnapshot().byTab.t1.diffs['a.txt'].diff.patch, 'all additions')
  // The file is committed and edited; the reader presses ⟳.
  actions.refresh('t1', signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const held = engine.getSnapshot().byTab.t1.diffs['a.txt']
  // Nothing cached survives the new report, so the component reads it again.
  assert.equal(held, undefined)
  actions.select('t1', 'a.txt', held !== undefined, 3, signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(reads.length, 2)
  assert.equal(engine.getSnapshot().byTab.t1.diffs['a.txt'].diff.patch, 'one hunk')
})
