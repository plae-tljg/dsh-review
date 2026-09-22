/**
 * `dsh-review` — an opencode-style Review panel for the DeepSeek Harness web
 * GUI's right sidebar.
 *
 * The Host half mounts `WorkspaceReview`, a Git-and-files service over one
 * session's workspace root exposed as the `workspaceReview` Remote namespace.
 * The browser half registers the `review` tab type with four sources:
 * uncommitted status, per-round changes, per-commit changes, and a plain file
 * browser with an opt-in editor.
 *
 * Every read is a git or filesystem read except the Files editor's `writeFile`
 * (opt-in, confined to the workspace root). Everything else is unchanged:
 * `status --porcelain` for the file rows, `diff --numstat` for the counts,
 * `diff` for one patch, `log`/`show` for commits, `ls-files` for the tree.
 */

export { WorkspaceReview, DEFAULT_CONFIG } from './host/review.js'
export { parseBranchHeader, parseStatus } from './host/review.js'
export {
  buildTree,
  destinationOf,
  headerPath,
  parseNameStatus,
  parseNumstat,
  parseUnifiedDiff,
  sortFiles,
  sortTree,
  unquotePath,
} from './host/unified.js'

/** Host plugin body: the service is the plugin's whole contribution. */
export { WorkspaceReview as default } from './host/review.js'
