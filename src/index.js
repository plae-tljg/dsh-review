/**
 * `dsh-review` — an opencode-style Review tab for the DeepSeek Harness web
 * GUI's right Sidebar.
 *
 * The Host half mounts `WorkspaceReview`, a read-only Git service over one
 * session's workspace root exposed as the `workspaceReview` Remote namespace.
 * The browser half registers the `review` tab type that lists every uncommitted
 * file with its `+added`/`-removed` counts and draws the selected file's
 * unified diff.
 *
 * Nothing here writes to the repository. The whole service is four reads:
 * `rev-parse` for the work-tree and HEAD checks, `status --porcelain` for the
 * file rows, `diff --numstat` for the counts, and `diff` for one patch.
 */

export { WorkspaceReview, DEFAULT_CONFIG } from './host/review.js'
export { parseBranchHeader, parseStatus } from './host/review.js'
export {
  buildTree,
  destinationOf,
  headerPath,
  parseNumstat,
  parseUnifiedDiff,
  sortFiles,
  sortTree,
  unquotePath,
} from './host/unified.js'

/** Host plugin body: the service is the plugin's whole contribution. */
export { WorkspaceReview as default } from './host/review.js'
