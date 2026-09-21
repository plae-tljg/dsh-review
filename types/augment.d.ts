/**
 * Type-only augmentations for `dsh-review`.
 *
 * The plugin is authored in plain JavaScript, so the declaration merges that
 * register its locale namespace and its Remote namespace live here rather than
 * beside the values they describe.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SidebarReviewKey } from '../client/locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Review tab name, file-list chrome, and diff states. */
    sidebarReview: SidebarReviewKey
  }
}

/** One changed file, as `workspaceReview.changes` reports it. */
interface ReviewFileWire {
  readonly path: string
  readonly status: string
  readonly index: string
  readonly worktree: string
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly renamedFrom: string | null
  readonly added: number | null
  readonly removed: number | null
}

/** The report `workspaceReview.changes` returns. */
interface ReviewReportWire {
  readonly isRepository: boolean
  readonly root: string | null
  readonly branch: string | null
  readonly detached: boolean
  readonly upstream: string | null
  readonly ahead: number
  readonly behind: number
  readonly files: readonly ReviewFileWire[]
  readonly added: number
  readonly removed: number
  readonly truncated: boolean
}

/** The parsed diff `workspaceReview.diff` returns. */
interface ReviewDiffWire {
  readonly isRepository: boolean
  readonly untracked: boolean
  readonly truncated: boolean
  readonly file: {
    readonly path: string
    readonly oldPath: string | null
    readonly binary: boolean
    readonly notice: string | null
    readonly hunks: readonly {
      readonly header: string
      readonly oldStart: number
      readonly newStart: number
      readonly oldCount: number
      readonly newCount: number
      readonly lines: readonly {
        readonly kind: 'add' | 'del' | 'ctx'
        readonly text: string
        readonly oldNumber: number | null
        readonly newNumber: number | null
      }[]
    }[]
  } | null
  readonly patch: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The session workspace is not inside a Git work tree. */
    'workspace-review/not-repository': { readonly root: string }
    /** A `git` invocation exited non-zero. */
    'workspace-review/command-failed': { readonly command: string, readonly output: string }
  }
  interface TypertRemoteNamespace$776f726b7370616365526576696577 {
    changes: (agentId: string, signal?: AbortSignal) => Promise<RemoteResult<ReviewReportWire>>
    diff: (agentId: string, path: string, signal?: AbortSignal) => Promise<RemoteResult<ReviewDiffWire>>
  }
  interface TypertRemoteMap {
    'workspaceReview/changes': (agentId: string, signal?: AbortSignal) => Promise<RemoteResult<ReviewReportWire>>
    'workspaceReview/diff': (agentId: string, path: string, signal?: AbortSignal) => Promise<RemoteResult<ReviewDiffWire>>
  }
  interface TypertRemoteNamespaceMap {
    'workspaceReview': TypertRemoteNamespace$776f726b7370616365526576696577
  }
}
