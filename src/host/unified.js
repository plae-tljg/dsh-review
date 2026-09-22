/**
 * Unified-diff parser for the `workspaceReview` namespace.
 *
 * `git diff` emits one `diff --git` section per file; each section carries
 * optional `index`/`---`/`+++` headers, an optional `Binary files …` line, and
 * zero or more `@@ -old,count +new,count @@` hunks. Only what the Review tab
 * draws is retained: paths, hunk coordinates, and per-line old/new numbers.
 *
 * Parsing on the Host means one parser for every client and keeps the wire
 * payload free of raw patch text the UI would have to re-scan.
 *
 * Two Git output conventions drive the path handling, and neither is optional:
 *
 * 1. **The `diff --git` line is ambiguous.** For a path holding a space Git
 *    writes `diff --git a/x y b/x y` with no delimiter between the sides, so
 *    that line cannot be split back into two paths. The `---`/`+++` headers
 *    carry one path each and the `rename from`/`rename to` headers carry one
 *    each, so those are what this module reads.
 * 2. **Git quotes paths.** A path holding a non-ASCII byte, a control
 *    character, a quote, or a backslash is written as a C string inside double
 *    quotes — `"uni\u00e9.txt"`. `core.quotepath=false` only widens which bytes
 *    stay literal; it does not stop the quoting. Every path read here goes
 *    through {@link unquotePath}, so the report always carries decoded bytes.
 */

/**
 * @typedef {'add'|'del'|'ctx'} ReviewLineKind
 */

/**
 * @typedef {object} ReviewLine
 * @property {ReviewLineKind} kind Which side the line belongs to.
 * @property {string} text The line without its leading marker or trailing newline.
 * @property {number|null} oldNumber 1-based line number on the old side; `null` for an addition.
 * @property {number|null} newNumber 1-based line number on the new side; `null` for a deletion.
 */

/**
 * @typedef {object} ReviewHunk
 * @property {string} header Text after the closing `@@`, usually the enclosing function.
 * @property {number} oldStart First old-side line of the hunk.
 * @property {number} newStart First new-side line of the hunk.
 * @property {number} oldCount Lines the hunk covers on the old side.
 * @property {number} newCount Lines the hunk covers on the new side.
 * @property {ReviewLine[]} lines Body lines in file order.
 */

/**
 * @typedef {object} ReviewFileDiff
 * @property {string} path Destination path, `/`-separated.
 * @property {string|null} oldPath Source path for a rename or copy, else `null`.
 * @property {boolean} binary Git reported a binary change.
 * @property {string|null} notice Why a section body is empty although the file changed.
 * @property {ReviewHunk[]} hunks Parsed hunks.
 */

/** `@@ -12,3 +14,5 @@ optional section heading` — both counts are optional in the format. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/**
 * Decode one path field Git may have rendered as a quoted C string.
 *
 * Git quotes a path that holds a non-ASCII byte, a control character, a quote,
 * or a backslash, and escapes it the way C does: `\"` for a quote, `\\` for a
 * backslash, `\t`/`\n`/`\r`/`\f`/`\v`/`\b`/`\a` for the control characters,
 * and `\NNN` — **octal**, not `\uXXXX` — for every byte outside printable
 * ASCII. A UTF-8 filename therefore arrives as one octal escape per *byte*,
 * which is why the escapes are collected into bytes and decoded as UTF-8 rather
 * than mapped character by character.
 *
 * `JSON.parse` cannot do this: it rejects `\303` outright, and the `\uXXXX`
 * spelling it does accept is not what Git writes.
 *
 * A doubled backslash is one literal backslash, per the C rule. This decoder
 * serves the `Binary files …` line only: the report's paths come from `-z`
 * listings, which carry raw bytes and need no decoding at all, so the awkward
 * case of a real filename holding a backslash cannot reach here. A field Git
 * did not quote is returned unchanged.
 * @param {string} field - A path field, without the surrounding header text.
 * @returns {string} The path as written on disk.
 */
