/**
 * Unit tests for the Host half's parsing, over recorded `git` output.
 *
 * Each fixture is the literal stdout of the command named above it, taken from
 * Git 2.4x on Linux. They are recorded rather than generated so a Git whose
 * output drifts fails here instead of in the browser, and so the awkward cases
 * are stated once: a path with a space, a C-quoted non-ASCII path, a binary
 * change with no `---`/`+++` headers, and a rename that changes no lines.
 *
 * Every path-carrying fixture is built as a `String.raw` literal or with an
 * explicit `String.fromCharCode(92)`. Git's quoted paths are full of backslashes
 * — *one* before each octal byte — and an ordinary string literal would need
 * each of those doubled, which is exactly the kind of escaping that hides a
 * real change to the fixture.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildTree,
  destinationOf,
  headerPath,
  parseBranchHeader,
  parseNumstat,
  parseStatus,
  parseUnifiedDiff,
  unquotePath,
} from '../lib/index.js'

/** One backslash, spelled so no shell or editor can double it by accident. */
const BS = String.fromCharCode(92)

/** A patch section for `unié.txt` exactly as `git diff` writes it. */
const QUOTED_SECTION = [
  `diff --git "a/uni${BS}303${BS}251.txt" "b/uni${BS}303${BS}251.txt"`,
  'index 587be6b..975fbec 100644',
  `--- "a/uni${BS}303${BS}251.txt"`,
  `+++ "b/uni${BS}303${BS}251.txt"`,
].join('\n')

/** A modification, a deletion, a rename, and a quoted non-ASCII edit in one patch. */
const MIXED_PATCH = [
  'diff --git a/a file.txt b/a file.txt',
  'index 814f4a4..879de50 100644',
  '--- a/a file.txt\t',
  '+++ b/a file.txt\t',
  '@@ -1,2 +1,2 @@',
  ' one',
  '-two',
  '+TWO',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  'index b680253..0000000',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-z',
  'diff --git a/olddir/keep.txt b/renamed.txt',
  'similarity index 100%',
  'rename from olddir/keep.txt',
  'rename to renamed.txt',
  QUOTED_SECTION,
  '@@ -1 +1 @@',
  '-x',
  '+y',
  '',
].join('\n')

test('parseUnifiedDiff keeps one path per section', () => {
  const files = parseUnifiedDiff(MIXED_PATCH)
  assert.deepEqual(files.map(file => file.path), ['a file.txt', 'gone.txt', 'renamed.txt', 'unié.txt'])
})

test('parseUnifiedDiff numbers both sides of a hunk', () => {
  const [first] = parseUnifiedDiff(MIXED_PATCH)
  assert.equal(first.hunks.length, 1)
  const [hunk] = first.hunks
  assert.deepEqual(
    { oldStart: hunk.oldStart, newStart: hunk.newStart, oldCount: hunk.oldCount, newCount: hunk.newCount },
    { oldStart: 1, newStart: 1, oldCount: 2, newCount: 2 },
  )
  // The leading marker is stripped from every body line, context included.
  assert.deepEqual(hunk.lines.map(line => [line.kind, line.oldNumber, line.newNumber, line.text]), [
    ['ctx', 1, 1, 'one'],
    ['del', 2, null, 'two'],
    ['add', null, 2, 'TWO'],
  ])
})

test('parseUnifiedDiff records a deletion with no new side', () => {
  const gone = parseUnifiedDiff(MIXED_PATCH).find(file => file.path === 'gone.txt')
  assert.equal(gone.hunks[0].newCount, 0)
  assert.deepEqual(gone.hunks[0].lines, [{ kind: 'del', text: 'z', oldNumber: 1, newNumber: null }])
})

test('parseUnifiedDiff reports a rename that changes no lines', () => {
  const renamed = parseUnifiedDiff(MIXED_PATCH).find(file => file.path === 'renamed.txt')
  assert.equal(renamed.oldPath, 'olddir/keep.txt')
  assert.equal(renamed.hunks.length, 0)
  assert.equal(renamed.notice, 'no-body')
})

test('parseUnifiedDiff resolves a quoted non-ASCII path', () => {
  const quoted = parseUnifiedDiff(MIXED_PATCH).at(-1)
  assert.equal(quoted.path, 'unié.txt')
  assert.equal(quoted.oldPath, null)
  assert.equal(quoted.hunks[0].lines.at(-1).text, 'y')
})

