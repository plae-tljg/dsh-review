/**
 * Hand-written declarations for `dsh-review`.
 *
 * The plugin is authored in JavaScript so it needs no harness build preset; the
 * types a consumer would import are declared here, and `build/build.mjs` copies
 * this file to `lib/index.d.ts`.
 */

import type { Context } from '@deepseek-ai/cordis'

/** One changed file as the Review tab lists it. */
export interface ReviewFile {
  /** Repository-relative path, always `/`-separated. */
  readonly path: string
  /** What happened to the file. */
  readonly status: ReviewFileStatus
  /** One-letter staged state from `git status --porcelain`; `' '` when clean. */
  readonly index: string
  /** One-letter unstaged state; `' '` when clean. */
  readonly worktree: string
  /** The index side carries a change. */
  readonly staged: boolean
  /** The worktree side carries a change. */
  readonly unstaged: boolean
  /** Git does not track the path yet. */
  readonly untracked: boolean
  /** Source path of a rename or copy, else `null`. */
  readonly renamedFrom: string | null
  /** Lines added, or `null` when Git reports a binary change. */
  readonly added: number | null
  /** Lines removed, or `null` when Git reports a binary change. */
  readonly removed: number | null
}

/** The nine file states a `changes` row can carry. */
export type ReviewFileStatus =
  | 'added' | 'modified' | 'deleted' | 'renamed'
  | 'copied' | 'typechange' | 'untracked' | 'conflicted'

/** The branch summary and every uncommitted file of one workspace. */
export interface ReviewReport {
  /** Whether the session workspace is inside a Git work tree. */
  readonly isRepository: boolean
  /** Absolute workspace root, or `null` when it is not a work tree. */
  readonly root: string | null
  /** Current branch, or `null` on a detached HEAD. */
  readonly branch: string | null
  /** HEAD is detached. */
  readonly detached: boolean
  /** Upstream ref name when one is configured. */
  readonly upstream: string | null
  /** Commits ahead of the upstream. */
  readonly ahead: number
  /** Commits behind the upstream. */
  readonly behind: number
  /** Changed files, ordered by path. */
  readonly files: readonly ReviewFile[]
  /** Total lines added across `files`. */
  readonly added: number
  /** Total lines removed across `files`. */
  readonly removed: number
  /** The file list hit the entry cap. */
  readonly truncated: boolean
}

/** One line of one hunk. */
export interface ReviewLine {
  /** Which side the line belongs to. */
  readonly kind: 'add' | 'del' | 'ctx'
  /** The line without its leading marker. */
  readonly text: string
  /** 1-based old-side line number; `null` for an addition. */
  readonly oldNumber: number | null
  /** 1-based new-side line number; `null` for a deletion. */
  readonly newNumber: number | null
}

/** One `@@` hunk. */
export interface ReviewHunk {
  /** Text after the closing `@@`, usually the enclosing function. */
  readonly header: string
  /** First old-side line of the hunk. */
  readonly oldStart: number
  /** First new-side line of the hunk. */
  readonly newStart: number
  /** Lines the hunk covers on the old side. */
  readonly oldCount: number
  /** Lines the hunk covers on the new side. */
  readonly newCount: number
  /** Body lines in file order. */
  readonly lines: readonly ReviewLine[]
}

/** One parsed file diff. */
export interface ReviewFileDiff {
  /** Destination path, `/`-separated. */
  readonly path: string
  /** Source path for a rename or copy, else `null`. */
  readonly oldPath: string | null
  /** Git reported a binary change. */
  readonly binary: boolean
  /** Why the body is empty despite a change, else `null`. */
  readonly notice: string | null
  /** Parsed hunks, empty for a binary or line-less change. */
  readonly hunks: readonly ReviewHunk[]
}

/** The parsed diff of one path. */
export interface ReviewDiff {
  /** Whether the workspace is a Git work tree. */
  readonly isRepository: boolean
  /** The body was synthesized from the untracked file itself. */
  readonly untracked: boolean
  /** The patch hit the byte cap and is a prefix. */
  readonly truncated: boolean
  /** The parsed file diff, or `null` when the path has no change. */
  readonly file: ReviewFileDiff | null
  /** The raw unified patch, for copying. */
  readonly patch: string
}

/** Deployment caps on one listing or one patch. */
export interface WorkspaceReviewConfig {
  /** Largest patch, in bytes, that crosses the wire; a larger one arrives cut. */
  readonly maxDiffBytes: number
  /** Cap on reported changed files; the rest is dropped and reported cut. */
  readonly maxStatusEntries: number
}

/** Host Remote service reading one session workspace's uncommitted changes. */
export declare class WorkspaceReview {
  /** Cordis services this plugin waits on. */
  static inject: readonly string[]
  /**
   * @param ctx - Host context carrying the sandbox policy.
   * @param config - Overrides for the deployment caps.
   */
  constructor(ctx: Context, config?: Partial<WorkspaceReviewConfig>)
  /**
   * The branch summary and every uncommitted file of the session's workspace.
   * @param agent - Target Agent resolved from the Session identity on the wire.
   * @param signal - Caller cancellation.
   * @returns The report; `isRepository: false` when the root is not a work tree.
   */
  changes(agent: object, signal: AbortSignal): Promise<ReviewReport>
  /**
   * The unified diff of one changed path, parsed into hunks.
   * @param agent - Target Agent resolved from the Session identity on the wire.
   * @param path - Repository-relative path from a `changes` row.
   * @param signal - Caller cancellation.
   * @returns The parsed diff.
   */
  diff(agent: object, path: string, signal: AbortSignal): Promise<ReviewDiff>
}

/** The default deployment caps. */
export declare const DEFAULT_CONFIG: WorkspaceReviewConfig

export default WorkspaceReview
