/**
 * `WorkspaceReview` — the Host half of the Review tab.
 *
 * One session's workspace root is read through the `git` CLI and reported over
 * the `workspaceReview` Remote namespace as two reads: `changes`, the branch
 * summary plus one row per changed file with its `+added`/`-removed` counts,
 * and `diff`, the unified diff of one path parsed into hunks.
 *
 * Four constraints shape the implementation:
 *
 * 1. **Paths reach Git as bare repository-relative pathspecs, single-quoted for
 *    the shell**, under the global `--literal-pathspecs`. Anchoring them with
 *    the `:(top,literal)` magic is not an option: `--literal-pathspecs` stops
 *    Git reading `:` as pathspec magic, so that prefix would be matched as a
 *    literal directory name and every path would select nothing. `-C <root>`
 *    is what anchors a relative path at the workspace root.
 * 2. **`-C <root> --literal-pathspecs`** makes every command independent of the
 *    process's working directory and of any glob the caller passed, so a name
 *    holding a space, a `*`, or a newline round-trips exactly.
 * 3. **Everything is capped.** The file list stops at `maxStatusEntries` and
 *    says so; a patch stops at `maxDiffBytes` and arrives as its own prefix.
 * 4. **Nothing writes.** Every invocation reads the repository; no command
 *    stages, commits, stashes, or checks out. `GIT_OPTIONAL_LOCKS=0` also keeps
 *    a refresh from taking an index lock a concurrent Agent operation may want.
 */

import { exec } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { buildTree, parseNameStatus, parseNumstat, parseUnifiedDiff } from './unified.js'

/** Deployment caps on one listing or one patch. */
export const DEFAULT_CONFIG = {
  /** Largest patch, in bytes, that crosses the wire; a larger one arrives cut. */
  maxDiffBytes: 2 * 1024 * 1024,
  /** Cap on reported changed files; the rest is dropped and reported cut. */
  maxStatusEntries: 5000,
  /** Cap on the commits listed in the Commit view. */
  maxCommits: 50,
  /** Largest file the Files view reads, in bytes; a larger one arrives cut. */
  maxFileBytes: 1024 * 1024,
}

/** Stdout budget for one command; a diff larger than this is cut by the pipe, not here. */
const MAX_BUFFER = 32 * 1024 * 1024

/** Generated directories whose contents never belong in the Files browser. */
const HEAVY_DIRS = new Set([
  'node_modules', '__pycache__', '.venv', 'venv', '.tox',
  '.mypy_cache', '.pytest_cache', '.ruff_cache',
  // Build output and caches: as large as `node_modules` and just as
  // uninteresting in a file browser.
  'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt',
  '.turbo', '.cache', '.parcel-cache', '.gradle', '.svelte-kit',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', 'vendor',
])

/** Whether a repository-relative path sits under a heavy directory. */
function isHeavyPath(path) {
  return path.split('/').some(segment => HEAVY_DIRS.has(segment))
}

/**
 * The pathspec excludes that keep the heavy directories out of a listing.
 *
 * They are Git pathspec magic, so the command carrying them must not run
 * under `--literal-pathspecs`: that flag stops Git reading `:` as pathspec
 * magic at all, and the prefix would be matched as a literal name. Every path
 * here is a literal this file owns, so nothing a caller supplies is ever
 * interpreted.
 */
const HEAVY_EXCLUDES = [...HEAVY_DIRS].flatMap(dir => [
  `:(exclude)${dir}`,
  `:(exclude)${dir}/**`,
  `:(exclude)**/${dir}/**`,
])

/** How many leading bytes Git reads when deciding a file is binary. */
const BINARY_SNIFF_BYTES = 8000

/**
 * The line counts Git would report for one untracked file.
 *
 * `git diff` omits untracked paths, so their counts come from the file itself.
 * Git's rule is the number of lines the file holds: every newline starts a
 * line, and a final line without a newline of its own still counts. A file
 * holding a NUL byte in its first 8000 bytes is binary, and Git reports no
 * counts for it.
 *
 * Reading the file is one sequential read. Asking Git for the same number is
 * one *process* per file, and a tree with thousands of untracked files would
 * then fork thousands of git processes at once, which is what made the report
 * time out on a large project.
 * @param {string} absolute - Absolute path of the file.
 * @param {AbortSignal} [signal] - Caller cancellation.
 * @returns {Promise<{ added: number|null, removed: number|null }|null>} The counts, or `null` when the file could not be read.
 */