test('parseUnifiedDiff names a binary section that carries no header body', () => {
  // A binary change emits neither `---`/`+++` nor `@@`; the `Binary files` line
  // is the only place the section names its path, and without it the section
  // has no path and is dropped.
  const patch = [
    'diff --git a/img.png b/img.png',
    'index d186a24..5134f22 100644',
    'Binary files a/img.png and b/img.png differ',
    '',
  ].join('\n')
  assert.deepEqual(parseUnifiedDiff(patch), [
    { path: 'img.png', oldPath: null, binary: true, notice: null, hunks: [] },
  ])
})

test('parseUnifiedDiff follows a hunk across an absent trailing newline', () => {
  const patch = [
    'diff --git a/tail.txt b/tail.txt',
    '--- a/tail.txt',
    '+++ b/tail.txt',
    '@@ -1 +1 @@',
    '-old',
    `${BS} No newline at end of file`,
    '+new',
    `${BS} No newline at end of file`,
    '',
  ].join('\n')
  const [file] = parseUnifiedDiff(patch)
  assert.deepEqual(file.hunks[0].lines.map(line => line.text), ['old', 'new'])
})

test('parseUnifiedDiff drops a mode-only section and returns nothing for an empty patch', () => {
  // A mode change states no path this parser can read, so the section is
  // dropped and `diff()` supplies the path it already knows.
  const modeOnly = ['diff --git a/mode.sh b/mode.sh', 'old mode 100644', 'new mode 100755', ''].join('\n')
  assert.deepEqual(parseUnifiedDiff(modeOnly), [])
  assert.deepEqual(parseUnifiedDiff(''), [])
})

test('headerPath strips each diff prefix and marks the absent side', () => {
  assert.equal(headerPath('a/dir/file.txt'), 'dir/file.txt')
  assert.equal(headerPath('b/dir/file.txt'), 'dir/file.txt')
  assert.equal(headerPath('a/tabbed.txt\t'), 'tabbed.txt')
  assert.equal(headerPath('/dev/null'), '')
  assert.equal(headerPath(`"b/uni${BS}303${BS}251.txt"`), 'unié.txt')
})

test('unquotePath decodes a quoted path and leaves unquoted text alone', () => {
  assert.equal(unquotePath('plain.txt'), 'plain.txt')
  assert.equal(unquotePath('"with space.txt"'), 'with space.txt')
  assert.equal(unquotePath(`"uni${BS}303${BS}251.txt"`), 'unié.txt')
  // A literal backslash is written doubled, and the octal escapes around it
  // still decode: only the last backslash of a run is an escape lead-in.
  assert.equal(unquotePath(`"a${BS}${BS}t.txt"`), `a${BS}t.txt`)
  // `\uXXXX` is not a spelling Git emits; an unknown escape drops its lead-in
  // backslash and keeps the character, which is what the C rule prescribes.
  assert.equal(unquotePath(`"uni${BS}u00e9.txt"`), 'uniu00e9.txt')
})

test('destinationOf resolves a rename in all three spellings', () => {
  assert.equal(destinationOf('plain.txt'), 'plain.txt')
  assert.equal(destinationOf('old.txt => new.txt'), 'new.txt')
  assert.equal(destinationOf('sub/{b.txt => c.txt}'), 'sub/c.txt')
  assert.equal(destinationOf('d/{a => b}/e.txt'), 'd/b/e.txt')
})

test('parseNumstat reads the -z records, a rename included', () => {
  // `-z` emits `added \t removed \t path` per file, raw bytes and no quoting; a
  // rename leaves the path field empty and puts the two names in the records
  // that follow.
  const stdout = [
    '1\t1\ta file.txt',
    `1\t1\tunié.txt`,
    '0\t0\t',
    'sub/keep.txt',
    'renamed.txt',
    '-\t-\timg.png',
    '',
  ].join('\0')
  assert.deepEqual([...parseNumstat(stdout)], [
    ['a file.txt', { added: 1, removed: 1 }],
    ['unié.txt', { added: 1, removed: 1 }],
    ['renamed.txt', { added: 0, removed: 0 }],
    ['img.png', { added: null, removed: null }],
  ])
})

