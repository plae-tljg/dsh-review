/**
 * Per-conversation-round file changes, derived in the browser.
 *
 * The Rounds view answers a different question than the Uncommitted view: not
 * "what is different from HEAD right now" but "what did the agent change in
 * each round of this conversation". dsh does not record that as a ready-made
 * list, so this module rebuilds it from the live conversation snapshot:
 *
 * - a settled `tool-result` node is inspected through its call head
 *   (`call.name` + `call.argsRaw`) and its tool-private `meta.diffs`;
 * - Code Mode (`run_code`) sub-calls are walked recursively, and deleted
 *   paths named by literal `rm`-family arguments are kept as display-only rows;
 * - each change is attributed to a round through the chat snapshot's
 *   `turnEnds` and live-turn counters.
 *
 * Everything here is pure and model-free: the vocabulary is the mutation
 * tools' own arguments and result metadata, never the assistant's prose. The
 * Rounds view is a consumer of the snapshot, so it works for committed and
 * uncommitted work alike.
 *
 * Ported from `dsh-file-review-tab` (MIT, © ZhangWenChao / Lzh3070).
 */

import { buildTree } from '../host/unified.js'

/** A terminal command's delete tokens, verbatim only (no globs/substitutions). */
const DELETERS = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'trash',
  'remove-item', 'ri', 'del', 'rd', 'erase',
])

/** PowerShell parameters whose NEXT argument is the path, not an option value. */
const PATH_PARAMETERS = /^-(path|literalpath)$/i

/** A token that can only be a literal path: no glob and no variable expansion. */
function isPathlike(token) {
  if (token === '' || token === '.' || token === '..') return false
  return !/[*?[\]$]/.test(token)
}