async function countFileLines(absolute, signal) {
  let handle
  try {
    handle = await fsp.open(absolute, 'r')
  } catch {
    return null
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) return null
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let lines = 0
    let last = -1
    let sawBytes = false
    let head = Buffer.alloc(0)
    for (;;) {
      if (signal?.aborted === true) return null
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      const slice = chunk.subarray(0, bytesRead)
      sawBytes = true
      if (head.length < BINARY_SNIFF_BYTES) {
        head = Buffer.concat([head, slice.subarray(0, BINARY_SNIFF_BYTES - head.length)])
      }
      let at = slice.indexOf(0x0a)
      while (at !== -1) {
        lines += 1
        at = slice.indexOf(0x0a, at + 1)
      }
      last = slice[bytesRead - 1]
    }
    if (head.includes(0x00)) return { added: null, removed: null }
    // A last line with no newline of its own is still a line: a file holding
    // `a` is one line, and a file holding `a\nb` is two.
    const trailing = sawBytes && last !== 0x0a ? 1 : 0
    return { added: lines + trailing, removed: 0 }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Directories that are never walked: VCS metadata and the heavy generated set. */
function isSkippedDirectory(name) {
  return name === '.git' || HEAVY_DIRS.has(name)
}

/**
 * Every file under one directory, as `/`-separated relative paths.
 *
 * The Files view is a workspace browser, so it must answer for a directory that
 * is not a Git work tree at all — a scratch folder, a music library, a
 * downloaded archive. `git ls-files` cannot serve that, because it answers for
 * a repository; this walk is the fallback that keeps the view a file explorer
 * rather than a repository viewer.
 *
 * Three rules keep the traversal safe and bounded:
 *
 * 1. **`.git` and the heavy generated directories are skipped** — the same set
 *    the git listing excludes, so both sources produce the same shape.
 * 2. **A symlinked directory is not followed.** A link pointing back up its own
 *    chain would otherwise recurse forever; a symlink to a file is listed, and
 *    a broken link is skipped.
 * 3. **The entry cap and a directory budget both bound the walk.** A tree whose
 *    folders hold no files cannot exhaust the traversal with a depth-only
 *    guard, so the budget counts visited directories. Hitting either bound sets
 *    `truncated`, which the view states rather than hiding.
 * @param {string} root - Absolute directory to walk.
 * @param {number} cap - Largest number of paths to return.
 * @returns {Promise<{ paths: string[], truncated: boolean }>} Relative paths and whether a bound was hit.
 */
export async function walkWorkspace(root, cap) {
  const paths = []
  /** Directories still to visit; the stack holds relative paths, `''` is the root. */
  const pending = ['']
  // One directory may hold no files at all, so the entry cap alone cannot stop a
  // deep tree; the budget is the second bound.
  let budget = cap
  let truncated = false
  while (pending.length > 0) {
    if (paths.length >= cap || budget <= 0) {
      truncated = true
      break
    }
    budget -= 1
    const relative = /** @type {string} */ (pending.pop())
    let entries
    try {
      entries = await fsp.readdir(relative === '' ? root : join(root, relative), { withFileTypes: true })
    } catch {
      // An unreadable directory (a permission bit, a race with a deletion) is
      // skipped rather than failing the whole listing.
      continue
    }
    const directories = []
    for (const entry of entries) {
      if (isSkippedDirectory(entry.name)) continue
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        directories.push(path)
        continue
      }
      if (entry.isSymbolicLink()) {
        const target = await fsp.stat(join(root, path)).catch(() => null)
        if (target === null || target.isDirectory()) continue
      }
      if (paths.length >= cap) {
        truncated = true
        break
      }
      paths.push(path)
    }
    for (const directory of directories) pending.push(directory)
  }
  paths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  return { paths, truncated }
}

/**
 * Run one shell command to completion.
 *
 * A non-zero exit is not an error here: `git diff --no-index` exits `1` to mean
 * "differences found" and `rev-parse --quiet` exits non-zero to mean "no such
 * ref", so both are answers the caller reads rather than failures.
 * @param {string} command - The full command line, with every path already quoted.
 * @param {AbortSignal} signal - Caller cancellation.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>} The settled run.
 */
function run(command, signal) {
  return new Promise((resolve, reject) => {
    exec(command, {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      signal,
      shell: '/bin/sh',
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        GIT_EXTERNAL_DIFF: '',
      },
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr })
        return
      }
      // The buffer cap cut the pipe: the bytes gathered so far are a valid
      // prefix of a patch, which is what the byte cap is for.
      if (error.code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER') {
        resolve({ code: 0, stdout, stderr })
        return
      }
      if (typeof error.code === 'number') {
        resolve({ code: error.code, stdout, stderr })
        return
      }
      reject(Object.assign(new Error(error.message), {
        spawnFailure: true,
        output: `${stderr}${error.code === 'ENOENT' ? ' (is git installed?)' : ''}`,
      }))
    })
  })
}

