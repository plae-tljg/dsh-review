/**
 * Wire vocabulary of the `workspaceReview` Remote namespace.
 *
 * These are plain strings on the wire; the codecs that validate them live in
 * `typert.host.js` and `client/remote.js`. Nothing here imports a harness
 * package, so the module is safe on both planes.
 */

/** @typedef {'added'|'modified'|'deleted'|'renamed'|'copied'|'typechange'|'untracked'|'conflicted'} ReviewFileStatus */

/**
 * @typedef {object} ReviewFile
 * @property {string} path Repository-relative path, always `/`-separated.
 * @property {ReviewFileStatus} status What happened to the file.
 * @property {string} index One-letter staged state from `git status --porcelain`; `' '` when clean.
 * @property {string} worktree One-letter unstaged state from `git status --porcelain`; `' '` when clean.
 * @property {boolean} staged The index side carries a change.
 * @property {boolean} unstaged The worktree side carries a change.
 * @property {boolean} untracked Git does not track the file yet.
 * @property {string|null} renamedFrom Source path of a rename or copy.
 * @property {number|null} added Lines added, or `null` when Git reports a binary change.
 * @property {number|null} removed Lines removed, or `null` when Git reports a binary change.
 */

/**
 * @typedef {object} ReviewReport
 * @property {boolean} isRepository Whether the session workspace is inside a Git work tree.
 * @property {string|null} root Absolute workspace root the report was taken from.
 * @property {string|null} branch Current branch, or `null` on a detached HEAD.
 * @property {boolean} detached HEAD is detached.
 * @property {string|null} upstream Upstream ref name when one is configured.
 * @property {number} ahead Commits ahead of the upstream.
 * @property {number} behind Commits behind the upstream.
 * @property {ReviewFile[]} files Changed files, ordered by path.
 * @property {{ directories: ReviewTreeNode[], files: ReviewFile[] }} tree The same files grouped into directories, each folder carrying the totals for what it holds, plus the files that sit at the repository root.
 * @property {number} added Total lines added across `files`.
 * @property {number} removed Total lines removed across `files`.
 * @property {boolean} truncated The file list hit the entry cap.
 */

/**
 * One directory in the report's tree.
 *
 * `added` and `removed` are the totals for everything the directory holds, so a
 * collapsed folder still states its size, and `name` is the joined prefix when a
 * chain of single-child directories was folded into one row.
 * @typedef {object} ReviewTreeNode
 * @property {'directory'} kind Discrimination for a reader that also walks file rows.
 * @property {string} name Directory name to draw: one component, or a folded `a/b/c` prefix.
 * @property {string} path Repository-relative path of the deepest folded directory.
 * @property {ReviewTreeNode[]} directories Child directories, ordered.
 * @property {ReviewFile[]} files Files directly in this directory, ordered.
 * @property {number} added Total lines added below this directory.
 * @property {number} removed Total lines removed below this directory.
 */

/**
 * @typedef {object} ReviewDiffFile
 * @property {string} path The path the diff is for.
 * @property {string|null} oldPath Source path of a rename, else `null`.
 * @property {boolean} binary Git reported the change as binary, so `hunks` is empty.
 * @property {string|null} notice Why the body is empty despite a change, else `null`.
 * @property {import('./unified.js').ReviewHunk[]} hunks Parsed hunks in file order.
 */

/**
 * @typedef {object} ReviewDiff
 * @property {boolean} isRepository Whether the workspace is a Git work tree.
 * @property {ReviewFileStatus|null} status The file's status in the current report.
 * @property {boolean} untracked The body was synthesized from the untracked file itself.
 * @property {boolean} truncated The patch hit the byte cap and is a prefix.
 * @property {ReviewDiffFile|null} file The parsed file diff, or `null` when the file has no change.
 * @property {string} patch The raw unified patch, for copying.
 */

export {}