/** Split one command line on shell separators, honoring quotes. */
function splitSegments(command) {
  const segments = []
  let current = ''
  let quote = null
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at]
    if (quote !== null) {
      if (char === '\\') {
        const next = command[at + 1]
        if (quote === '"' && next === '"') {
          current += char + '"'
          at += 1
          continue
        }
        current += char
        continue
      }
      if (char === quote) quote = null
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    const two = command.slice(at, at + 2)
    if (two === '&&' || two === '||') {
      segments.push(current)
      current = ''
      at += 1
      continue
    }
    if (char === '|' || char === ';' || char === '\n') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

/** Shell-like tokenization of one segment, quotes joined into the token. */
function tokenize(segment) {
  const tokens = []
  let current = ''
  let quote = null
  const flush = () => {
    if (current !== '') tokens.push(current)
    current = ''
  }
  for (let at = 0; at < segment.length; at += 1) {
    const char = segment[at]
    if (char === undefined) break
    if (quote !== null) {
      if (char === '\\') {
        const next = segment[at + 1]
        if (quote === '"' && (next === '"' || next === '\\')) {
          current += next
          at += 1
          continue
        }
        current += char
        continue
      }
      if (char === quote) {
        quote = null
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      flush()
      continue
    }
    current += char
  }
  flush()
  return tokens
}

/** Literal deletion paths named by one terminal command line, deduplicated. */
export function deletedPathsFromCommand(command) {
  const paths = []
  const seen = new Set()
  const accept = (raw) => {
    for (const part of raw.split(',')) {
      if (!isPathlike(part) || seen.has(part)) continue
      seen.add(part)
      paths.push(part)
    }
  }
  for (const segment of splitSegments(command)) {
    if (segment.includes('$(') || segment.includes('`') || segment.includes('<(')) continue
    const tokens = tokenize(segment)
    let at = 0
    while (at < tokens.length) {
      const head = tokens[at]
      if (head === undefined || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) break
      at += 1
    }
    const commandWord = tokens[at]
    if (commandWord === undefined) continue
    const base = commandWord.slice(Math.max(commandWord.lastIndexOf('/'), commandWord.lastIndexOf('\\')) + 1)
    if (!DELETERS.has(base.toLowerCase())) continue
    for (let index = at + 1; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (token === undefined) continue
      if (token.startsWith('-')) {
        if (PATH_PARAMETERS.test(token) && index + 1 < tokens.length) {
          index += 1
          const named = tokens[index]
          if (named !== undefined) accept(named)
        }
        continue
      }
      accept(token)
    }
  }
  return paths
}

/** Parse one tool call's raw JSON arguments defensively. */
function parseArgs(raw) {
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/** A non-blank string path, or null. */
function pathValue(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * The call-argument-derived mutation intent for one write/edit/str_replace_editor
 * or terminal call. Unknown tools and malformed arguments return null.
 */
export function callIntent(name, argsRaw) {
  const args = parseArgs(argsRaw)
  if (args === null) return null
  const deletions = (name === 'bash' || name === 'pwsh') && typeof args.command === 'string'
    ? deletedPathsFromCommand(args.command)
    : []
  if (name === 'str_replace_editor') {
    const path = pathValue(args.path)
    if (path === null) return null
    if (args.command === 'create') {
      const fileText = args.file_text
      if (fileText !== undefined && typeof fileText !== 'string') return null
      return { path, diffs: [{ path, oldText: null, newText: fileText ?? '' }], deletions }
    }
    if (args.command === 'str_replace') {
      const oldStr = args.old_str
      const newStr = args.new_str
      if (oldStr !== undefined && typeof oldStr !== 'string') return null
      if (newStr !== undefined && typeof newStr !== 'string') return null
      return { path, diffs: [{ path, oldText: oldStr ?? null, newText: newStr ?? '' }], deletions }
    }
    if (args.command === 'insert') {
      const newStr = args.new_str
      if (typeof newStr !== 'string') return null
      return { path, diffs: [{ path, oldText: null, newText: newStr }], deletions }
    }
    return deletions.length === 0 ? null : { path: null, diffs: [], deletions }
  }
  const path = pathValue(args.file_path)
  if (name === 'write') {
    const content = args.content
    if (path === null || typeof content !== 'string') return null
    return { path, diffs: [{ path, oldText: null, newText: content }], deletions }
  }
  if (name === 'edit') {
    const oldString = args.old_string
    const newString = args.new_string
    if (path === null || typeof oldString !== 'string' || typeof newString !== 'string') return null
    return {
      path,
      diffs: [{ path, oldText: oldString === '' ? null : oldString, newText: newString }],
      deletions,
    }
  }
  return deletions.length === 0 ? null : { path: null, diffs: [], deletions }
}

/** Validate the tool-private result metadata's contextual diff hunks. */
export function appliedDiffs(meta) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const diffs = meta.diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return null
  const out = []
  for (const hunk of diffs) {
    if (typeof hunk !== 'object' || hunk === null || Array.isArray(hunk)) return null
    const { path, oldText, newText } = hunk
    if (typeof path !== 'string' || (oldText !== null && typeof oldText !== 'string') || typeof newText !== 'string') return null
    out.push({ path, oldText, newText })
  }
  return out
}

/** The call head of a running or settled tool block, when it carries one. */
function callOf(block) {
  const record = block
  if (record.call !== undefined && record.call !== null) {
    if (typeof record.call.name === 'string' && typeof record.call.argsRaw === 'string') {
      return { name: record.call.name, argsRaw: record.call.argsRaw }
    }
    return null
  }
  if (typeof record.name === 'string' && typeof record.argsRaw === 'string') {
    return { name: record.name, argsRaw: record.argsRaw }
  }
  return null
}

/** The applied hunks for one settled block, or the call-argument intent. */
function blockChanges(block) {
  const call = callOf(block)
  if (call === null) return []
  const intent = callIntent(call.name, call.argsRaw)
  if (intent === null) return []
  const settled = block.isError !== undefined
  if (settled && block.isError) return []
  const changes = []
  if (intent.path !== null) {
    let diffs = intent.diffs
    if (settled) {
      const applied = appliedDiffs(block.meta)
      if (applied !== null) {
        const own = applied.filter(diff => diff.path === intent.path)
        if (own.length > 0) diffs = own
      }
    }
    if (diffs.length > 0) changes.push({ path: intent.path, diffs })
  }
  for (const path of intent.deletions) changes.push({ path, diffs: [], deleted: true })
  return changes
}

/** Settled changes for a tool block tree (the block itself plus `subCalls`). */
function collectChanges(block, out) {
  if (block.kind === 'tool-result') {
    for (const change of blockChanges(block)) out.push(change)
  }
  if (!Array.isArray(block.subCalls)) return
  for (const child of block.subCalls) {
    if (child.kind === 'tool-result') collectChanges(child, out)
  }
}

/** The legacy chat slice of either release's ConversationSnapshot, or undefined. */
function legacySlice(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value
  if (!Array.isArray(record.nodes)
    || !(record.turnEnds instanceof Map)
    || !(record.partial === null || typeof record.partial === 'object')
    || !Array.isArray(record.runningCalls)) return undefined
  return { nodes: record.nodes, turnEnds: record.turnEnds, partial: record.partial, runningCalls: record.runningCalls }
}

/** Normalize a ConversationSnapshot from either release into the chat slice. */
export function normalizeSnapshot(snapshot) {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined
  const direct = legacySlice(snapshot)
  if (direct !== undefined) return direct
  const views = snapshot.views
  if (typeof views !== 'object' || views === null || typeof views.get !== 'function') return undefined
  const chat = views.get('chat')
  if (typeof chat !== 'object' || chat === null) return undefined
  return legacySlice(chat.legacy)
}

/** Attribute an event seq to its owning turn; past the last end is the live turn. */
function turnAttribution(snapshot) {
  const view = normalizeSnapshot(snapshot)
  const ends = [...(view?.turnEnds.entries() ?? [])].sort((a, b) => a[1] - b[1])
  const liveTurn = view?.partial?.turn
    ?? view?.runningCalls[0]?.turn
    ?? ((ends.at(-1)?.[0] ?? 0) + 1)
  return (seq) => {
    for (const [turn, endSeq] of ends) {
      if (endSeq >= seq) return { turn, live: false }
    }
    return { turn: liveTurn, live: true }
  }
}

/** Split one diff side into content lines without a phantom trailing line. */
export function diffContentLines(text) {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * A line-level diff of one contextual hunk, LCS-based.
 *
 * The hunks dsh records are small, so a quadratic table is cheap and exact.
 * @param {string} oldText - The removed side, or the empty string.
 * @param {string} newText - The added side.
 * @returns {Array<{ kind: 'ctx'|'del'|'add', text: string }>} Rows in reading order.
 */
export function lineDiff(oldText, newText) {
  const oldLines = diffContentLines(oldText ?? '')
  const newLines = diffContentLines(newText)
  const n = oldLines.length
  const m = newLines.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const rows = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ kind: 'ctx', text: oldLines[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: 'del', text: oldLines[i] })
      i += 1
    } else {
      rows.push({ kind: 'add', text: newLines[j] })
      j += 1
    }
  }
  while (i < n) {
    rows.push({ kind: 'del', text: oldLines[i] })
    i += 1
  }
  while (j < m) {
    rows.push({ kind: 'add', text: newLines[j] })
    j += 1
  }
  return rows
}

/** Per-file added/removed counts from its contextual hunks. */
export function countHunks(diffs) {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    for (const row of lineDiff(diff.oldText, diff.newText)) {
      if (row.kind === 'add') added += 1
      else if (row.kind === 'del') removed += 1
    }
  }
  return { added, removed }
}

