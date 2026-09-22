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
import { dirname, resolve as resolvePath, sep } from 'node:path'
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
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The parsed diff.
   */
  async diff(agent, path, signal) {
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
      'diff', '--no-color', '--no-ext-diff', '--find-renames',
      ...(unborn ? ['--cached'] : ['HEAD']), '--', ...paths.map(quote),
    ]), signal)
    let untracked = false
    if (result.code === 0 && result.stdout.length === 0 && !unborn) {
      // No committed and no staged side means the path is untracked: read it and
      // report its content as pure additions.
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
      return { isRepository: false, root: null, commits: [] }
    }
    const stdout = await this.gitRun(root, [
      'log', `-n${this.config.maxCommits}`, '--no-color', '--no-merges',
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
    return { isRepository: true, root, commits }
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
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The parsed diff, shaped like `diff`.
   */
  async commitDiff(agent, oid, path, signal) {
    const root = this.rootOf(agent)
    this.oidOf(oid)
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\0')) {
      throw new RemoteError('gateway/bad-request', `invalid path ${JSON.stringify(path)}`, {})
    }
    const result = await run(this.git(root, [
      'show', '--no-color', '--no-ext-diff', '--find-renames', '--format=', oid, '--', quote(path),
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
   * Every non-ignored file of the session workspace, as a directory tree.
   *
   * The list comes from `git ls-files --cached --others --exclude-standard`, so
   * `.gitignore` is honoured and the tree is the project's tracked and untracked
   * files — not the contents of `node_modules`. Ignored files are simply absent.
   * @param {object} agent - Target Agent resolved from the Session identity on the wire.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<object>} The tree report; `isRepository: false` when the root is not a work tree.
   */
  async listFiles(agent, signal) {
    const root = this.rootOf(agent)
    if (!(await this.isRepository(root, signal))) {
      return { isRepository: false, root: null, files: [], tree: { directories: [], files: [] }, count: 0, truncated: false }
    }
    const stdout = await this.gitRun(root, [
      'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    ], signal, 'git ls-files')
    const paths = stdout.split('\0').filter(path => path.length > 0)
    const truncated = paths.length > this.config.maxStatusEntries
    const files = (truncated ? paths.slice(0, this.config.maxStatusEntries) : paths).map(path => ({
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
    return { isRepository: true, root, files, tree: buildTree(files), count: files.length, truncated }
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
   * `git diff` omits untracked paths, so the count comes from `--no-index`
   * against the null device — the same read the diff body uses, so Git itself
   * decides the binary case. A path Git reports as binary yields two `null`s.
   * @param {string} root - Absolute workspace root.
   * @param {string} path - Repository-relative path.
   * @param {AbortSignal} signal - Caller cancellation.
   * @returns {Promise<{ added: number|null, removed: number|null }|null>} The counts, or `null` when the read failed.
   */
  async untrackedCount(root, path, signal) {
    const absolute = `${root.replace(/[/\\]+$/, '')}/${path}`
    const result = await run(this.git(root, [
      'diff', '--no-index', '--numstat', '--no-color', '--', '/dev/null', quote(absolute),
    ]), signal)
    // `--no-index` reports a diff through exit 1, which is not a failure here.
    if (result.code !== 0 && result.code !== 1) return null
    const record = result.stdout.split('\n')[0] ?? ''
    const [added, removed] = record.split('\t')
    if (added === undefined || removed === undefined) return null
    return {
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed),
    }
  }
}

export default WorkspaceReview
