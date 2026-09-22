/**
 * Host tests for the commit reads.
 *
 * A throwaway repository is built with two commits, then the three reads the
 * Commit view uses are driven on the prototype: `commits` (the log), and
 * `commitChanges` / `commitDiff` for one commit. The receiver carries only a
 * stub sandbox policy (which resolves the workspace root) and the prototype
 * methods, so no Cordis context is needed.
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

/** Run one body against a fresh repository with a committing `git`, then remove it. */
async function inRepo(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-review-'))
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, env })
  try {
    git('init', '-q')
    await run(root, git)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Two commits: `a.txt` created then appended to. */
function twoCommits(root, git) {
  writeFileSync(join(root, 'a.txt'), 'one\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'first')
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'second')
}

test('commits lists the history newest first', async () => {
  await inRepo(async (root, git) => {
    twoCommits(root, git)
    const list = await serviceAt(root).commits({ session: {} }, new AbortController().signal)
    assert.equal(list.isRepository, true)
    assert.equal(list.commits.length, 2)
    assert.equal(list.commits[0].subject, 'second')
    assert.equal(list.commits[1].subject, 'first')
    assert.match(list.commits[0].oid, /^[0-9a-f]{40}$/)
    assert.equal(list.commits[0].short, list.commits[0].oid.slice(0, 7))
  })
})

test('commitChanges and commitDiff read one commit', async () => {
  await inRepo(async (root, git) => {
    twoCommits(root, git)
    const service = serviceAt(root)
    const list = await service.commits({ session: {} }, new AbortController().signal)
    const head = list.commits[0]
    const report = await service.commitChanges({ session: {} }, head.oid, new AbortController().signal)
    assert.equal(report.oid, head.oid)
    assert.deepEqual(report.files.map(file => [file.path, file.status, file.added]), [['a.txt', 'modified', 1]])
    assert.equal(report.added, 1)
    assert.equal(report.removed, 0)
    const diff = await service.commitDiff({ session: {} }, head.oid, 'a.txt', new AbortController().signal)
    assert.ok(diff.file.hunks.length >= 1)
    assert.ok(diff.file.hunks[0].lines.some(line => line.kind === 'add' && line.text === 'two'))
  })
})

test('commitChanges marks a created file as added', async () => {
  await inRepo(async (root, git) => {
    writeFileSync(join(root, 'new.txt'), 'a\nb\n')
    git('add', 'new.txt')
    git('commit', '-q', '-m', 'add file')
    const service = serviceAt(root)
    const list = await service.commits({ session: {} }, new AbortController().signal)
    const report = await service.commitChanges({ session: {} }, list.commits[0].oid, new AbortController().signal)
    assert.deepEqual(report.files.map(file => [file.path, file.status, file.added]), [['new.txt', 'added', 2]])
  })
})

test('a bad commit id is a bad-request', async () => {
  await inRepo(async (root, git) => {
    twoCommits(root, git)
    await assert.rejects(
      () => serviceAt(root).commitChanges({ session: {} }, 'not-a-sha', new AbortController().signal),
      /invalid commit/,
    )
  })
})
