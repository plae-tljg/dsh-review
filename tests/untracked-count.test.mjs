/**
 * Host test for untracked line counting.
 *
 * `git diff --numstat` omits untracked paths, which is why a new file used to
 * arrive with `null` counts and vanish from the grand total. The fix reads each
 * untracked path with `git diff --no-index --numstat`, so this test drives that
 * read against a throwaway repository and pins the text and binary answers.
 *
 * The method only touches `this.git`, so it is called on the prototype without a
 * constructed service (which would need a Cordis context).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceReview } from '../lib/index.js'

/** A bare receiver carrying only the prototype methods the read needs. */
const service = Object.create(WorkspaceReview.prototype)

/** Run one body against a fresh temporary Git repository, then remove it. */
async function inRepo(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-review-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('an untracked text file counts each line as an addition', async () => {
  await inRepo(async (root) => {
    writeFileSync(join(root, 'new.txt'), 'a\nb\nc\n')
    const count = await service.untrackedCount(root, 'new.txt', new AbortController().signal)
    assert.deepEqual(count, { added: 3, removed: 0 })
  })
})

test('an untracked file with no trailing newline still counts its last line', async () => {
  await inRepo(async (root) => {
    writeFileSync(join(root, 'new.txt'), 'a\nb')
    const count = await service.untrackedCount(root, 'new.txt', new AbortController().signal)
    assert.deepEqual(count, { added: 2, removed: 0 })
  })
})

test('an untracked binary file reports unknown counts', async () => {
  await inRepo(async (root) => {
    writeFileSync(join(root, 'new.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]))
    const count = await service.untrackedCount(root, 'new.bin', new AbortController().signal)
    assert.deepEqual(count, { added: null, removed: null })
  })
})

test('an untracked file with a space in its name is read exactly', async () => {
  await inRepo(async (root) => {
    writeFileSync(join(root, 'a b.txt'), 'one\ntwo\n')
    const count = await service.untrackedCount(root, 'a b.txt', new AbortController().signal)
    assert.deepEqual(count, { added: 2, removed: 0 })
  })
})