test('parseBranchHeader reads each shape git emits', () => {
  assert.deepEqual(parseBranchHeader('## main'), {
    branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0,
  })
  assert.deepEqual(parseBranchHeader('## main...origin/main [ahead 1, behind 2]'), {
    branch: 'main', detached: false, upstream: 'origin/main', ahead: 1, behind: 2,
  })
  assert.deepEqual(parseBranchHeader('## HEAD (no branch)'), {
    branch: null, detached: true, upstream: null, ahead: 0, behind: 0,
  })
  assert.deepEqual(parseBranchHeader('## No commits yet on trunk'), {
    branch: 'trunk', detached: false, upstream: null, ahead: 0, behind: 0,
  })
})

test('parseStatus consumes a rename record and its source', () => {
  const listing = [
    '## main...origin/main [ahead 1]',
    ' M a.txt',
    'R  renamed.txt',
    'olddir/keep.txt',
    '?? fresh.txt',
    '',
  ].join('\0')
  const { summary, entries, truncated } = parseStatus(listing, 100)
  assert.equal(summary.branch, 'main')
  assert.equal(summary.ahead, 1)
  assert.equal(truncated, false)
  assert.deepEqual(entries, [
    { path: 'a.txt', index: ' ', worktree: 'M', renamedFrom: null },
    { path: 'renamed.txt', index: 'R', worktree: ' ', renamedFrom: 'olddir/keep.txt' },
    { path: 'fresh.txt', index: '?', worktree: '?', renamedFrom: null },
  ])
})

test('parseStatus reports a cut listing', () => {
  const listing = ['## main', ' M a', ' M b', ''].join('\0')
  const { entries, truncated } = parseStatus(listing, 1)
  assert.equal(entries.length, 1)
  assert.equal(truncated, true)
})

test('buildTree groups by directory and totals each folder', () => {
  const { directories, files } = buildTree([
    { path: 'README.md', added: 1, removed: 0 },
    { path: 'src/client/a.ts', added: 2, removed: 1 },
    { path: 'src/host/b.ts', added: 3, removed: 0 },
  ])
  // A file with no directory component has no folder to sit in, so it comes
  // back beside the tree rather than being dropped from a list of every change.
  assert.deepEqual(files.map(file => file.path), ['README.md'])
  assert.deepEqual(directories.map(node => [node.name, node.added, node.removed]), [
    ['src', 5, 1],
  ])
  assert.deepEqual(directories[0].directories.map(node => [node.name, node.added, node.removed]), [
    ['client', 2, 1],
    ['host', 3, 0],
  ])
})

test('buildTree folds a chain of single-child directories into one row', () => {
  const { directories } = buildTree([{ path: 'a/b/c/d/leaf.ts', added: 1, removed: 1 }])
  assert.equal(directories.length, 1)
  assert.equal(directories[0].name, 'a/b/c/d')
  assert.equal(directories[0].path, 'a/b/c/d')
  assert.deepEqual(directories[0].files.map(file => file.path), ['a/b/c/d/leaf.ts'])
  assert.equal(directories[0].added, 1)
})

test('buildTree stops folding where a directory branches', () => {
  const { directories } = buildTree([
    { path: 'x/one.ts', added: 1, removed: 0 },
    { path: 'x/y/two.ts', added: 1, removed: 0 },
  ])
  // `x` holds a file, so it is not folded into anything; `y` is its own level.
  assert.deepEqual(directories.map(node => node.name), ['x'])
  assert.deepEqual(directories[0].files.map(file => file.path), ['x/one.ts'])
  assert.deepEqual(directories[0].directories.map(node => node.name), ['y'])
})

test('buildTree counts a binary change as zero rather than poisoning the folder', () => {
  const { directories } = buildTree([
    { path: 'p/img.png', added: null, removed: null },
    { path: 'p/a.ts', added: 4, removed: 2 },
  ])
  assert.equal(directories[0].added, 4)
  assert.equal(directories[0].removed, 2)
})

test('buildTree orders directories before files at every level', () => {
  const { directories } = buildTree([
    { path: 'top/zeta.ts', added: 1, removed: 0 },
    { path: 'top/alpha/b.ts', added: 1, removed: 0 },
    { path: 'top/beta/a.ts', added: 1, removed: 0 },
  ])
  assert.deepEqual(directories[0].directories.map(node => node.name), ['alpha', 'beta'])
  assert.deepEqual(directories[0].files.map(file => file.path), ['top/zeta.ts'])
})

test('buildTree returns nothing for no files', () => {
  assert.deepEqual(buildTree([]), { directories: [], files: [] })
})
