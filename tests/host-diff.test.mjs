/**
 * Host tests for `workspaceReview/diff`'s fallback rule.
 *
 * `git diff` never reports an untracked path, so the service reads one with
 * `git diff --no-index` against the null device and the client marks the body
 * "everything below is an addition". Which paths take that branch is the whole
 * subject here: taking it for a path Git *does* track invents a whole-file
 * addition for a file that has nothing to show — the bug a reader sees as "the
 * tree says +22 -11 and the body says the whole file was added".
 *
 * The cases are driven on the prototype with a stub sandbox policy, against
 * throwaway repositories: one with a commit, one with no commit yet.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, WorkspaceReview } from '../lib/index.js'

/** A receiver whose workspace root is the given directory. */
function serviceAt(root) {
  const service = Object.create(WorkspaceReview.prototype)
  service.ctx = { sandboxPolicy: { resolve: () => ({ workspaceRoot: root }) } }
  service.config = { ...DEFAULT_CONFIG }
  return service
}

/** The `git` runner one fixture uses, with an identity so a commit can be made. */
function gitIn(root) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  }
  return (...args) => execFileSync('git', args, { cwd: root, env })
}

/** Drive one body against a fresh repository, then remove it. */
async function inRepo(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-review-diff-'))
  try {
    await run(root, gitIn(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Read one path's diff body through the service. */
function readDiff(service, path) {
  return service.diff({ session: {} }, path, 3, new AbortController().signal)
}

test('a tracked file that matches HEAD is not reported as a whole-file addition', async () => {
  await inRepo(async (root, git) => {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
    git('init', '-q')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'init')
    // Nothing changed on disk: a report row naming this path is stale, and the
    // honest body is "no text" rather than three invented additions.
    const diff = await readDiff(serviceAt(root), 'a.txt')
    assert.equal(diff.untracked, false)
    assert.equal(diff.file.path, 'a.txt')
    assert.equal(diff.file.notice, 'no-body')
    assert.deepEqual(diff.file.hunks, [])
    assert.equal(diff.patch, '')
  })
})

test('a modified tracked file reports its own hunks', async () => {
  await inRepo(async (root, git) => {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
    git('init', '-q')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(root, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    const diff = await readDiff(serviceAt(root), 'a.txt')
    assert.equal(diff.untracked, false)
    const kinds = diff.file.hunks.flatMap(hunk => hunk.lines.map(line => line.kind))
    assert.deepEqual(kinds, ['ctx', 'del', 'add', 'ctx', 'add'])
  })
})

test('an untracked file is still read as pure additions', async () => {
  await inRepo(async (root, git) => {
    writeFileSync(join(root, 'a.txt'), 'one\n')
    git('init', '-q')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(root, 'new.txt'), 'fresh\ncontent\n')
    const diff = await readDiff(serviceAt(root), 'new.txt')
    assert.equal(diff.untracked, true)
    const additions = diff.file.hunks.flatMap(hunk => hunk.lines.filter(line => line.kind === 'add').map(line => line.text))
    assert.deepEqual(additions, ['fresh', 'content'])
  })
})

test('a path committed and then removed from the index still reports its deletion', async () => {
  await inRepo(async (root, git) => {
    writeFileSync(join(root, 'a.txt'), 'one\n')
    git('init', '-q')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'init')
    // The index no longer carries the path, but HEAD does: the change is a
    // staged deletion, not an untracked file, so no null-device read applies.
    git('rm', '-q', '--cached', 'a.txt')
    const diff = await readDiff(serviceAt(root), 'a.txt')
    assert.equal(diff.untracked, false)
    const kinds = diff.file.hunks.flatMap(hunk => hunk.lines.map(line => line.kind))
    assert.deepEqual(kinds, ['del'])
  })
})

test('an unborn repository reads a staged file as additions', async () => {
  await inRepo(async (root, git) => {
    git('init', '-q')
    writeFileSync(join(root, 'staged.txt'), 'staged\n')
    git('add', 'staged.txt')
    const diff = await readDiff(serviceAt(root), 'staged.txt')
    assert.equal(diff.untracked, false)
    const additions = diff.file.hunks.flatMap(hunk => hunk.lines.filter(line => line.kind === 'add').map(line => line.text))
    assert.deepEqual(additions, ['staged'])
  })
})

test('an unborn repository reads an untracked file as additions', async () => {
  await inRepo(async (root, git) => {
    git('init', '-q')
    // Never staged, and there is no HEAD to diff against: the index is the only
    // thing that can answer "is this tracked", and it says no.
    writeFileSync(join(root, 'loose.txt'), 'loose\n')
    const diff = await readDiff(serviceAt(root), 'loose.txt')
    assert.equal(diff.untracked, true)
    const additions = diff.file.hunks.flatMap(hunk => hunk.lines.filter(line => line.kind === 'add').map(line => line.text))
    assert.deepEqual(additions, ['loose'])
  })
})