export function unquotePath(field) {
  if (field.length < 2 || !field.startsWith('"') || !field.endsWith('"')) return field
  const body = field.slice(1, -1)
  /** Bytes outside ASCII are accumulated so one UTF-8 sequence decodes as one character. */
  const bytes = []
  for (let at = 0; at < body.length; at += 1) {
    const character = body[at]
    if (character !== '\\') {
      const code = /** @type {number} */ (character.codePointAt(0))
      if (code < 0x80) bytes.push(code)
      else bytes.push(...new TextEncoder().encode(character))
      continue
    }
    const after = body[at + 1]
    if (after === undefined) break
    if (after >= '0' && after <= '7') {
      // Octal escapes are one to three digits; Git always pads to three. They
      // carry a byte, not a code point, which is why the output is decoded as
      // UTF-8 at the end rather than built as a string here.
      let digits = ''
      while (digits.length < 3 && body[at + 1] >= '0' && body[at + 1] <= '7') {
        digits += body[at + 1]
        at += 1
      }
      bytes.push(Number.parseInt(digits, 8) & 0xff)
      continue
    }
    const simple = SIMPLE_ESCAPES[after]
    if (simple !== undefined) bytes.push(simple)
    else bytes.push(...new TextEncoder().encode(after))
    at += 1
  }
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes))
}

/** The single-character C escapes Git writes inside a quoted path. */
const SIMPLE_ESCAPES = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  '\\': 0x5c,
}

/**
 * Remove the diff prefix from one `---` or `+++` header path.
 *
 * Git writes `a/path` and `b/path`, or — when it chose to quote the path — the
 * prefixed path inside the quotes, `"b/path"`. `/dev/null` marks the absent
 * side of a creation or deletion. A modification whose path holds a trailing
 * tab appends one to this header, so trailing whitespace is stripped first.
 * @param {string} field - The header text after the three-character marker and space.
 * @returns {string} The path as written on disk, or `''` for `/dev/null`.
 */
export function headerPath(field) {
  const trimmed = field.replace(/\s+$/, '')
  if (trimmed === '/dev/null') return ''
  const decoded = unquotePath(trimmed)
  const slash = decoded.indexOf('/')
  if (slash === 1 && (decoded.startsWith('a/') || decoded.startsWith('b/'))) return decoded.slice(2)
  return decoded
}

/**
 * The destination path of a `--numstat` or `--name-status` path field.
 *
 * Git renders a rename three ways: a plain path, `old => new`, and the brace
 * form `dir/{old => new}/file` when only part of the path moved. Git quotes
 * per side, so each side is decoded separately.
 * @param {string} field - The path field of one record.
 * @returns {string} The destination path.
 */
export function destinationOf(field) {
  const arrow = field.indexOf(' => ')
  if (arrow < 0) return unquotePath(field)
  const before = unquotePath(field.slice(0, arrow))
  const after = unquotePath(field.slice(arrow + 4))
  const open = before.lastIndexOf('{')
  const close = after.indexOf('}')
  if (open < 0 || close < 0) return after
  return before.slice(0, open) + after.slice(0, close) + after.slice(close + 1)
}

/**
 * The destination path stated by a `Binary files …` line.
 *
 * Git writes `Binary files a/old and b/new differ`, and `Binary files
 * /dev/null and b/new differ` for a binary creation. A binary or mode-only
 * change carries no `---`/`+++` headers at all, so this line is the only place
 * the section names its path, and without it the section would be dropped as
 * pathless. The separator is the last ` and `, because a path may contain one.
 * @param {string} line - The `Binary files …` line.
 * @returns {string} The destination path, or `''` when the line names none.
 */
function binaryPath(line) {
  const body = line.slice('Binary files '.length).replace(/ differ$/, '')
  const at = body.lastIndexOf(' and ')
  if (at < 0) return ''
  return headerPath(body.slice(at + ' and '.length))
}

/**
 * Parse one `git diff` patch into per-file hunks.
 *
 * A section with no `@@` body yields `binary: true` when Git said so, and a
 * `notice` when the change is real but carries no lines — a pure rename, a
 * mode change, or an empty file created or deleted.
 * @param {string} patch - Raw unified diff, possibly empty.
 * @returns {ReviewFileDiff[]} One entry per file section, in patch order.
 */
