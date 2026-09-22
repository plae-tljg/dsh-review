/**
 * The Review tab's body.
 *
 * One panel, two sources of change:
 *
 * - **Uncommitted** — the working tree against HEAD, read over the
 *   `workspaceReview` Remote namespace, as a directory tree with per-file
 *   `+added`/`-removed` counts, the branch's grand totals, and the selected
 *   file's unified diff.
 * - **Rounds** — what the agent changed in each conversation round, derived in
 *   the browser from the live conversation snapshot, shown with the same tree
 *   and the same red/green body.
 *
 * A source switch in the header chooses between them; the tree rows, the
 * counts and the diff renderer are shared, so the two views read alike. The
 * list is a directory tree rather than a flat list of paths because a real
 * change touches several files under the same few directories, and a flat list
 * makes the reader reconstruct that grouping from the middle of every path.
 */

import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import css from './ReviewBody.module.css'
import { deriveRounds, lineDiff } from './rounds.js'
import { loadView, saveView } from './view-state.js'

/** The single letter a status shows, matching Git's own porcelain vocabulary. */
const STATUS_LETTER = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: 'U',
  conflicted: '!',
}

/** A tree with nothing in it; a stable identity so the memo never churns. */
const EMPTY_TREE = { directories: [], files: [] }

/** A map with nothing in it, for the same reason. */
const EMPTY_STATE = {}

/** A list with nothing in it, for the same reason. */
const EMPTY_LIST = []

/** The basename of a repository path. */
function baseName(path) {
  const at = path.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}

/**
 * The `+added`/`-removed` pair one row shows.
 * @param {object} props - Row props.
 * @returns {import('react').ReactNode} The counts.
 */
function Counts({ added, removed, binary }) {
  if (binary) return <span className={css.binary}>bin</span>
  if (added === 0 && removed === 0) return null
  return (
    <>
      {added > 0 && <span className={css.added}>+{added}</span>}
      {removed > 0 && <span className={css.removed}>-{removed}</span>}
    </>
  )
}

/** How many files a directory holds, at every depth. */
function countFiles(node) {
  let total = node.files.length
  for (const child of node.directories) total += countFiles(child)
  return total
}

/** Collect every directory path in a tree, for the expand-all and collapse-all gesture. */
function directoryPaths(nodes, into = new Set()) {
  for (const node of nodes) {
    into.add(node.path)
    directoryPaths(node.directories, into)
  }
  return into
}

/**
 * The paths a case-insensitive substring query admits, across a whole tree.
 * @param {{ directories: any[], files: any[] }} tree - A report tree.
 * @param {string} query - The lower-cased query (empty admits everything).
 * @returns {Set<string>} The matching file paths.
 */
function matchingPaths(tree, query) {
  const keep = new Set()
  const walk = (nodes) => {
    for (const node of nodes) {
      for (const file of node.files) if (file.path.toLowerCase().includes(query)) keep.add(file.path)
      walk(node.directories)
    }
  }
  walk(tree.directories)
  for (const file of tree.files) if (file.path.toLowerCase().includes(query)) keep.add(file.path)
  return keep
}

/**
 * Keep only the files a query admits, dropping every directory left empty.
 * @param {{ directories: any[], files: any[] }} tree - A report tree.
 * @param {string} query - The lower-cased query.
 * @returns {{ directories: any[], files: any[] }} The pruned tree.
 */
function filterTree(tree, query) {
  if (query === '') return tree
  const keep = matchingPaths(tree, query)
  return { directories: pruneTree(tree.directories, keep), files: tree.files.filter(file => keep.has(file.path)) }
}

/**
 * The left rail's file filter.
 * @param {object} props - The value and change handler.
 * @returns {import('react').ReactNode} The sticky filter row.
 */
function FilterBox({ value, onChange, t }) {
  return (
    <div className={css.filterBox}>
      <input
        type="search"
        className={css.filterInput}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('filter.placeholder')}
        aria-label={t('filter.placeholder')}
        spellCheck={false}
        data-review-filter
      />
    </div>
  )
}

/**
 * The expand-all / collapse-all control for one tree.
 * @param {object} props - The tree's directories, its collapsed set, and the setter.
 * @returns {import('react').ReactNode} The button, or null when the tree has no folder.
 */
function CollapseButton({ directories, collapsed, onCollapse, t }) {
  const every = directoryPaths(directories)
  if (every.size === 0) return null
  const allCollapsed = collapsed.size >= every.size
  return (
    <button
      type="button"
      className={css.action}
      onClick={() => onCollapse(allCollapsed ? new Set() : every)}
      title={allCollapsed ? t('expandAll') : t('collapseAll')}
      aria-label={allCollapsed ? t('expandAll') : t('collapseAll')}
      data-review-collapse={allCollapsed ? 'expand' : 'collapse'}
    >
      {allCollapsed ? '⊞' : '⊟'}
    </button>
  )
}

/**
 * Keep only the files a predicate admits, dropping every directory left empty.
 * @param {any[]} nodes - Directory nodes from the report.
 * @param {Set<string>} keep - Paths of the files the filter admits.
 * @returns {any[]} The nodes that still hold something, with fresh totals.
 */
function pruneTree(nodes, keep) {
  const kept = []
  for (const node of nodes) {
    const directories = pruneTree(node.directories, keep)
    const files = node.files.filter(file => keep.has(file.path))
    if (directories.length === 0 && files.length === 0) continue
    let added = 0
    let removed = 0
    for (const child of directories) {
      added += child.added
      removed += child.removed
    }
    for (const file of files) {
      added += file.added ?? 0
      removed += file.removed ?? 0
    }
    kept.push({ ...node, directories, files, added, removed })
  }
  return kept
}

