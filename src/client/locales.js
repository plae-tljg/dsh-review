/**
 * `sidebarReview` namespace dictionaries.
 *
 * The file status letters stay verbatim: they are Git's own `--porcelain`
 * vocabulary, and a reader who knows `M`/`A`/`D` should not have to learn a
 * translation of them. Their accessible names are translated instead.
 *
 * The `LocaleNamespaceMap` augmentation that registers this namespace lives in
 * `types/augment.d.ts`, because this package is authored in plain JavaScript
 * and a `declare module` block is not JavaScript syntax.
 */

/**
 * Simplified Chinese dictionary and key-set source of truth: `SidebarReviewKey`
 * is derived from these keys, and `en` below is declared against that union so
 * a key present in one dictionary and missing from the other fails type-check.
 */
export const zh = {
  'type.label': '审阅',
  'guide.title': '未提交的改动',
  'guide.description': '查看工作区里尚未提交的改动',

  refresh: '刷新',
  refreshing: '正在读取…',
  reload: '重新读取',
  expandAll: '展开全部',
  collapseAll: '收起全部',

  'empty.title': '没有未提交的改动',
  'empty.description': '工作区和暂存区都是干净的。',
  'noWorkspace': '这个会话没有工作区目录。',
  'notRepository': '这个工作区不在 Git 仓库里。',
  'truncated': '改动太多，只列出了一部分。',

  staged: '已暂存',
  unstaged: '未暂存',
  'files.count': '{count} 个文件',

  'status.added': '新增',
  'status.modified': '修改',
  'status.deleted': '删除',
  'status.renamed': '重命名',
  'status.copied': '复制',
  'status.typechange': '类型变更',
  'status.untracked': '未跟踪',
  'status.conflicted': '冲突',

  'diff.binary': '这是二进制文件，没有可显示的文本差异。',
  'diff.noBody': '这个改动没有文本内容（例如只是重命名或改了权限）。',
  'diff.truncated': '差异太大，只显示了一部分。',
  'diff.untracked': '这是未跟踪的新文件，下面全是新增内容。',
  'diff.empty': '这个文件没有差异。',
  'diff.copy': '复制差异',
  'diff.copied': '已复制',
  'diff.hunk': '第 {start} 行起',
  'diff.select': '从左侧选一个文件查看差异。',

  'source.uncommitted': '未提交',
  'source.rounds': '按轮次',
  'round.label': '第 {turn} 轮',
  'round.live': '进行中',
  'round.empty': '这个会话还没有文件改动。',
  'round.unavailable': '这个会话的对话数据暂时不可用。',
  'round.select': '从左侧选一个文件查看这一轮的改动。',
  'round.deleted': '这个文件在这一轮被删除，内容已不存在。',
  'round.hunk': '第 {index} 处改动',

  'error.notRepository': '这个工作区不在 Git 仓库里。',
  'error.commandFailed': 'git 命令失败：{message}',
  'error.unavailable': '读取失败：{message}',
}

/**
 * Review dictionary key union. Declared in `types/augment.d.ts` as
 * `keyof typeof zh`, which is the same union a TypeScript source would name
 * here; the `en` dictionary below is what keeps the two key sets equal.
 */

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Review',
  'guide.title': 'Uncommitted changes',
  'guide.description': 'Review changes not yet committed in this workspace',

  refresh: 'Refresh',
  refreshing: 'Reading…',
  reload: 'Reload',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',

  'empty.title': 'No uncommitted changes',
  'empty.description': 'The working tree and the index are both clean.',
  'noWorkspace': 'This session has no workspace directory.',
  'notRepository': 'This workspace is not inside a Git repository.',
  'truncated': 'Too many changes, showing only some of them.',

  staged: 'Staged',
  unstaged: 'Unstaged',
  'files.count': '{count} files',

  'status.added': 'Added',
  'status.modified': 'Modified',
  'status.deleted': 'Deleted',
  'status.renamed': 'Renamed',
  'status.copied': 'Copied',
  'status.typechange': 'Type changed',
  'status.untracked': 'Untracked',
  'status.conflicted': 'Conflicted',

  'diff.binary': 'This is a binary file, so there is no text diff to show.',
  'diff.noBody': 'This change carries no text (a rename, or a permission change).',
  'diff.truncated': 'The diff is too large, so only part of it is shown.',
  'diff.untracked': 'This is an untracked new file, so everything below is an addition.',
  'diff.empty': 'This file has no diff.',
  'diff.copy': 'Copy diff',
  'diff.copied': 'Copied',
  'diff.hunk': 'from line {start}',
  'diff.select': 'Pick a file on the left to see its diff.',

  'source.uncommitted': 'Uncommitted',
  'source.rounds': 'By round',
  'round.label': 'Round {turn}',
  'round.live': 'live',
  'round.empty': 'No file changes in this conversation yet.',
  'round.unavailable': 'This session\'s conversation data is not available yet.',
  'round.select': 'Pick a file on the left to see its change in this round.',
  'round.deleted': 'This file was deleted in this round, so its content is gone.',
  'round.hunk': 'Change {index}',

  'error.notRepository': 'This workspace is not inside a Git repository.',
  'error.commandFailed': 'A git command failed: {message}',
  'error.unavailable': 'Read failed: {message}',
}