/**
 * Single-quote one argument for `/bin/sh`.
 *
 * Closing the quote, emitting an escaped quote, and reopening it is the only
 * form that survives a newline, a backslash, and a `$` alike.
 * @param {string} value - The raw argument.
 * @returns {string} The argument as one shell word.
 */
function quote(value) {
  return `'${value.split("'").join("'\\''")}'`
}

/** Porcelain `XY` pairs that mean an unmerged path. */
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/**
 * Map one porcelain `XY` pair onto the status the UI names.
 * @param {string} index - Staged state letter.
 * @param {string} worktree - Unstaged state letter.
 * @returns {string} The status name.
 */
function statusOf(index, worktree) {
  if (CONFLICT_CODES.has(`${index}${worktree}`)) return 'conflicted'
  if (index === '?' && worktree === '?') return 'untracked'
  // The index side wins when it carries a change, because that is the change a
  // commit would record; the worktree side is the fallback.
  switch (index !== ' ' && index !== '?' ? index : worktree) {
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'typechange'
    default: return 'modified'
  }
}

/**
 * Read the `## …` branch header.
 *
 * Four forms occur: `## main...origin/main [ahead 1, behind 2]`, `## main`,
 * `## HEAD (no branch)`, and `## No commits yet on main`.
 * @param {string} header - The first porcelain record.
 * @returns {{ branch: string|null, detached: boolean, upstream: string|null, ahead: number, behind: number }} The summary.
 */