export function parseUnifiedDiff(patch) {
  /** @type {ReviewFileDiff[]} */
  const files = []
  /** @type {ReviewFileDiff|null} */
  let file = null
  /** @type {ReviewHunk|null} */
  let hunk = null
  let oldCursor = 0
  let newCursor = 0
  /** The `+++` path of the section being read; `''` marks `/dev/null`. */
  let plusPath = null
  /** The `---` path of the section being read; `''` marks `/dev/null`. */
  let minusPath = null

  /** Close the hunk in progress, keeping it only when it holds body lines. */
  const closeHunk = () => {
    if (hunk !== null && hunk.lines.length > 0 && file !== null) file.hunks.push(hunk)
    hunk = null
  }

  /**
   * Settle the section's destination path.
   *
   * `+++` names a created or modified path, `---` names a deleted one, and a
   * rename with no line changes names neither, so its `rename to` was used.
   */
  const closeFile = () => {
    closeHunk()
    if (file !== null) {
      if (file.path === '' && plusPath !== null) file.path = plusPath
      if (file.path === '' && minusPath !== null && minusPath !== '') file.path = minusPath
      if (file.hunks.length === 0 && !file.binary) file.notice = 'no-body'
      if (file.path !== '') files.push(file)
    }
    file = null
    plusPath = null
    minusPath = null
  }

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      closeFile()
      file = { path: '', oldPath: null, binary: false, notice: null, hunks: [] }
      continue
    }
    if (file === null) continue

    if (line.startsWith('--- ')) {
      minusPath = headerPath(line.slice(4))
      continue
    }
    if (line.startsWith('+++ ')) {
      plusPath = headerPath(line.slice(4))
      continue
    }
    // A rename states both sides exactly, which is the only source of the
    // source path for a rename that changes no lines.
    if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      file.oldPath = headerPath(line.slice('rename from '.length))
      continue
    }
    if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      file.path = headerPath(line.slice('rename to '.length))
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true
      if (line.startsWith('Binary files ')) {
        const stated = binaryPath(line)
        if (stated !== '') file.path = stated
      }
      continue
    }

    if (hunk === null) {
      if (!line.startsWith('@@')) continue
      const match = HUNK_HEADER.exec(line)
      if (match === null) continue
      oldCursor = Number(match[1])
      newCursor = Number(match[3])
      hunk = {
        header: match[5] ?? '',
        oldStart: oldCursor,
        newStart: newCursor,
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      }
      continue
    }

    const marker = line.slice(0, 1)
    if (marker === '-') {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldNumber: oldCursor, newNumber: null })
      oldCursor += 1
      continue
    }
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: line.slice(1), oldNumber: null, newNumber: newCursor })
      newCursor += 1
      continue
    }
    if (marker === ' ') {
      hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldNumber: oldCursor, newNumber: newCursor })
      oldCursor += 1
      newCursor += 1
      continue
    }
    // `\ No newline at end of file` annotates the line above and carries no
    // coordinates of its own; anything else ends the hunk.
    if (marker === '\\') continue
    closeHunk()
  }

  closeFile()
  return files
}

/**
 * Parse `git diff --numstat -z` output into per-path counts.
 *
 * The `-z` form is NUL-terminated and carries paths as raw bytes, so no escape
 * decoding is involved. Each record is `added \t removed \t path`; a rename
 * emits `added \t removed \t \0 old \0 new \0`, so an empty path field means the
 * next two records are the source and the destination.
 * @param {string} stdout - Raw `--numstat -z` output.
 * @returns {Map<string, { added: number|null, removed: number|null }>} Counts by destination path.
 */
export function parseNumstat(stdout) {
  /** @type {Map<string, { added: number|null, removed: number|null }>} */
  const counts = new Map()
  const records = stdout.split('\0')
  for (let at = 0; at < records.length; at += 1) {
    const record = records[at]
    if (record === undefined || record.length === 0) continue
    const first = record.indexOf('\t')
    if (first < 0) continue
    const second = record.indexOf('\t', first + 1)
    if (second < 0) continue
    const added = record.slice(0, first)
    const removed = record.slice(first + 1, second)
    const path = record.slice(second + 1)
    const target = path === '' ? records[at += 2] ?? '' : path
    if (target === '') continue
    counts.set(target, {
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed),
    })
  }
  return counts
}

/** The status letter `git --name-status` prints, mapped to the report vocabulary. */
const NAME_STATUS = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  T: 'typechange',
  R: 'renamed',
  C: 'copied',
}

/**
 * Parse `git show --name-status -z` (or `diff-tree`) into per-path status rows.
 *
 * The `-z` form is NUL-separated: one record per change, `STATUS\0path\0`, and a
 * rename or copy occupies three fields (`R100\0old\0new\0`). The status letter is
 * mapped onto the same vocabulary the porcelain listing uses.
 * @param {string} stdout - Raw `--name-status -z` output.
 * @returns {Array<{ path: string, status: string, renamedFrom: string|null }>} One entry per changed path.
 */