/** The disclosure chevron; CSS rotates it when the folder is shut. */
function ChevronGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The sigma glyph on the folder-totals toggle. */
function TotalsGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M4 3h8M4 3l4 5-4 5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The pencil glyph on the Files-view edit toggle. */
function EditGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M11.5 2.5l2 2M3 11l7.5-7.5 2 2L5 13l-3 .9.9-2.9z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The wrap-arrow glyph on the word-wrap toggle. */
function WrapGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M2 4h12M2 8h9a2 2 0 110 4H8m0 0l2-2m-2 2l2 2M2 12h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * One changed file.
 * @param {object} props - Row props.
 * @returns {import('react').ReactNode} The row.
 */
function FileRow({ file, active, depth, t, onSelect, plain }) {
  const label = t(`status.${file.status}`)
  return (
    <button
      type="button"
      className={css.row}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      onClick={onSelect}
      title={file.renamedFrom === null ? file.path : `${file.renamedFrom} → ${file.path}`}
      data-review-row={file.path}
      data-review-active={active ? 'true' : undefined}
    >
      <span className={css.chevron} aria-hidden="true" />
      <span className={css.icon} aria-hidden="true"><FileTypeIcon path={file.path} size={16} /></span>
      <span className={css.fileName}>{baseName(file.path)}</span>
      {!plain && (
        <>
          <span className={css.change} data-change={file.status} aria-label={label} title={label}>
            {STATUS_LETTER[file.status] ?? 'M'}
          </span>
          <span className={css.counts}>
            <Counts
              added={file.added ?? 0}
              removed={file.removed ?? 0}
              binary={file.added === null && file.removed === null}
            />
          </span>
        </>
      )}
    </button>
  )
}

/**
 * One directory and everything under it.
 * @param {object} props - Node props.
 * @returns {import('react').ReactNode} The subtree.
 */
function DirectoryRows({ node, depth, selected, collapsed, showCounts, plain, onToggle, onSelect, t }) {
  const open = !collapsed.has(node.path)
  return (
    <>
      <button
        type="button"
        className={css.folder}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => onToggle(node.path)}
        aria-expanded={open}
        data-review-folder={node.path}
      >
        <span className={css.chevron} data-expanded={open ? 'true' : undefined} aria-hidden="true">
          <ChevronGlyph />
        </span>
        <span className={css.icon} aria-hidden="true"><FileTypeIcon kind="folder" size={16} /></span>
        <span className={css.folderName}>{node.name}</span>
        {!open && !plain && <span className={css.folderCount}>{t('files.count', { count: String(countFiles(node)) })}</span>}
        {showCounts && !plain && (
          <span className={css.counts}>
            <Counts added={node.added} removed={node.removed} binary={false} />
          </span>
        )}
      </button>
      {open && (
        <>
          {node.directories.map(child => (
            <DirectoryRows
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              collapsed={collapsed}
              showCounts={showCounts}
              plain={plain}
              onToggle={onToggle}
              onSelect={onSelect}
              t={t}
            />
          ))}
          {node.files.map(file => (
            <FileRow
              key={file.path}
              file={file}
              active={file.path === selected}
              depth={depth + 1}
              plain={plain}
              t={t}
              onSelect={() => onSelect(file.path)}
            />
          ))}
        </>
      )}
    </>
  )
}

/** A run of unchanged lines longer than this folds behind one row. */
const FOLD_MIN = 6