export function parseBranchHeader(header) {
  const line = header.replace(/^## /, '')
  if (line === '') return { branch: null, detached: false, upstream: null, ahead: 0, behind: 0 }
  if (line === 'HEAD (no branch)') return { branch: null, detached: true, upstream: null, ahead: 0, behind: 0 }
  const state = /\[(.*)]$/.exec(line)?.[1]
  const names = line.replace(/\s*\[.*]$/, '')
  if (names.startsWith('No commits yet on ')) {
    const branch = names.slice('No commits yet on '.length)
    return { branch, detached: false, upstream: null, ahead: 0, behind: 0 }
  }
  const separator = names.indexOf('...')
  const branch = separator < 0 ? names : names.slice(0, separator)
  const upstream = separator < 0 ? '' : names.slice(separator + 3)
  const ahead = /ahead (\d+)/.exec(state ?? '')
  const behind = /behind (\d+)/.exec(state ?? '')
  return {
    branch: branch === '' ? null : branch,
    detached: false,
    upstream: upstream === '' ? null : upstream,
    ahead: ahead === null ? 0 : Number(ahead[1]),
    behind: behind === null ? 0 : Number(behind[1]),
  }
}

/**
 * Parse `git status --porcelain=v1 -z --branch` into a branch summary and rows.
 *
 * The `-z` form carries paths as raw bytes — `unié.txt` arrives as the six
 * bytes of its UTF-8 spelling, not as a C-quoted `"uni\303\251.txt"` — so
 * nothing here decodes an escape. Under `-z` a rename or copy record is
 * followed by its source path as the next record, so the walk consumes two.
 * @param {string} stdout - The raw `-z` listing.
 * @param {number} maxEntries - Cap on reported files; the rest is dropped and reported cut.
 * @returns {{ summary: ReturnType<typeof parseBranchHeader>, entries: Array<{ path: string, index: string, worktree: string, renamedFrom: string|null }>, truncated: boolean }} The parsed listing.
 */
export function parseStatus(stdout, maxEntries) {
  const records = stdout.split('\0').filter(record => record.length > 0)
  const header = records.shift() ?? ''
  const entries = []
  let truncated = false
  for (let at = 0; at < records.length; at += 1) {
    if (entries.length >= maxEntries) {
      truncated = true
      break
    }
    const record = records[at]
    const index = record.slice(0, 1)
    const worktree = record.slice(1, 2)
    const renamedFrom = index === 'R' || index === 'C' ? records[at += 1] ?? null : null
    entries.push({ path: record.slice(3), index, worktree, renamedFrom })
  }
  return { summary: parseBranchHeader(header), entries, truncated }
}

/** Host Remote service reading one session workspace's uncommitted changes. */
export class WorkspaceReview extends TypertRemoteService {
  static inject = ['sandboxPolicy']

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - Host context carrying the sandbox policy.
   * @param {Partial<typeof DEFAULT_CONFIG>} [config] - Overrides for the deployment caps.
   */
  constructor(ctx, config = {}) {
    super(ctx, 'workspaceReview')
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * The branch summary and every uncommitted file of the session's workspace.
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The report; `isRepository: false` when the root is not a work tree.
   */
  async changes(agent, signal) {
    const root = this.rootOf(agent)
    if (!(await this.isRepository(root, signal))) {
      return {
        isRepository: false,
        root: null,
        branch: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        tree: { directories: [], files: [] },
        added: 0,
        removed: 0,
        truncated: false,
      }
    }
    const [status, counts] = await Promise.all([
      this.status(root, signal),
      this.counts(root, signal),
    ])
    // `git diff` never reports an untracked path, so its line counts are read
    // per file with `--no-index`. Without this a new file would carry no counts,
    // contribute zero to its folders, and be missing from the report's total.
    const untrackedPaths = status.entries
      .filter(entry => entry.index === '?' && entry.worktree === '?' && !counts.has(entry.path))
      .map(entry => entry.path)
    const untrackedCounts = new Map(await Promise.all(untrackedPaths.map(async path => (
      [path, await this.untrackedCount(root, path, signal)]
    ))))
    const files = []
    let added = 0
    let removed = 0
    for (const entry of status.entries) {
      const count = counts.get(entry.path) ?? untrackedCounts.get(entry.path) ?? null
      const line = {
        path: entry.path,
        status: statusOf(entry.index, entry.worktree),
        index: entry.index,
        worktree: entry.worktree,
        staged: entry.index !== ' ' && entry.index !== '?',
        unstaged: entry.worktree !== ' ' && entry.worktree !== '?',
        untracked: entry.index === '?' && entry.worktree === '?',
        renamedFrom: entry.renamedFrom,
        added: count === null ? null : count.added,
        removed: count === null ? null : count.removed,
      }
      if (line.added !== null) added += line.added
      if (line.removed !== null) removed += line.removed
      files.push(line)
    }
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    return {
      isRepository: true,
      root,
      ...status.summary,
      files,
      // The directory tree is built here rather than in the browser so both
      // planes share one grouping rule, and so a folder's totals come from the
      // same counts its file rows show.
      tree: buildTree(files),
      added,
      removed,
      truncated: status.truncated,
    }
  }

  /**
   * The unified diff of one changed path, parsed into hunks.
   *
   * The body is the working tree against HEAD, so staged and unstaged edits
   * appear together as one diff against the last commit. A path with no
   * committed and no staged side is untracked, and its whole content is
   * reported as additions.
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {string} path - Repository-relative path from a `changes` row.
   * @param {number} [context] - Lines of unchanged context each hunk carries.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The parsed diff.
   */
  async diff(agent, path, context, signal) {
    const root = this.rootOf(agent)
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\0')) {
      throw new RemoteError('gateway/bad-request', `invalid path ${JSON.stringify(path)}`, {})
    }
    if (!(await this.isRepository(root, signal))) {
      throw new RemoteError('workspace-review/not-repository', `"${root}" is not a Git work tree`, { root })
    }
    const unborn = !(await this.hasHead(root, signal))
    const source = await this.sourceOf(root, path, signal)
    // A bare repository-relative path plus `--literal-pathspecs`. The
    // `:(top,literal)` magic cannot be used here: `--literal-pathspecs` stops
    // Git reading `:` as pathspec magic at all, so that prefix would be matched
    // as a literal directory name and every path would select nothing.
    //
    // A rename needs both of its names: Git does not follow rename detection
    // from the destination alone, so `git diff -- <new>` reports a moved file
    // as an addition of its whole content.
    const paths = source === null ? [path] : [source, path]
    let result = await run(this.git(root, [
      'diff', '--no-color', '--no-ext-diff', '--find-renames', `-U${this.contextOf(context)}`,
      ...(unborn ? ['--cached'] : ['HEAD']), '--', ...paths.map(quote),
    ]), signal)
    let untracked = false
    // Git's index is what makes a path tracked, and `git diff` cannot report a
    // path the index does not carry — so it answers with an empty patch, not
    // with an error. That emptiness is this call's only signal that the path is
    // untracked, which is why the index is asked before the null-device read is
    // taken: a *tracked* path that matches HEAD has no changes to show, and
    // rendering it as its own whole-file addition would invent a diff that Git
    // says does not exist.
    if (result.code === 0 && result.stdout.length === 0 && !(await this.isTracked(root, path, signal))) {
      result = await this.untrackedPatch(root, path, signal)
      untracked = true
    }
    if (result.code !== 0 && result.stdout.length === 0) {
      throw new RemoteError(
        'workspace-review/command-failed',
        `git diff failed for ${JSON.stringify(path)}: ${result.stderr.trim() || `exit ${String(result.code)}`}`,
        { command: `git diff -- ${path}`, output: result.stderr },
      )
    }
    const patch = result.stdout.slice(0, this.config.maxDiffBytes)
    const parsed = parseUnifiedDiff(patch)[0]
    // `git diff --no-index` writes the absolute path it was handed, so the
    // section of an untracked file names a path outside the repository. The
    // row's own path is the one the reader knows, so it is restored here.
    if (untracked && parsed !== undefined) parsed.path = path
    return {
      isRepository: true,
      untracked,
      truncated: result.stdout.length > this.config.maxDiffBytes,
      // A patch with no section of its own is still a change the row named —
      // a pure rename, or a mode change — so the file keeps its path and says
      // why it carries no lines rather than reading as "no diff".
      file: parsed ?? {
        path,
        oldPath: source,
        binary: false,
        notice: 'no-body',
        hunks: [],
      },
      patch,
    }
  }

  /**
   * The recent commits of the session workspace, newest first.
   *
   * Metadata only: a commit's file list is read lazily by `commitChanges`, so
   * opening the Commit view does not pay for a diff of every commit.
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The commit list; `isRepository: false` when the root is not a work tree.
   */
  async commits(agent, signal) {
    const root = this.rootOf(agent)
    if (!(await this.isRepository(root, signal))) {
      return { isRepository: false, root: null, commits: [], truncated: false }
    }
    // One commit past the cap, so a list that was cut is distinguishable from
    // one that happens to end exactly at the cap.
    const stdout = await this.gitRun(root, [
      'log', `-n${this.config.maxCommits + 1}`, '--no-color', '--no-merges',
      '--pretty=format:%H%x00%h%x00%at%x00%an%x00%s%x00',
    ], signal, 'git log')
    const commits = []
    for (const record of stdout.split('\n')) {
      if (record === '') continue
      const [oid, short, at, author, subject] = record.split('\u0000')
      if (oid === undefined || oid === '') continue
      commits.push({
        oid,
        short: short === undefined || short === '' ? oid.slice(0, 7) : short,
        timestamp: Number(at) || 0,
        author: author ?? '',
        subject: subject ?? '',
      })
    }
    const truncated = commits.length > this.config.maxCommits
    if (truncated) commits.length = this.config.maxCommits
    return { isRepository: true, root, commits, truncated }
  }

  /**
   * One commit's changed files, with counts and a directory tree.
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {string} oid - The commit to read.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The commit report.
   */
  async commitChanges(agent, oid, signal) {
    const root = this.rootOf(agent)
    this.oidOf(oid)
    const [numstat, nameStatus] = await Promise.all([
      this.gitRun(root, ['show', '--numstat', '-z', '-M', '--format=', oid], signal, 'git show --numstat'),
      this.gitRun(root, ['show', '--name-status', '-z', '-M', '--format=', oid], signal, 'git show --name-status'),
    ])
    const counts = parseNumstat(numstat)
    const files = []
    let added = 0
    let removed = 0
    for (const entry of parseNameStatus(nameStatus)) {
      const count = counts.get(entry.path) ?? null
      const line = {
        path: entry.path,
        status: entry.status,
        index: ' ',
        worktree: ' ',
        staged: false,
        unstaged: false,
        untracked: false,
        renamedFrom: entry.renamedFrom,
        added: count === null ? null : count.added,
        removed: count === null ? null : count.removed,
      }
      if (line.added !== null) added += line.added
      if (line.removed !== null) removed += line.removed
      files.push(line)
    }
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    return {
      isRepository: true,
      root,
      oid,
      files,
      tree: buildTree(files),
      added,
      removed,
    }
  }

  /**
   * The unified diff of one path within one commit, parsed into hunks.
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {string} oid - The commit to read.
   * @param {string} path - Repository-relative path from a `commitChanges` row.
   * @param {number} [context] - Lines of unchanged context each hunk carries.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The parsed diff, shaped like `diff`.
   */
  async commitDiff(agent, oid, path, context, signal) {
    const root = this.rootOf(agent)
    this.oidOf(oid)
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\0')) {
      throw new RemoteError('gateway/bad-request', `invalid path ${JSON.stringify(path)}`, {})
    }
    const result = await run(this.git(root, [
      'show', '--no-color', '--no-ext-diff', '--find-renames', `-U${this.contextOf(context)}`, '--format=', oid, '--', quote(path),
    ]), signal)
    if (result.code !== 0 && result.stdout.length === 0) {
      throw new RemoteError(
        'workspace-review/command-failed',
        `git show failed for ${JSON.stringify(path)}: ${result.stderr.trim() || `exit ${String(result.code)}`}`,
        { command: `git show ${oid} -- ${path}`, output: result.stderr },
      )
    }
    const patch = result.stdout.slice(0, this.config.maxDiffBytes)
    const parsed = parseUnifiedDiff(patch)[0]
    return {
      isRepository: true,
      untracked: false,
      truncated: result.stdout.length > this.config.maxDiffBytes,
      file: parsed ?? { path, oldPath: null, binary: false, notice: 'no-body', hunks: [] },
      patch,
    }
  }

  /**
   * Every file of the session workspace, as a directory tree.
   *
   * Inside a work tree the list comes from `git ls-files --cached --others
   * --exclude-standard` plus `--ignored`, so `.gitignore` is honoured, `.env` is
   * still visible, and the tree is the project's files rather than the contents
   * of `node_modules`.
   *
   * The Files view is a workspace *browser*, so it does not depend on that
   * answer: a root that is not a work tree — or a `git ls-files` that fails —
   * falls back to {@link walkWorkspace}, which walks the directory itself. A
   * file explorer that goes blank outside a repository is not a file explorer,
   * and the Uncommitted view states the no-repository case on its own.
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The tree report; `isRepository` states which source answered.
   */
  async listFiles(agent, signal) {
    const root = this.rootOf(agent)
    const isRepository = await this.isRepository(root, signal)
    /** @type {{ paths: string[], truncated: boolean }|null} */
    let listed = null
    if (isRepository) {
      // Tracked + untracked, then git-ignored files too: a plain file browser
      // should show `.env` (normally ignored), while the heavy generated
      // directories stay out so the tree is still navigable. The heavy
      // directories are excluded in Git's own pathspec, so a repository whose
      // `node_modules` holds a hundred thousand files never hands them to
      // this process at all.
      try {
        const [tracked, ignored] = await Promise.all([
          this.gitRunListing(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...HEAVY_EXCLUDES], signal, 'git ls-files'),
          this.gitRunListing(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...HEAVY_EXCLUDES], signal, 'git ls-files --ignored'),
        ])
        const cap = this.config.maxStatusEntries
        const unique = new Set()
        let overflow = false
        for (const output of [tracked, ignored]) {
          if (overflow) break
          for (const path of output.split('\0')) {
            if (path === '' || isHeavyPath(path)) continue
            unique.add(path)
            // The cap bounds what is kept, so the set never grows past it.
            if (unique.size > cap) {
              overflow = true
              break
            }
          }
        }
        const paths = [...unique].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        listed = { paths: paths.slice(0, cap), truncated: overflow }
      } catch {
        // A repository Git itself cannot list — a broken object store, a bare
        // directory holding only part of a checkout — still has files on disk.
        listed = null
      }
    }
    if (listed === null) listed = await walkWorkspace(root, this.config.maxStatusEntries)
    const files = (listed.truncated ? listed.paths.slice(0, this.config.maxStatusEntries) : listed.paths).map(path => ({
      path,
      status: 'modified',
      index: ' ',
      worktree: ' ',
      staged: false,
      unstaged: false,
      untracked: false,
      renamedFrom: null,
      added: null,
      removed: null,
    }))
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    return { isRepository, root, files, tree: buildTree(files), count: files.length, truncated: listed.truncated }
  }

  /**
   * Read one workspace file as text.
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {string} path - Repository-relative path.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The text, or a binary/truncated notice with empty text.
   */
  async readFile(agent, path, signal) {
    const root = this.rootOf(agent)
    const absolute = await this.confine(root, path)
    let stat
    try {
      stat = await fsp.stat(absolute)
    } catch {
      throw new RemoteError('workspace-review/not-found', `no such file ${JSON.stringify(path)}`, { path })
    }
    if (!stat.isFile()) throw new RemoteError('workspace-review/not-found', `not a file ${JSON.stringify(path)}`, { path })
    const buffer = await fsp.readFile(absolute)
    const truncated = buffer.length > this.config.maxFileBytes
    const slice = truncated ? buffer.subarray(0, this.config.maxFileBytes) : buffer
    const binary = slice.includes(0)
    return {
      path,
      binary,
      truncated,
      bytes: stat.size,
      text: binary ? '' : slice.toString('utf8'),
    }
  }

  /**
   * Write one workspace file as text (the Files view's opt-in editor).
   *
   * The path is confined to the workspace root, a symlink target is refused, and
   * the write is atomic (a sibling temp file renamed into place).
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {string} path - Repository-relative path.
   * @param {string} text - The new content.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The byte count written.
   */
  async writeFile(agent, path, text, signal) {
    const root = this.rootOf(agent)
    if (typeof text !== 'string') {
      throw new RemoteError('gateway/bad-request', 'text must be a string', {})
    }
    const absolute = await this.confine(root, path)
    const stat = await fsp.lstat(absolute).catch(() => null)
    if (stat !== null && stat.isSymbolicLink()) {
      throw new RemoteError('gateway/bad-request', `refusing to write through a symlink ${JSON.stringify(path)}`, { path })
    }
    const temporary = `${absolute}.dsh-review-${String(process.pid)}.tmp`
    await fsp.writeFile(temporary, text, 'utf8')
    await fsp.rename(temporary, absolute)
    return { path, bytes: Buffer.byteLength(text) }
  }

  /**
   * Resolve one repository-relative path under the workspace root, rejecting an
   * absolute path, a `..` walk, a NUL, and any symlink that leaves the root.
   * @param {string} root - Absolute workspace root.
   * @param {string} path - Repository-relative path.
   * @returns {Promise<string>} The absolute path.
   */
  async confine(root, path) {
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\0')) {
      throw new RemoteError('gateway/bad-request', `invalid path ${JSON.stringify(path)}`, {})
    }
    const rootReal = await fsp.realpath(root)
    const inside = (candidate) => candidate === rootReal || candidate.startsWith(`${rootReal}${sep}`)
    const absolute = resolvePath(root, path)
    const parentReal = await fsp.realpath(dirname(absolute)).catch(() => null)
    if (parentReal === null || !inside(parentReal)) {
      throw new RemoteError('gateway/bad-request', `path escapes the workspace: ${JSON.stringify(path)}`, { path })
    }
    const fileReal = await fsp.realpath(absolute).catch(() => null)
    if (fileReal !== null && !inside(fileReal)) {
      throw new RemoteError('gateway/bad-request', `path escapes the workspace: ${JSON.stringify(path)}`, { path })
    }
    return absolute
  }

  /**
   * Validate a commit id is a hex object name.
   * @param {string} oid - The candidate.
   * @returns {string} The id, unchanged.
   */
  oidOf(oid) {
    if (typeof oid !== 'string' || !/^[0-9a-f]{4,64}$/i.test(oid)) {
      throw new RemoteError('gateway/bad-request', `invalid commit ${JSON.stringify(oid)}`, {})
    }
    return oid
  }

  /**
   * Clamp a requested hunk-context size onto a small, safe range.
   * @param {number|undefined} context - The requested lines of context.
   * @returns {number} Lines of context (default 3).
   */
  contextOf(context) {
    const value = typeof context === 'number' && Number.isFinite(context) ? Math.trunc(context) : 3
    // A large value is the "whole file" request; the byte cap still bounds it.
    return Math.min(100000, Math.max(0, value))
  }

  /**
   * The source path of a rename or copy that produced `path`, else `null`.
   *
   * The status listing is the only place Git states both names. The listing is
   * taken whole and filtered here rather than narrowed with a pathspec: rename
   * detection is a whole-tree comparison, so `status -- <new path>` reports a
   * moved file as a fresh addition and never names its source. Renames are
   * switched on explicitly so the answer cannot depend on the reader's own
   * `status.renames` configuration.
   * @param {string} root - Absolute workspace root.
   * @param {string} path - Repository-relative destination path.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<string|null>} The source path, or `null` when the row is not a rename or copy.
   */
  async sourceOf(root, path, signal) {
    // `--branch` is required, not cosmetic: the parser consumes the first record
    // as the branch header, so a listing without it would lose its first row and
    // read the second row's letters as the branch name.
    const result = await run(this.git(root, [
      'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=no', '-M',
    ]), signal)
    if (result.code !== 0) return null
    const { entries } = parseStatus(result.stdout, this.config.maxStatusEntries)
    return entries.find(entry => entry.path === path)?.renamedFrom ?? null
  }

  /**
   * The session's workspace root, resolved by the policy like the file service does.
   * @param {object} agent - Target Agent resolved from the Session identity.
   * @returns {string} Absolute workspace root.
   */
  rootOf(agent) {
    return this.ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot
  }

  /**
   * One `git -C <root> --literal-pathspecs <args…>` command line.
   * @param {string} root - Absolute workspace root.
   * @param {readonly string[]} args - Already-quoted arguments.
   * @returns {string} The command line.
   */
  git(root, args) {
    return ['git', '-C', quote(root), '--literal-pathspecs', ...args].join(' ')
  }

  /**
   * One `git -C <root> <args…>` command line that keeps pathspec magic.
   *
   * `--literal-pathspecs` stops Git reading `:` as pathspec magic at all, so
   * the exclusion pathspecs need a command without it. Every path such a
   * command carries is a literal this file owns, so nothing a caller supplies
   * is ever interpreted.
   * @param {string} root - Absolute workspace root.
   * @param {readonly string[]} args - Arguments.
   * @returns {string} The command line.
   */
  gitListing(root, args) {
    return ['git', '-C', quote(root), ...args].join(' ')
  }

  /**
   * Run one git command that keeps pathspec magic and must succeed.
   * @param {string} root - Absolute workspace root.
   * @param {readonly string[]} args - Arguments.
   * @param {AbortSignal} signal - Caller cancellation.
   * @param {string} what - Human-readable command name for the failure message.
   * @returns {Promise<string>} Stdout.
   */
  async gitRunListing(root, args, signal, what) {
    const result = await run(this.gitListing(root, args), signal)
    if (result.code !== 0) {
      throw new RemoteError(
        'workspace-review/command-failed',
        `${what} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`,
        { command: what, output: result.stderr },
      )
    }
    return result.stdout
  }

  /**
   * Run one git command that must succeed.
   * @param {string} root - Absolute workspace root.
   * @param {readonly string[]} args - Already-quoted arguments.
   * @param {AbortSignal} signal - Caller cancellation.
   * @param {string} what - Human-readable command name for the failure message.
   * @returns {Promise<string>} Stdout.
   */
  async gitRun(root, args, signal, what) {
    const result = await run(this.git(root, args), signal)
    if (result.code !== 0) {
      throw new RemoteError(
        'workspace-review/command-failed',
        `${what} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`,
        { command: what, output: result.stderr },
      )
    }
    return result.stdout
  }

  /**
   * Whether the root answers `rev-parse --is-inside-work-tree`.
   * @param {string} root - Absolute workspace root.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<boolean>} True when the root is inside a Git work tree.
   */
  async isRepository(root, signal) {
    const result = await run(this.git(root, ['rev-parse', '--is-inside-work-tree']), signal)
    return result.code === 0 && result.stdout.trim() === 'true'
  }

  /**
   * Whether Git's index carries one path.
   *
   * The index — not HEAD — is Git's own answer to "is this path tracked": a file
   * added but never committed is tracked, and a file committed and then removed
   * from the index is not. The listing is taken with `-z` so a path holding a
   * newline or a non-ASCII byte arrives raw, exactly like `changes` does.
   * @param {string} root - Absolute workspace root.
   * @param {string} path - Repository-relative path.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<boolean>} True when the index holds the path.
   */
  async isTracked(root, path, signal) {
    const result = await run(this.git(root, ['ls-files', '--cached', '-z', '--', quote(path)]), signal)
    if (result.code !== 0) return false
    return result.stdout.split('\0').some(entry => entry.length > 0)
  }

  /**
   * Whether HEAD resolves; a repository with no commits has none.
   * @param {string} root - Absolute workspace root.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<boolean>} True when HEAD names a commit.
   */
  async hasHead(root, signal) {
    const result = await run(this.git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']), signal)
    return result.code === 0
  }

  /**
   * The porcelain listing of the root.
   * @param {string} root - Absolute workspace root.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<ReturnType<typeof parseStatus>>} The parsed listing.
   */
  async status(root, signal) {
    const stdout = await this.gitRun(root, [
      'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all',
    ], signal, 'git status')
    return parseStatus(stdout, this.config.maxStatusEntries)
  }

  /**
   * Per-path added and removed counts.
   *
   * `git diff HEAD` covers staged and unstaged changes in one pass. An unborn
   * repository has no HEAD, so the staged half comes from `--cached`.
   * @param {string} root - Absolute workspace root.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<ReturnType<typeof parseNumstat>>} Counts by path.
   */
  async counts(root, signal) {
    const base = await this.hasHead(root, signal) ? 'HEAD' : '--cached'
    const stdout = await this.gitRun(root, ['diff', base, '--numstat', '-z', '-M'], signal, 'git diff --numstat')
    return parseNumstat(stdout)
  }

  /**
   * Render an untracked file as an all-additions unified diff.
   *
   * The file is handed to `git diff --no-index` against the null device so Git
   * itself decides the quoting, the binary case, and the hunk header, and so no
   * second text decoder has to agree with Git about encoding. Exit `1` is this
   * command's success: it means the two sides differ.
   * @param {string} root - Absolute workspace root.
   * @param {string} path - Repository-relative path.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<{ code: number, stdout: string, stderr: string }>} The synthesized diff.
   */
  async untrackedPatch(root, path, signal) {
    const absolute = `${root.replace(/[/\\]+$/, '')}/${path}`
    const result = await run(this.git(root, [
      'diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', quote(absolute),
    ]), signal)
    // `--no-index` reports a diff through exit 1, which is not a failure here.
    return result.code === 1 ? { ...result, code: 0 } : result
  }

  /**
   * Added and removed counts for one untracked path.
   *
   * `git diff` omits untracked paths, so the count is the file's own line
   * count, read from the file rather than forked out to Git per path.
   * @param {string} root - Absolute workspace root.
   * @param {string} path - Repository-relative path.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<{ added: number|null, removed: number|null }|null>} The counts, or `null` when the read failed.
   */
  async untrackedCount(root, path, signal) {
    return countFileLines(join(root, path), signal)
  }
}

export default WorkspaceReview
