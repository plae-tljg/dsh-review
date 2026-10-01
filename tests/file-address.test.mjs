/**
 * Tests for the `dsh-resource://file/…` address this tab opens files with.
 *
 * The expectations are the harness's own, copied from
 * `packages/util/workspace-path/tests/file-address.spec.ts`, so this module is
 * held to the grammar the claim parser uses rather than to its own idea of one.
 * The failure these exist for is silent: an address built by interpolation is
 * still a string, and only the parser knows that `notes#2.md` was cut at the
 * `#`, or that a bare `%` makes `decodeURIComponent` throw and leaves the
 * address claimed by no tab type at all.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionFileAddress } from '../src/client/file-address.js'

test('a session-relative path is encoded segment by segment', () => {
  assert.equal(
    sessionFileAddress('s 1', 'w/a b#c?.txt'),
    'dsh-resource://file/session/s%201/w/a%20b%23c%3F.txt',
  )
})

test('a leading ./ is dropped and backslashes normalize, as the grammar states', () => {
  assert.equal(sessionFileAddress('s', './src/a.ts'), 'dsh-resource://file/session/s/src/a.ts')
  assert.equal(sessionFileAddress('s', '././../outside/a.txt'), 'dsh-resource://file/session/s/../outside/a.txt')
  assert.equal(sessionFileAddress('s', 'src\\a.ts'), 'dsh-resource://file/session/s/src/a.ts')
  assert.equal(sessionFileAddress('s', ''), 'dsh-resource://file/session/s/')
})

test('an absolute path and a drive letter keep the shape the grammar names', () => {
  assert.equal(sessionFileAddress('s', '/etc/hosts'), 'dsh-resource://file/session/s//etc/hosts')
  assert.equal(sessionFileAddress('s', '/'), 'dsh-resource://file/session/s//')
  assert.equal(sessionFileAddress('s', 'C:\\w\\x.ts'), 'dsh-resource://file/session/s/C:/w/x.ts')
  assert.equal(sessionFileAddress('s', '\\\\server\\share\\x.ts'), 'dsh-resource://file/session/s///server/share/x.ts')
  assert.equal(sessionFileAddress('s', '/a b#c?%.txt'), 'dsh-resource://file/session/s//a%20b%23c%3F%25.txt')
})

test('a path the interpolation would have broken still names its own file', () => {
  // The three shapes that made the old hand-built address wrong: `#` and `?`
  // ended the address (so the tab opened a different file), and a bare `%`
  // threw out of the parser (so nothing claimed the address at all).
  const paths = ['drafts/a#b.md', 'drafts/a?b.md', 'drafts/100%done.md', 'drafts/中文草稿.md']
  for (const path of paths) {
    const address = sessionFileAddress('a1b2c3d4-0000-1111-2222-333344445555', path)
    // No raw delimiter survives, and every percent sign opens a full escape.
    assert.ok(!address.includes('#') && !address.includes('?'), `${path}: delimiter left raw`)
    assert.ok(!/%(?![0-9a-f]{2})/i.test(address), `${path}: malformed percent escape`)
    // Decoding the path segments — what the parser does — returns the path.
    const decoded = address.slice('dsh-resource://file/session/a1b2c3d4-0000-1111-2222-333344445555/'.length)
      .split('/').map(decodeURIComponent).join('/')
    assert.equal(decoded, path)
  }
})

test('a session id that needs encoding is encoded too', () => {
  // A session id is a uuid in practice, but the grammar encodes the id as one
  // segment, and the parser decodes it — so the two must agree.
  const address = sessionFileAddress('s/1 2', 'a.md')
  assert.equal(address, 'dsh-resource://file/session/s%2F1%202/a.md')
})