/** One numbered diff line. */
function DiffLine({ line }) {
  return (
    <div className={css.line} data-kind={line.kind}>
      <span className={css.gutter}>{line.oldNumber ?? ''}</span>
      <span className={css.gutter}>{line.newNumber ?? ''}</span>
      <span className={css.marker}>{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span>
      <span className={css.text}>{line.text === '' ? '\u00a0' : line.text}</span>
    </div>
  )
}

/**
 * Split lines into rows, collapsing a long run of unchanged lines.
 * @param {any[]} lines - Lines in order, each with a `kind`.
 * @returns {Array<{ type: 'line'|'gap', line?: any, lines?: any[] }>} The rows.
 */
function foldContext(lines) {
  const rows = []
  let at = 0
  while (at < lines.length) {
    if (lines[at].kind === 'ctx') {
      let end = at
      while (end < lines.length && lines[end].kind === 'ctx') end += 1
      const run = lines.slice(at, end)
      if (run.length > FOLD_MIN) rows.push({ type: 'gap', lines: run })
      else for (const line of run) rows.push({ type: 'line', line })
      at = end
      continue
    }
    rows.push({ type: 'line', line: lines[at] })
    at += 1
  }
  return rows
}

/**
 * A hunk's lines, with each long unchanged run folded behind a clickable row.
 * @param {object} props - The lines, the global expand flag, and the translator.
 * @returns {import('react').ReactNode} The rows.
 */
function HunkRows({ lines, expandAll, t }) {
  const [expanded, setExpanded] = useState(() => new Set())
  const rows = useMemo(() => foldContext(lines), [lines])
  return rows.map((row, index) => {
    if (row.type === 'line') return <DiffLine key={index} line={row.line} />
    if (expandAll || expanded.has(index)) {
      return row.lines.map((line, inner) => <DiffLine key={`${String(index)}-${String(inner)}`} line={line} />)
    }
    return (
      <button
        type="button"
        className={css.gap}
        key={index}
        onClick={() => setExpanded((current) => new Set(current).add(index))}
        data-review-gap
      >
        {t('diff.fold', { count: String(row.lines.length) })}
      </button>
    )
  })
}

/**
 * One unified-diff hunk the Host parsed: its `@@` header and its lines.
 * @param {object} props - Hunk props.
 * @returns {import('react').ReactNode} The hunk.
 */
function Hunk({ hunk, expandAll, t }) {
  const coordinates = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
  return (
    <div className={css.hunk}>
      <div className={css.hunkHeader}>
        <span className={css.hunkCoordinates}>{coordinates}</span>
        {hunk.header !== '' && <span className={css.hunkContext}>{hunk.header}</span>}
      </div>
      <HunkRows lines={hunk.lines} expandAll={expandAll} t={t} />
    </div>
  )
}

/**
 * The Uncommitted source's diff body for the open path.
 * @param {object} props - Body props.
 * @returns {import('react').ReactNode} The diff.
 */
function DiffBody({ state, path, t, wrap, onOpen, context, onContext }) {
  const [expandAll, setExpandAll] = useState(false)
  const copy = useCallback(() => {
    if (state.kind !== 'ready' || state.diff.patch === '') return
    void navigator.clipboard?.writeText(state.diff.patch)
  }, [state])
  if (state.kind === 'loading') return <p className={css.notice}>{t('refreshing')}</p>
  if (state.kind === 'failed') {
    return (
      <p className={css.notice} data-review-error={state.code}>
        {t('error.unavailable', { message: state.message })}
      </p>
    )
  }
  const { diff } = state
  const file = diff.file
  return (
    <div className={css.diffScroll} data-wrap={wrap ? 'on' : 'off'} data-review-diff={path}>
      <div className={css.diffHead}>
        {file !== null && file.oldPath !== null && <span className={css.renameFrom}>{file.oldPath} → </span>}
        <span className={css.diffPath}>{path}</span>
        {file !== null && file.hunks.length > 0 && (
          <>
            <label className={css.contextControl} title={t('diff.context')}>
              <span>{t('diff.context')}</span>
              <select
                className={css.contextSelect}
                value={String(context)}
                onChange={(event) => onContext(Number(event.target.value))}
                data-review-context
              >
                <option value="3">3</option>
                <option value="10">10</option>
                <option value="30">30</option>
              </select>
            </label>
            <button
              type="button"
              className={css.copy}
              onClick={() => setExpandAll((value) => !value)}
              data-review-expandall
            >
              {expandAll ? t('collapseAll') : t('expandAll')}
            </button>
          </>
        )}
        {onOpen !== undefined && (
          <button type="button" className={css.copy} onClick={() => onOpen(path)} title={t('diff.open')} data-review-open>
            {t('diff.open')}
          </button>
        )}
        {diff.patch !== '' && (
          <button type="button" className={css.copy} onClick={copy} title={t('diff.copy')}>
            {t('diff.copy')}
          </button>
        )}
      </div>
      {diff.untracked && <p className={css.hint}>{t('diff.untracked')}</p>}
      {diff.truncated && <p className={css.hint}>{t('diff.truncated')}</p>}
      {file === null
        ? <p className={css.notice}>{t('diff.empty')}</p>
        : file.hunks.length === 0
          ? <p className={css.notice}>{file.binary ? t('diff.binary') : file.notice === 'empty-file' ? t('diff.empty') : t('diff.noBody')}</p>
          : file.hunks.map((hunk, index) => <Hunk hunk={hunk} expandAll={expandAll} t={t} key={`${hunk.oldStart}:${hunk.newStart}:${index}`} />)}
    </div>
  )
}

/**
 * The Rounds source's diff body for one round's file.
 *
 * Each recorded hunk is a before/after pair, so it is expanded locally into a
 * line diff and drawn with the same gutters and red/green as the Git body.
 * @param {object} props - Body props.
 * @returns {import('react').ReactNode} The diff.
 */
/** Number a round's context-free rows with sequential old/new line numbers. */
function numberLines(rows) {
  let oldNumber = 1
  let newNumber = 1
  return rows.map(row => {
    const oldCell = row.kind === 'add' ? null : oldNumber
    const newCell = row.kind === 'del' ? null : newNumber
    if (row.kind !== 'add') oldNumber += 1
    if (row.kind !== 'del') newNumber += 1
    return { kind: row.kind, text: row.text, oldNumber: oldCell, newNumber: newCell }
  })
}

function RoundDiffBody({ round, file, t, wrap, onOpen }) {
  const [expandAll, setExpandAll] = useState(false)
  const head = (
    <div className={css.diffHead}>
      <span className={css.renameFrom}>{t('round.label', { turn: String(round.turn) })} · </span>
      <span className={css.diffPath}>{file.path}</span>
      {file.hunks.length > 0 && (
        <button
          type="button"
          className={css.copy}
          onClick={() => setExpandAll((value) => !value)}
          data-review-expandall
        >
          {expandAll ? t('collapseAll') : t('expandAll')}
        </button>
      )}
      {onOpen !== undefined && (
        <button type="button" className={css.copy} onClick={() => onOpen(file.path)} title={t('diff.open')} data-review-open>
          {t('diff.open')}
        </button>
      )}
    </div>
  )
  if (file.deleted === true) {
    return (
      <div className={css.diffScroll} data-wrap={wrap ? 'on' : 'off'} data-review-round-diff={file.path}>
        {head}
        <p className={css.notice}>{t('round.deleted')}</p>
      </div>
    )
  }
  if (file.hunks.length === 0) {
    return (
      <div className={css.diffScroll} data-wrap={wrap ? 'on' : 'off'} data-review-round-diff={file.path}>
        {head}
        <p className={css.notice}>{t('diff.noBody')}</p>
      </div>
    )
  }
  return (
    <div className={css.diffScroll} data-wrap={wrap ? 'on' : 'off'} data-review-round-diff={file.path}>
      {head}
      {file.hunks.map((hunk, index) => (
        <div className={css.hunk} key={index}>
          <div className={css.hunkHeader}>
            <span className={css.hunkCoordinates}>{t('round.hunk', { index: String(index + 1) })}</span>
          </div>
          <HunkRows lines={numberLines(lineDiff(hunk.oldText, hunk.newText))} expandAll={expandAll} t={t} />
        </div>
      ))}
    </div>
  )
}

/**
 * The Files view's body: the read-only content of a file, or the opt-in editor.
 * @param {object} props - File, draft, edit state, and callbacks.
 * @returns {import('react').ReactNode} The body.
 */
function FileBody({ file, draft, editMode, save, onChange, onSave, onRevert, onOpen, wrap, t }) {
  const openButton = onOpen !== undefined && (
    <button type="button" className={css.copy} onClick={() => onOpen(file.path)} title={t('diff.open')} data-review-open>
      {t('diff.open')}
    </button>
  )
  if (file.binary) {
    return (
      <div className={css.diffScroll} data-wrap={wrap ? 'on' : 'off'} data-review-file={file.path}>
        <div className={css.diffHead}><span className={css.diffPath}>{file.path}</span>{openButton}</div>
        <p className={css.notice}>{t('file.binary')}</p>
      </div>
    )
  }
  if (editMode) {
    return (
      <div className={css.editor}>
        <div className={css.diffHead}>
          <span className={css.diffPath}>{file.path}</span>
          <span className={css.editorStatus} data-review-save={save.kind}>
            {save.kind === 'saving'
              ? t('file.saving')
              : save.kind === 'saved'
                ? t('file.saved')
                : save.kind === 'failed'
                  ? t('file.saveFailed', { message: save.message })
                  : ''}
          </span>
          <button type="button" className={css.copy} onClick={onRevert}>{t('file.revert')}</button>
          <button type="button" className={css.copy} onClick={onSave} data-review-save-button>{t('file.save')}</button>
        </div>
        <textarea
          className={css.textarea}
          value={draft ?? file.text}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          data-review-editor
        />
      </div>
    )
  }
  return (
    <div className={css.diffScroll} data-wrap={wrap ? 'on' : 'off'} data-review-file={file.path}>
      <div className={css.diffHead}>
        <span className={css.diffPath}>{file.path}</span>
        {file.truncated && <span className={css.hint}>{t('diff.truncated')}</span>}
        {openButton}
      </div>
      <pre className={css.fileText}>{file.text}</pre>
    </div>
  )
}

/**
 * The Review tab's body.
 * @param {object} props - The Slot shares this registration derives.
 * @returns {import('react').ReactNode} The tab body.
 */
export function ReviewBody({ useTabInfo, useStore, actions, start, refresh, select, open, listCommits, openCommit, openCommitDiff, listFiles, openFileContent, saveFile, t, conversation, sessionId, openFile }) {
  const { tab } = useTabInfo()
  const { signal } = tab
  const state = useStore(store => store.byTab[tab.id])
  const [filterStaged, setFilterStaged] = useState(false)
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [turnCollapsed, setTurnCollapsed] = useState(() => new Set())
  const [folderCounts, setFolderCounts] = useState(true)
  const [wrap, setWrap] = useState(false)
  // The Files tree starts fully collapsed: its set is null until the reader
  // opens or closes a folder, and the default is derived from the tree.
  const [filesCollapsed, setFilesCollapsed] = useState(null)
  const [listWidth, setListWidth] = useState(260)
  const [filter, setFilter] = useState('')
  const listDrag = useRef(null)
  // Opening a file in a viewer tab: the panel supplies its own opener, while
  // the native seat builds a `dsh-resource://file` address for the session and
  // the repository-relative path.
  const openInTab = useMemo(() => {
    if (openFile !== undefined) return openFile
    if (sessionId === undefined || typeof tab.actions?.openResource !== 'function') return undefined
    return (path) => { tab.actions.openResource(`dsh-resource://file/session/${sessionId}/${path}`) }
  }, [openFile, sessionId, tab])

  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (state !== undefined || signal.aborted) return
    start(tab.id, signal)
  }, [state, tab.id, signal, start])

  // The live conversation snapshot drives the Rounds view. The source object is
  // stable per session, so the subscription survives re-renders.
  const subscribe = useCallback((listener) => {
    if (conversation?.subscribe !== undefined) return conversation.subscribe(listener)
    return () => {}
  }, [conversation])
  const getSnapshot = useCallback(() => conversation?.getSnapshot?.() ?? null, [conversation])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const rounds = useMemo(() => deriveRounds(snapshot), [snapshot])
  const roundTotals = useMemo(
    () => rounds.reduce((acc, round) => ({ added: acc.added + round.added, removed: acc.removed + round.removed }), { added: 0, removed: 0 }),
    [rounds],
  )

  const source = state?.source ?? 'git'
  const context = state?.context ?? 3
  const report = state?.report
  const summary = report?.kind === 'ready' ? report.report : undefined
  const files = summary?.files ?? []
  const stagedPaths = useMemo(
    () => files.filter(file => file.staged).map(file => file.path),
    [files],
  )
  // The filter hides paths whose only change is already staged, which is the
  // set a reader wants out of the way once the commit is being written.
  const tree = useMemo(() => {
    if (summary === undefined) return EMPTY_TREE
    if (!filterStaged) return summary.tree
    const visible = new Set(files.filter(file => !file.staged || file.unstaged).map(file => file.path))
    return {
      directories: pruneTree(summary.tree.directories, visible),
      files: summary.tree.files.filter(file => visible.has(file.path)),
    }
  }, [summary, files, filterStaged])
  const query = filter.trim().toLowerCase()
  const visibleTree = useMemo(() => filterTree(tree, query), [tree, query])
  const shownRounds = useMemo(() => {
    if (query === '') return rounds
    const kept = []
    for (const round of rounds) {
      const keep = new Set(round.files.filter(file => file.path.toLowerCase().includes(query)).map(file => file.path))
      if (keep.size === 0) continue
      kept.push({ ...round, tree: { directories: pruneTree(round.tree.directories, keep), files: round.tree.files.filter(file => keep.has(file.path)) } })
    }
    return kept
  }, [rounds, query])
  const selected = state?.selected ?? null
  const held = selected === null ? undefined : state?.diffs[selected]

  const onToggle = useCallback((path) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])
  const onToggleTurn = useCallback((turn) => {
    setTurnCollapsed((current) => {
      const next = new Set(current)
      if (next.has(turn)) next.delete(turn)
      else next.add(turn)
      return next
    })
  }, [])

  // ── Commit-view state and reads ──────────────────────────────────────────
  const commitsState = state?.commits
  const commitFiles = state?.commitFiles ?? EMPTY_STATE
  const commitDiffs = state?.commitDiffs ?? EMPTY_STATE
  const commitOid = state?.commitOid ?? null
  const commitPath = state?.commitPath ?? null
  const [expandedCommits, setExpandedCommits] = useState(() => new Set())
  const commitList = commitsState?.kind === 'ready' ? commitsState.report.commits : EMPTY_LIST
  const shownCommits = useMemo(() => {
    if (query === '') return commitList
    return commitList.filter(commit => {
      if (`${commit.subject} ${commit.short} ${commit.oid}`.toLowerCase().includes(query)) return true
      const files = commitFiles[commit.oid]
      return files?.kind === 'ready' && files.report.files.some(file => file.path.toLowerCase().includes(query))
    })
  }, [commitList, commitFiles, query])

  // Read the commit list the first time the Commit source is shown.
  useEffect(() => {
    if (source !== 'commits' || signal.aborted) return
    const kind = commitsState?.kind
    if (kind === undefined || kind === 'idle') listCommits(tab.id, signal)
  }, [source, commitsState?.kind, tab.id, signal, listCommits])

  // Expanding a commit reads its file list, once.
  useEffect(() => {
    if (source !== 'commits' || signal.aborted) return
    for (const oid of expandedCommits) {
      if (commitFiles[oid] === undefined) openCommit(tab.id, oid, signal)
    }
  }, [source, expandedCommits, commitFiles, tab.id, signal, openCommit])

  // Opening a commit path reads its diff, once.
  useEffect(() => {
    if (source !== 'commits' || signal.aborted) return
    if (commitOid === null || commitPath === null) return
    if (commitDiffs[`${commitOid}\u0000${commitPath}`] === undefined) openCommitDiff(tab.id, commitOid, commitPath, context, signal)
  }, [source, commitOid, commitPath, commitDiffs, tab.id, context, signal, openCommitDiff])

  const onToggleCommit = useCallback((oid) => {
    setExpandedCommits((current) => {
      const next = new Set(current)
      if (next.has(oid)) next.delete(oid)
      else next.add(oid)
      return next
    })
  }, [])


  // ── Files-view state and reads ───────────────────────────────────────────
  const filesState = state?.files
  const filesReport = filesState?.kind === 'ready' ? filesState.report : undefined
  const filesVisibleTree = useMemo(
    () => (filesReport === undefined ? EMPTY_TREE : filterTree(filesReport.tree, query)),
    [filesReport, query],
  )
  const fileContent = state?.fileContent ?? EMPTY_STATE
  const filePath = state?.filePath ?? null
  const fileDraft = state?.fileDraft ?? null
  const editMode = state?.editMode ?? false
  const fileSave = state?.fileSave ?? { kind: 'idle' }

  // Read the workspace file tree the first time the Files source is shown.
  useEffect(() => {
    if (source !== 'files' || signal.aborted) return
    const kind = filesState?.kind
    if (kind === undefined || kind === 'idle') listFiles(tab.id, signal)
  }, [source, filesState?.kind, tab.id, signal, listFiles])

  // Opening a file reads its content, once.
  useEffect(() => {
    if (source !== 'files' || signal.aborted) return
    if (filePath === null) return
    if (fileContent[filePath] === undefined) openFileContent(tab.id, filePath, signal)
  }, [source, filePath, fileContent, tab.id, signal, openFileContent])

  // Every folder of the Files tree, its default (all collapsed) set.
  const filesDefaultCollapsed = useMemo(
    () => new Set(filesReport === undefined ? [] : [...directoryPaths(filesReport.tree.directories)]),
    [filesReport],
  )
  const filesCollapsedSet = filesCollapsed ?? filesDefaultCollapsed
  const onToggleFiles = useCallback((path) => {
    setFilesCollapsed((current) => {
      const next = new Set(current ?? filesDefaultCollapsed)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [filesDefaultCollapsed])

  // Opening a path reads its diff on demand. The face dispatches only when the
  // body is not held, so a re-render does not refetch, and `held` is a
  // dependency so a body cleared by a refresh is read again.
  useEffect(() => {
    if (selected === null || held !== undefined || signal.aborted) return
    open(tab.id, selected, context, signal)
  }, [selected, held, tab.id, context, signal, open])

  if (state === undefined) return null

  const roundTurn = state.roundTurn
  const roundPath = state.roundPath
  const selectedRound = roundTurn === null ? undefined : rounds.find(round => round.turn === roundTurn)
  const selectedRoundFile = selectedRound?.files.find(file => file.path === roundPath)

  const switchButton = (value, label) => (
    <button
      type="button"
      className={source === value ? `${css.switchButton} ${css.switchOn}` : css.switchButton}
      onClick={() => actions.setSource(tab.id, value)}
      data-review-source={value}
      aria-pressed={source === value}
    >
      {label}
    </button>
  )

  const onRefresh = () => { refresh(tab.id, signal) }

  // ── View-state persistence ───────────────────────────────────────────────
  // Restore once per session, then mirror every change back (debounced).
  const restoredView = useRef(false)
  useEffect(() => {
    if (restoredView.current || sessionId === undefined || state === undefined) return
    restoredView.current = true
    const view = loadView(sessionId)
    if (typeof view.listWidth === 'number') setListWidth(view.listWidth)
    if (typeof view.wrap === 'boolean') setWrap(view.wrap)
    if (typeof view.folderCounts === 'boolean') setFolderCounts(view.folderCounts)
    if (typeof view.filter === 'string') setFilter(view.filter)
    if (Array.isArray(view.collapsed)) setCollapsed(new Set(view.collapsed))
    if (view.filesCollapsed === null) setFilesCollapsed(null)
    else if (Array.isArray(view.filesCollapsed)) setFilesCollapsed(new Set(view.filesCollapsed))
    if (Array.isArray(view.expandedCommits)) setExpandedCommits(new Set(view.expandedCommits))
    if (typeof view.source === 'string') actions.setSource(tab.id, view.source)
    if (typeof view.context === 'number') actions.setContext(tab.id, view.context)
    if (typeof view.git === 'string') select(tab.id, view.git, false, view.context ?? 3, signal)
    if (Array.isArray(view.round) && view.round[0] !== null) actions.selectRound(tab.id, view.round[0], view.round[1])
    if (Array.isArray(view.commit) && view.commit[0] !== null) actions.selectCommit(tab.id, view.commit[0], view.commit[1])
    if (typeof view.file === 'string') actions.selectFile(tab.id, view.file)
  }, [sessionId, state, tab.id, signal, actions, select])

  useEffect(() => {
    if (sessionId === undefined || state === undefined) return
    const timer = setTimeout(() => {
      saveView(sessionId, {
        source: state.source ?? 'git',
        context: state.context ?? 3,
        listWidth,
        wrap,
        folderCounts,
        filter,
        collapsed: [...collapsed],
        filesCollapsed: filesCollapsed === null ? null : [...filesCollapsed],
        expandedCommits: [...expandedCommits],
        git: state.selected ?? null,
        round: [state.roundTurn ?? null, state.roundPath ?? null],
        commit: [state.commitOid ?? null, state.commitPath ?? null],
        file: state.filePath ?? null,
      })
    }, 400)
    return () => clearTimeout(timer)
  }, [sessionId, state, listWidth, wrap, folderCounts, filter, collapsed, filesCollapsed, expandedCommits])

  const splitStyle = { '--review-list-width': `${String(listWidth)}px` }
  const dividerProps = {
    onPointerDown: (event) => {
      event.preventDefault()
      listDrag.current = { x: event.clientX, w: listWidth }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    onPointerMove: (event) => {
      if (listDrag.current === null) return
      const next = Math.min(560, Math.max(160, listDrag.current.w + (event.clientX - listDrag.current.x)))
      setListWidth(next)
    },
    onPointerUp: (event) => {
      listDrag.current = null
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    },
    onPointerCancel: (event) => {
      listDrag.current = null
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    },
  }

  const header = (
    <div className={css.header}>
      <span className={css.switch}>
        {switchButton('files', t('source.files'))}
        {switchButton('git', t('source.uncommitted'))}
        {switchButton('rounds', t('source.rounds'))}
        {switchButton('commits', t('source.commits'))}
      </span>
      <span className={css.totals} data-review-totals={source}>
        {source === 'git'
          ? summary !== undefined && (
            <>
              {summary.added > 0 && <span className={css.added}>+{summary.added}</span>}
              {summary.removed > 0 && <span className={css.removed}>-{summary.removed}</span>}
            </>
          )
          : (
            <>
              {roundTotals.added > 0 && <span className={css.added}>+{roundTotals.added}</span>}
              {roundTotals.removed > 0 && <span className={css.removed}>-{roundTotals.removed}</span>}
            </>
          )}
      </span>
      {source === 'git' && summary !== undefined && (
        <span className={css.branch} title={summary.root ?? undefined}>
          {summary.detached || summary.branch === null ? 'HEAD' : summary.branch}
          {summary.ahead > 0 && <span className={css.ahead}>↑{summary.ahead}</span>}
          {summary.behind > 0 && <span className={css.behind}>↓{summary.behind}</span>}
        </span>
      )}
      {source === 'git' && summary !== undefined && (
        <CollapseButton directories={visibleTree.directories} collapsed={collapsed} onCollapse={setCollapsed} t={t} />
      )}
      {source === 'files' && filesReport !== undefined && (
        <CollapseButton directories={filesVisibleTree.directories} collapsed={filesCollapsedSet} onCollapse={setFilesCollapsed} t={t} />
      )}
      <button
        type="button"
        className={folderCounts ? `${css.action} ${css.actionOn}` : css.action}
        onClick={() => setFolderCounts(value => !value)}
        title={t('toggle.folderCounts')}
        aria-label={t('toggle.folderCounts')}
        aria-pressed={folderCounts}
        data-review-folder-counts={folderCounts ? 'on' : 'off'}
      >
        <TotalsGlyph />
      </button>
      <button
        type="button"
        className={wrap ? `${css.action} ${css.actionOn}` : css.action}
        onClick={() => setWrap(value => !value)}
        title={t('toggle.wrap')}
        aria-label={t('toggle.wrap')}
        aria-pressed={wrap}
        data-review-wrap={wrap ? 'on' : 'off'}
      >
        <WrapGlyph />
      </button>
      {source === 'files' && (
        <button
          type="button"
          className={editMode ? `${css.action} ${css.actionOn}` : css.action}
          onClick={() => actions.setEditMode(tab.id, !editMode)}
          title={t('toggle.edit')}
          aria-label={t('toggle.edit')}
          aria-pressed={editMode}
          data-review-edit={editMode ? 'on' : 'off'}
        >
          <EditGlyph />
        </button>
      )}
      {source === 'git' && (
        <button
          type="button"
          className={css.action}
          onClick={onRefresh}
          aria-label={t('refresh')}
          title={t('refresh')}
        >
          ⟳
        </button>
      )}
    </div>
  )

  // ── Uncommitted ───────────────────────────────────────────────────────────

  if (source === 'git') {
    if (report.kind === 'loading') {
      return <div className={css.root}>{header}<p className={css.notice}>{t('refreshing')}</p></div>
    }
    if (report.kind === 'failed') {
      return (
        <div className={css.root} data-review-state="failed">
          {header}
          <p className={css.notice}>{t('error.unavailable', { message: report.message })}</p>
          <button type="button" className={css.action} onClick={onRefresh}>{t('reload')}</button>
        </div>
      )
    }
    if (!report.report.isRepository) {
      return (
        <div className={css.root} data-review-state="not-repository">
          {header}
          <p className={css.notice}>{t('notRepository')}</p>
          <button type="button" className={css.action} onClick={onRefresh}>{t('reload')}</button>
        </div>
      )
    }
    return (
      <div className={css.root} data-review-state="ready" data-review-root={report.report.root ?? undefined}>
        {header}
        {report.report.truncated && <p className={css.hint}>{t('truncated')}</p>}
        {report.report.files.length === 0
          ? (
            <div className={css.empty} data-review-state="empty">
              <p className={css.emptyTitle}>{t('empty.title')}</p>
              <p className={css.emptyBody}>{t('empty.description')}</p>
            </div>
          )
          : (
            <div className={css.split} style={splitStyle}>
              <div className={css.list}>
                <FilterBox value={filter} onChange={setFilter} t={t} />
                {stagedPaths.length > 0 && (
                  <button
                    type="button"
                    className={filterStaged ? `${css.filter} ${css.filterOn}` : css.filter}
                    onClick={() => {
                      setFilterStaged(!filterStaged)
                      actions.toggleStaged(tab.id, stagedPaths)
                    }}
                  >
                    {t('staged')}
                  </button>
                )}
                {visibleTree.directories.map(node => (
                  <DirectoryRows
                    key={node.path}
                    node={node}
                    depth={0}
                    selected={selected}
                    collapsed={collapsed}
                    showCounts={folderCounts}
                    onToggle={onToggle}
                    onSelect={(path) => { select(tab.id, path, state.diffs[path] !== undefined, context, signal) }}
                    t={t}
                  />
                ))}
                {visibleTree.files.map(file => (
                  <FileRow
                    key={file.path}
                    file={file}
                    active={file.path === selected}
                    depth={0}
                    t={t}
                    onSelect={() => { select(tab.id, file.path, state.diffs[file.path] !== undefined, signal) }}
                  />
                ))}
                <p className={css.count}>{t('files.count', { count: String(files.length) })}</p>
              </div>
              <div className={css.divider} role="separator" aria-orientation="vertical" {...dividerProps} />
          <div className={css.body}>
                {selected === null
                  ? <p className={css.notice}>{t('diff.select')}</p>
                  : held === undefined
                    ? <p className={css.notice}>{t('refreshing')}</p>
                    : <DiffBody state={held} path={selected} t={t} wrap={wrap} onOpen={openInTab} context={context} onContext={(value) => actions.setContext(tab.id, value)} />}
              </div>
            </div>
          )}
      </div>
    )
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  if (source === 'files') {
    if (filesState === undefined || filesState.kind === 'idle' || filesState.kind === 'loading') {
      return <div className={css.root} data-review-state="files-loading">{header}<p className={css.notice}>{t('refreshing')}</p></div>
    }
    if (filesState.kind === 'failed') {
      return (
        <div className={css.root} data-review-state="files-failed">
          {header}
          <p className={css.notice}>{t('error.unavailable', { message: filesState.message })}</p>
          <button type="button" className={css.action} onClick={() => { listFiles(tab.id, signal) }}>{t('reload')}</button>
        </div>
      )
    }
    if (!filesState.report.isRepository) {
      return <div className={css.root} data-review-state="not-repository">{header}<p className={css.notice}>{t('notRepository')}</p></div>
    }
    const heldFile = filePath === null ? undefined : fileContent[filePath]
    const openContent = heldFile?.kind === 'ready' ? heldFile.file : undefined
    return (
      <div className={css.root} data-review-state="files">
        {header}
        {filesState.report.truncated && <p className={css.hint}>{t('truncated')}</p>}
        <div className={css.split} style={splitStyle}>
          <div className={css.list}>
            <FilterBox value={filter} onChange={setFilter} t={t} />
            {filesVisibleTree.directories.map(node => (
              <DirectoryRows
                key={node.path}
                node={node}
                depth={0}
                selected={filePath}
                collapsed={filesCollapsedSet}
                showCounts={false}
                plain
                onToggle={onToggleFiles}
                onSelect={(path) => actions.selectFile(tab.id, path)}
                t={t}
              />
            ))}
            {filesVisibleTree.files.map(file => (
              <FileRow
                key={file.path}
                file={file}
                active={file.path === filePath}
                depth={0}
                plain
                t={t}
                onSelect={() => actions.selectFile(tab.id, file.path)}
              />
            ))}
            <p className={css.count}>{t('files.count', { count: String(filesState.report.count) })}</p>
          </div>
          <div className={css.divider} role="separator" aria-orientation="vertical" {...dividerProps} />
          <div className={css.body}>
            {filePath === null
              ? <p className={css.notice}>{t('file.select')}</p>
              : heldFile === undefined || heldFile.kind === 'loading'
                ? <p className={css.notice}>{t('refreshing')}</p>
                : heldFile.kind === 'failed'
                  ? <p className={css.notice}>{t('error.unavailable', { message: heldFile.message })}</p>
                  : (
                    <FileBody
                      file={openContent}
                      draft={fileDraft}
                      editMode={editMode}
                      save={fileSave}
                      onChange={(text) => actions.setFileDraft(tab.id, text)}
                      onSave={() => { void saveFile(tab.id, openContent.path, fileDraft ?? openContent.text, signal) }}
                      onRevert={() => actions.setFileDraft(tab.id, openContent.text)}
                      onOpen={openInTab}
                      wrap={wrap}
                      t={t}
                    />
                  )}
          </div>
        </div>
      </div>
    )
  }

  // ── Commits ───────────────────────────────────────────────────────────────

  if (source === 'commits') {
    if (commitsState === undefined || commitsState.kind === 'idle' || commitsState.kind === 'loading') {
      return <div className={css.root} data-review-state="commits-loading">{header}<p className={css.notice}>{t('refreshing')}</p></div>
    }
    if (commitsState.kind === 'failed') {
      return (
        <div className={css.root} data-review-state="commits-failed">
          {header}
          <p className={css.notice}>{t('error.unavailable', { message: commitsState.message })}</p>
          <button type="button" className={css.action} onClick={() => { listCommits(tab.id, signal) }}>{t('reload')}</button>
        </div>
      )
    }
    if (!commitsState.report.isRepository) {
      return <div className={css.root} data-review-state="not-repository">{header}<p className={css.notice}>{t('notRepository')}</p></div>
    }
    if (commitList.length === 0) {
      return (
        <div className={css.root} data-review-state="commits-empty">
          {header}
          <div className={css.empty}><p className={css.emptyTitle}>{t('commit.empty')}</p></div>
        </div>
      )
    }
    if (shownCommits.length === 0) {
      return (
        <div className={css.root} data-review-state="commits-empty">
          {header}
          <div className={css.empty}><p className={css.emptyTitle}>{t('filter.empty')}</p></div>
        </div>
      )
    }
    const heldCommitDiff = commitOid === null || commitPath === null
      ? undefined
      : commitDiffs[`${commitOid}\u0000${commitPath}`]
    return (
      <div className={css.root} data-review-state="commits">
        {header}
        <div className={css.split} style={splitStyle}>
          <div className={css.list}>
            <FilterBox value={filter} onChange={setFilter} t={t} />
            {shownCommits.map(commit => {
              const open = expandedCommits.has(commit.oid)
              const files = commitFiles[commit.oid]
              const report = files?.kind === 'ready' ? files.report : undefined
              const tree = report === undefined ? undefined : filterTree(report.tree, query)
              return (
                <div key={commit.oid} data-review-commit={commit.oid}>
                  <button
                    type="button"
                    className={css.turn}
                    onClick={() => onToggleCommit(commit.oid)}
                    aria-expanded={open}
                    title={commit.subject}
                  >
                    <span className={css.chevron} data-expanded={open ? 'true' : undefined} aria-hidden="true">
                      <ChevronGlyph />
                    </span>
                    <span className={css.commitBody}>
                      <span className={css.commitSubject}>{commit.subject === '' ? commit.short : commit.subject}</span>
                      <span className={css.commitMeta}>{commit.short} · {commit.author}</span>
                    </span>
                    {report !== undefined && (
                      <span className={css.counts}>
                        <Counts added={report.added} removed={report.removed} binary={false} />
                      </span>
                    )}
                  </button>
                  {open && (
                    <div className={css.roundFiles}>
                      {files === undefined || files.kind === 'loading'
                        ? <p className={css.notice}>{t('refreshing')}</p>
                        : files.kind === 'failed'
                          ? <p className={css.notice}>{t('error.unavailable', { message: files.message })}</p>
                          : (
                            <>
                              {tree.directories.map(node => (
                                <DirectoryRows
                                  key={node.path}
                                  node={node}
                                  depth={0}
                                  selected={commitOid === commit.oid ? commitPath : null}
                                  collapsed={collapsed}
                                  showCounts={folderCounts}
                                  onToggle={onToggle}
                                  onSelect={(path) => actions.selectCommit(tab.id, commit.oid, path)}
                                  t={t}
                                />
                              ))}
                              {tree.files.map(file => (
                                <FileRow
                                  key={file.path}
                                  file={file}
                                  active={commitOid === commit.oid && commitPath === file.path}
                                  depth={0}
                                  t={t}
                                  onSelect={() => actions.selectCommit(tab.id, commit.oid, file.path)}
                                />
                              ))}
                            </>
                          )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className={css.divider} role="separator" aria-orientation="vertical" {...dividerProps} />
          <div className={css.body}>
            {commitOid === null || commitPath === null
              ? <p className={css.notice}>{t('diff.select')}</p>
              : heldCommitDiff === undefined
                ? <p className={css.notice}>{t('refreshing')}</p>
                : <DiffBody state={heldCommitDiff} path={commitPath} t={t} wrap={wrap} onOpen={openInTab} />}
          </div>
        </div>
      </div>
    )
  }

  // ── Rounds ────────────────────────────────────────────────────────────────

  if (snapshot === null) {
    return <div className={css.root} data-review-state="rounds-unavailable">{header}<p className={css.notice}>{t('round.unavailable')}</p></div>
  }
  return (
    <div className={css.root} data-review-state="rounds">
      {header}
      {shownRounds.length === 0
        ? (
          <div className={css.empty} data-review-state="rounds-empty">
            <p className={css.emptyTitle}>{query === '' ? t('round.empty') : t('filter.empty')}</p>
          </div>
        )
        : (
          <div className={css.split} style={splitStyle}>
            <div className={css.list}>
              <FilterBox value={filter} onChange={setFilter} t={t} />
              {shownRounds.map(round => {
                const open = !turnCollapsed.has(round.turn)
                return (
                  <div key={round.turn} data-review-turn={round.turn}>
                    <button
                      type="button"
                      className={css.turn}
                      onClick={() => onToggleTurn(round.turn)}
                      aria-expanded={open}
                    >
                      <span className={css.chevron} data-expanded={open ? 'true' : undefined} aria-hidden="true">
                        <ChevronGlyph />
                      </span>
                      <span className={css.turnName}>{t('round.label', { turn: String(round.turn) })}</span>
                      {round.live && <span className={css.live}>{t('round.live')}</span>}
                      <span className={css.counts}>
                        <Counts added={round.added} removed={round.removed} binary={false} />
                      </span>
                    </button>
                    {open && (
                      <div className={css.roundFiles}>
                        {round.tree.directories.map(node => (
                          <DirectoryRows
                            key={node.path}
                            node={node}
                            depth={0}
                            selected={roundTurn === round.turn ? roundPath : null}
                            collapsed={collapsed}
                            showCounts={folderCounts}
                            onToggle={onToggle}
                            onSelect={(path) => actions.selectRound(tab.id, round.turn, path)}
                            t={t}
                          />
                        ))}
                        {round.tree.files.map(file => (
                          <FileRow
                            key={file.path}
                            file={file}
                            active={roundTurn === round.turn && roundPath === file.path}
                            depth={0}
                            t={t}
                            onSelect={() => actions.selectRound(tab.id, round.turn, file.path)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
              <p className={css.count}>{t('files.count', { count: String(shownRounds.length) })}</p>
            </div>
            <div className={css.divider} role="separator" aria-orientation="vertical" {...dividerProps} />
          <div className={css.body}>
              {selectedRound === undefined || selectedRoundFile === undefined
                ? <p className={css.notice}>{t('round.select')}</p>
                : <RoundDiffBody round={selectedRound} file={selectedRoundFile} t={t} wrap={wrap} onOpen={openInTab} />}
            </div>
          </div>
        )}
    </div>
  )
}
