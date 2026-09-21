/**
 * Unit tests for the browser half's Rounds derivation.
 *
 * The derivation is fed a hand-built ConversationSnapshot in the shape the
 * client publishes (`views.get('chat').legacy`), so the tests pin the contract
 * rather than a live session: which tools count as a mutation, how a settled
 * result's `meta.diffs` replaces the call-argument intent, how a deletion is
 * kept display-only, and how a change is attributed to its round.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  appliedDiffs,
  callIntent,
  deriveRounds,
  diffContentLines,
  lineDiff,
  normalizeSnapshot,
} from '../src/client/rounds.js'

/** One settled tool-result node with the call head and metadata given. */
function toolResult(seq, name, args, meta = {}, extra = {}) {
  return {
    kind: 'tool-result',
    seq,
    isError: false,
    callId: `call-${seq}`,
    subCalls: [],
    call: { name, argsRaw: JSON.stringify(args) },
    meta,
    ...extra,
  }
}

/** A snapshot carrying the given nodes and completed rounds. */
function snapshot(nodes, turnEnds = new Map([[1, 100]])) {
  return {
    views: {
      get(name) {
        if (name !== 'chat') return undefined
        return { legacy: { nodes, turnEnds, partial: null, runningCalls: [] } }
      },
    },
  }
}

test('diffContentLines drops a trailing terminator but not a blank line', () => {
  assert.deepEqual(diffContentLines(''), [])
  assert.deepEqual(diffContentLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(diffContentLines('a\n\n'), ['a', ''])
})

test('lineDiff marks context, deletion and addition', () => {
  const rows = lineDiff('a\nb\nc', 'a\nx\nc')
  assert.deepEqual(rows, [
    { kind: 'ctx', text: 'a' },
    { kind: 'del', text: 'b' },
    { kind: 'add', text: 'x' },
    { kind: 'ctx', text: 'c' },
  ])
})

test('a write with no meta diff reports the call intent as an addition', () => {
  const intent = callIntent('write', JSON.stringify({ file_path: 'src/new.ts', content: 'hello\n' }))
  assert.deepEqual(intent.diffs, [{ path: 'src/new.ts', oldText: null, newText: 'hello\n' }])
})

test('an edit prefers the applied meta diffs on settlement', () => {
  const node = toolResult(5, 'edit', { file_path: 'a/b.txt', old_string: 'x', new_string: 'y' }, {
    diffs: [{ path: 'a/b.txt', oldText: 'x', newText: 'y' }],
  })
  const rounds = deriveRounds(snapshot([node]))
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0].turn, 1)
  assert.equal(rounds[0].live, false)
  assert.equal(rounds[0].files.length, 1)
  const file = rounds[0].files[0]
  assert.equal(file.path, 'a/b.txt')
  assert.equal(file.status, 'modified')
  assert.equal(file.added, 1)
  assert.equal(file.removed, 1)
  // The tree groups the file under its directory.
  assert.equal(rounds[0].tree.directories.length, 1)
  assert.equal(rounds[0].tree.directories[0].name, 'a')
  assert.equal(rounds[0].tree.directories[0].files[0].path, 'a/b.txt')
})

test('a literal rm command reports the deleted path, display-only', () => {
  const node = toolResult(5, 'bash', { command: 'rm old/legacy.ts && echo done' })
  const rounds = deriveRounds(snapshot([node]))
  assert.equal(rounds[0].files.length, 1)
  assert.equal(rounds[0].files[0].path, 'old/legacy.ts')
  assert.equal(rounds[0].files[0].status, 'deleted')
  assert.equal(rounds[0].files[0].deleted, true)
})

test('a glob deletion is not guessed', () => {
  const node = toolResult(5, 'bash', { command: 'rm *.log' })
  assert.equal(deriveRounds(snapshot([node])).length, 0)
})

test('an errored tool-result is ignored', () => {
  const node = toolResult(5, 'edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' }, {}, { isError: true })
  assert.equal(deriveRounds(snapshot([node])).length, 0)
})

test('changes are attributed to the live round past the last end', () => {
  const settled = toolResult(5, 'edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' })
  const live = toolResult(200, 'write', { file_path: 'b.txt', content: 'z' })
  const rounds = deriveRounds(snapshot([settled, live], new Map([[1, 100]])))
  assert.deepEqual(rounds.map(round => round.turn).sort((a, b) => a - b), [1, 2])
  const second = rounds.find(round => round.turn === 2)
  assert.equal(second.live, true)
  assert.equal(second.files[0].path, 'b.txt')
})

test('a top-level legacy snapshot normalizes like the views form', () => {
  const top = { nodes: [], turnEnds: new Map(), partial: null, runningCalls: [] }
  assert.deepEqual(normalizeSnapshot(top), top)
})

test('appliedDiffs rejects a malformed metadata payload', () => {
  assert.equal(appliedDiffs({ diffs: [{ path: 1, oldText: null, newText: 'x' }] }), null)
  assert.equal(appliedDiffs({}), null)
})
