/**
 * Host tests for the scaling fixes.
 *
 * Two failures showed up on a large project and are pinned here:
 *
 * 1. The untracked line count used one `git diff --no-index` *process* per
 *    untracked file, all started at once. A tree with thousands of untracked
 *    files therefore forked thousands of git processes and the read timed out.
 *    The count now comes from the file itself, so the cost is one read per
 *    file and no process at all.
 * 2. The file listing asked Git for *every* git-ignored file in the
 *    repository — including a `node_modules` with a hundred thousand files —
 *    and only then dropped the heavy directories. The exclusions now go to
 *    Git as pathspecs, so the heavy files are never handed over.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/** Run one body against a fresh temporary Git repository, then remove it. */
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

test('an empty untracked file counts no lines', async () => {
  await inRepo(async (root) => {
    writeFileSync(join(root, 'empty.txt'), '')
    const count = await serviceAt(root).untrackedCount(root, 'empty.txt', new AbortController().signal)
    assert.deepEqual(count, { added: 0, removed: 0 })
  })
})

test('an untracked file of blank lines counts each line', async () => {
  await inRepo(async (root) => {
    writeFileSync(join(root, 'blank.txt'), 'a\n\n\nb\n')
    const count = await serviceAt(root).untrackedCount(root, 'blank.txt', new AbortController().signal)
    assert.deepEqual(count, { added: 4, removed: 0 })
  })
})

test('an untracked file counts exactly as git --numstat would', async () => {
  await inRepo(async (root) => {
    const cases = [
      ['nl.txt', 'a\nb\n'],
      ['no-nl.txt', 'a\nb'],
      ['one.txt', 'a\n'],
      ['one-no-nl.txt', 'a'],
      ['blank.txt', 'a\n\n\nb\n'],
      ['crlf.txt', 'a\r\nb\r\n'],
    ]
    for (const [name, body] of cases) {
      writeFileSync(join(root, name), body)
      // `git diff --no-index` reports a difference through exit 1, which is
      // not a failure here, so its stdout is read rather than its status.
      let expected = ''
      try {
        expected = execFileSync(
          'git',
          ['diff', '--no-index', '--numstat', '--no-color', '--', '/dev/null', join(root, name)],
          { encoding: 'utf8' },
        )
      } catch (error) {
        expected = error.stdout ?? ''
      }
      const [added] = expected.split('\t')
      const count = await serviceAt(root).untrackedCount(root, name, new AbortController().signal)
      assert.equal(count.added, Number(added), `${name} should match git's own count`)
    }
  })
})

test('the file listing leaves the heavy directories to git', async () => {
  await inRepo(async (root, git) => {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'src', 'app.ts'), 'x\n')
    writeFileSync(join(root, 'src', '.env'), 'SECRET=1\n')
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x\n')
    writeFileSync(join(root, 'dist', 'bundle.js'), 'x\n')
    writeFileSync(join(root, '.gitignore'), 'dist/\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')

    const service = serviceAt(root)
    const files = await service.listFiles({ session: {} }, new AbortController().signal)
    const paths = files.files.map(file => file.path)

    assert.ok(paths.includes('src/app.ts'), 'a tracked source file is listed')
    assert.ok(paths.includes('src/.env'), 'a git-ignored file is listed')
    assert.ok(!paths.some(path => path.startsWith('node_modules/')), 'node_modules is left out')
    assert.ok(!paths.some(path => path.startsWith('dist/')), 'dist is left out')
  })
})

test('the listing is capped, and says so', async () => {
  await inRepo(async (root, git) => {
    mkdirSync(join(root, 'many'), { recursive: true })
    for (let index = 0; index < 40; index += 1) {
      writeFileSync(join(root, 'many', `f${index}.txt`), 'x\n')
    }
    git('add', '-A')
    git('commit', '-q', '-m', 'init')

    const service = serviceAt(root)
    service.config = { ...DEFAULT_CONFIG, maxStatusEntries: 10 }
    const files = await service.listFiles({ session: {} }, new AbortController().signal)
    assert.equal(files.files.length, 10)
    assert.equal(files.truncated, true)
  })
})

test('the commit list says when it was cut', async () => {
  await inRepo(async (root, git) => {
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(root, 'a.txt'), `line ${index}\n`)
      git('add', 'a.txt')
      git('commit', '-q', '-m', `commit ${index}`)
    }
    const service = serviceAt(root)
    service.config = { ...DEFAULT_CONFIG, maxCommits: 3 }
    const list = await service.commits({ session: {} }, new AbortController().signal)
    assert.equal(list.commits.length, 3)
    assert.equal(list.truncated, true, 'a cut list is distinguishable from a complete one')

    service.config = { ...DEFAULT_CONFIG, maxCommits: 50 }
    const whole = await service.commits({ session: {} }, new AbortController().signal)
    assert.equal(whole.commits.length, 5)
    assert.equal(whole.truncated, false, 'a complete list is not marked cut')
  })
})
