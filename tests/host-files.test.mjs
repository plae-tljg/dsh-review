/**
 * Host tests for the Files-view reads and write.
 *
 * A throwaway repository carries a tracked file, an ignored file, and an
 * untracked file, then `listFiles` / `readFile` / `writeFile` are driven on the
 * prototype (a stub sandbox policy resolves the root). The confinement rules get
 * their own cases: an escape must be refused for both read and write.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** Run one body against a fresh repository, then remove it. */
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
    writeFileSync(join(root, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(root, 'tracked.txt'), 'tracked\n')
    git('add', '.gitignore', 'tracked.txt')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(root, 'ignored.txt'), 'ignored\n')
    writeFileSync(join(root, 'untracked.txt'), 'untracked\n')
    await run(root, git)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('listFiles returns tracked and untracked files, not ignored ones', async () => {
  await inRepo(async (root) => {
    const report = await serviceAt(root).listFiles({ session: {} }, new AbortController().signal)
    assert.equal(report.isRepository, true)
    const paths = report.files.map(file => file.path).sort()
    assert.deepEqual(paths, ['.gitignore', 'tracked.txt', 'untracked.txt'])
    assert.equal(report.count, 3)
    // The tree groups them; a root-level file sits in `files`.
    assert.ok(report.tree.files.some(file => file.path === 'tracked.txt'))
  })
})

test('readFile returns the file text and writeFile updates it', async () => {
  await inRepo(async (root) => {
    const service = serviceAt(root)
    const read = await service.readFile({ session: {} }, 'tracked.txt', new AbortController().signal)
    assert.equal(read.text, 'tracked\n')
    assert.equal(read.binary, false)
    const written = await service.writeFile({ session: {} }, 'tracked.txt', 'changed\n', new AbortController().signal)
    assert.equal(written.bytes, 'changed\n'.length)
    assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'changed\n')
  })
})

test('readFile refuses a path that escapes the workspace', async () => {
  await inRepo(async (root) => {
    await assert.rejects(
      () => serviceAt(root).readFile({ session: {} }, '../outside.txt', new AbortController().signal),
      /escapes the workspace/,
    )
  })
})

test('writeFile refuses an absolute path', async () => {
  await inRepo(async (root) => {
    await assert.rejects(
      () => serviceAt(root).writeFile({ session: {} }, '/etc/passwd', 'x', new AbortController().signal),
      /invalid path/,
    )
  })
})

test('readFile reports a missing file', async () => {
  await inRepo(async (root) => {
    await assert.rejects(
      () => serviceAt(root).readFile({ session: {} }, 'nope.txt', new AbortController().signal),
      /no such file/,
    )
  })
})