/** The status letter a round's file row shows. */
function statusOfFile(file) {
  if (file.deleted === true) return 'deleted'
  if (file.diffs.length > 0 && file.diffs.every(diff => diff.oldText === null)) return 'added'
  return 'modified'
}

/**
 * One session's rounds, newest first, each with its changed files as report rows.
 *
 * @param {unknown} snapshot - A ConversationSnapshot, or null.
 * @returns {Array<{ turn: number, live: boolean, added: number, removed: number, files: Array<object>, tree: object, count: number }>} The rounds.
 */
export function deriveRounds(snapshot) {
  if (snapshot === null || snapshot === undefined) return []
  const attribute = turnAttribution(snapshot)
  const view = normalizeSnapshot(snapshot)
  const byTurn = new Map()
  for (const node of view?.nodes ?? []) {
    if (node.kind !== 'tool-result' || node.isError) continue
    const changes = []
    collectChanges(node, changes)
    if (changes.length === 0) continue
    const { turn, live } = attribute(node.seq)
    let group = byTurn.get(turn)
    if (group === undefined) {
      group = { live, files: new Map() }
      byTurn.set(turn, group)
    }
    for (const change of changes) {
      const existing = group.files.get(change.path)
      if (change.deleted === true) {
        if (existing === undefined) group.files.set(change.path, { diffs: [], deleted: true })
        else existing.deleted = true
        continue
      }
      if (existing === undefined) group.files.set(change.path, { diffs: [...change.diffs] })
      else {
        existing.diffs.push(...change.diffs)
        delete existing.deleted
      }
    }
  }
  const rounds = []
  for (const [turn, group] of byTurn.entries()) {
    const files = []
    let added = 0
    let removed = 0
    for (const [path, own] of group.files.entries()) {
      const counts = countHunks(own.diffs)
      added += counts.added
      removed += counts.removed
      files.push({
        path,
        status: statusOfFile(own),
        index: ' ',
        worktree: ' ',
        staged: false,
        unstaged: true,
        untracked: false,
        renamedFrom: null,
        added: own.diffs.length === 0 ? null : counts.added,
        removed: own.diffs.length === 0 ? null : counts.removed,
        deleted: own.deleted === true,
        hunks: own.diffs,
      })
    }
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    rounds.push({
      turn,
      live: group.live,
      added,
      removed,
      files,
      count: files.length,
      tree: buildTree(files),
    })
  }
  rounds.sort((left, right) => right.turn - left.turn)
  return rounds
}