export function parseNameStatus(stdout) {
  const records = stdout.split('\0')
  const entries = []
  for (let at = 0; at < records.length; at += 1) {
    const code = records[at]
    if (code === undefined || code.length === 0) continue
    const letter = code.slice(0, 1)
    if (letter === 'R' || letter === 'C') {
      const from = records[at + 1] ?? ''
      const to = records[at + 2] ?? ''
      at += 2
      if (to !== '') entries.push({ path: to, status: NAME_STATUS[letter], renamedFrom: from })
      continue
    }
    const path = records[at + 1] ?? ''
    at += 1
    if (path !== '') entries.push({ path, status: NAME_STATUS[letter] ?? 'modified', renamedFrom: null })
  }
  return entries
}

/**
 * Group changed files into the directory tree a review list draws.
 *
 * A path is split on `/`, so a nested path contributes one level per component.
 * Each node's `added` and `removed` are the totals for everything below it, so a
 * collapsed folder still states what it holds. A chain of directories with a
 * single child each is folded into the first of them — `src/client/` is one
 * disclosure rather than three — which is what keeps a deep tree readable.
 *
 * A file whose line counts are unknown (a binary change) contributes `0` to its
 * folders' totals rather than poisoning them to `null`: the folder is still a
 * folder, and the file's own row says "bin".
 *
 * A file with no directory component has no folder to sit in, so it is returned
 * in `files` rather than dropped — the reader must not have to notice that
 * `README.md` is missing from a tree that claims to list every change.
 * @param {readonly { path: string, added: number|null, removed: number|null }[]} files - Report rows.
 * @returns {{ directories: ReviewTreeNode[], files: any[] }} Folded directories in display order, then the repository-root files.
 */
export function buildTree(files) {
  /** @type {Map<string, any>} */
  const nodes = new Map()
  /** @type {any} */
  const root = { name: '', path: '', directories: [], files: [], added: 0, removed: 0 }
  nodes.set('', root)
  for (const file of files) {
    const parts = file.path.split('/')
    let parent = root
    for (let at = 0; at < parts.length - 1; at += 1) {
      const name = parts[at]
      const path = parent.path === '' ? name : `${parent.path}/${name}`
      let child = nodes.get(path)
      if (child === undefined) {
        child = { name, path, directories: [], files: [], added: 0, removed: 0 }
        nodes.set(path, child)
        parent.directories.push(child)
      }
      parent = child
    }
    parent.files.push(file)
  }
  // Totals accumulate bottom-up, so a parent states what everything below holds.
  const settle = (node) => {
    for (const child of node.directories) {
      settle(child)
      node.added += child.added
      node.removed += child.removed
    }
    for (const file of node.files) {
      node.added += file.added ?? 0
      node.removed += file.removed ?? 0
    }
  }
  settle(root)
  return { directories: sortTree(root.directories.map(fold)), files: sortFiles(root.files) }
}

/**
 * Order file rows by path.
 * @param {any[]} files - Report rows.
 * @returns {any[]} A new array, ordered by path.
 */
export function sortFiles(files) {
  return [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

/**
 * Fold a directory whose descendants form a chain of single directories.
 *
 * `fold` stops at the first level that holds a file or branches, and the folded
 * row carries the joined names so the reader sees the whole prefix at once.
 * @param {any} node - A directory node with totals already accumulated.
 * @returns {ReviewTreeNode} The node to draw, possibly renamed to a joined path.
 */
function fold(node) {
  let head = node
  let name = node.name
  while (head.files.length === 0 && head.directories.length === 1) {
    head = head.directories[0]
    name = `${name}/${head.name}`
  }
  return {
    kind: 'directory',
    name,
    path: head.path,
    directories: head.directories.map(fold),
    files: head.files,
    added: node.added,
    removed: node.removed,
  }
}

/**
 * Sort a tree's every level for display: directories before files, each by name,
 * so a refresh cannot reshuffle the reader's view.
 * @param {any[]} nodes - Directory nodes to order.
 * @returns {any[]} The same nodes, ordered, with their own levels ordered too.
 */
export function sortTree(nodes) {
  const ordered = [...nodes].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  for (const node of ordered) {
    node.directories = sortTree(node.directories)
    node.files = sortFiles(node.files)
  }
  return ordered
}
