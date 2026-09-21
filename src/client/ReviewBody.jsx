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

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import css from './ReviewBody.module.css'
import { deriveRounds, lineDiff } from './rounds.js'

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

/** The folder glyph on a directory row. */
function FolderGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M2 4.25C2 3.56 2.56 3 3.25 3h2.4c.33 0 .65.13.88.37l.9.9c.24.24.56.37.89.37h4.43c.69 0 1.25.56 1.25 1.25v5.86c0 .69-.56 1.25-1.25 1.25h-9.5C2.56 13 2 12.44 2 11.75V4.25z" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

/** The page glyph on a file row. */
function FileGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M4 3.25C4 2.56 4.56 2 5.25 2h3.4L12 5.35v7.4c0 .69-.56 1.25-1.25 1.25h-5.5C4.56 14 4 13.44 4 12.75V3.25z" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8.5 2.2V5.4h3.2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

/**
 * One changed file.
 * @param {object} props - Row props.
 * @returns {import('react').ReactNode} The row.
 */
function FileRow({ file, active, depth, t, onSelect }) {
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
      <span className={css.icon} aria-hidden="true"><FileGlyph /></span>
      <span className={css.fileName}>{baseName(file.path)}</span>
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
    </button>
  )
}

/**
 * One directory and everything under it.
 * @param {object} props - Node props.
 * @returns {import('react').ReactNode} The subtree.
 */
function DirectoryRows({ node, depth, selected, collapsed, onToggle, onSelect, t }) {
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
        <span className={css.icon} aria-hidden="true"><FolderGlyph /></span>
        <span className={css.folderName}>{node.name}/</span>
        {!open && <span className={css.folderCount}>{t('files.count', { count: String(countFiles(node)) })}</span>}
        <span className={css.counts}>
          <Counts added={node.added} removed={node.removed} binary={false} />
        </span>
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
              t={t}
              onSelect={() => onSelect(file.path)}
            />
          ))}
        </>
      )}
    </>
  )
}

/**
 * One unified-diff hunk the Host parsed: its `@@` header and numbered lines.
 * @param {object} props - Hunk props.
 * @returns {import('react').ReactNode} The hunk.
 */
function Hunk({ hunk }) {
  const coordinates = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
  return (
    <div className={css.hunk}>
      <div className={css.hunkHeader}>
        <span className={css.hunkCoordinates}>{coordinates}</span>
        {hunk.header !== '' && <span className={css.hunkContext}>{hunk.header}</span>}
      </div>
      {hunk.lines.map((line, index) => (
        <div className={css.line} data-kind={line.kind} key={`${line.oldNumber ?? ''}:${line.newNumber ?? ''}:${index}`}>
          <span className={css.gutter}>{line.oldNumber ?? ''}</span>
          <span className={css.gutter}>{line.newNumber ?? ''}</span>
          <span className={css.marker}>{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span>
          <span className={css.text}>{line.text === '' ? '\u00a0' : line.text}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * The Uncommitted source's diff body for the open path.
 * @param {object} props - Body props.
 * @returns {import('react').ReactNode} The diff.
 */
function DiffBody({ state, path, t }) {
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
    <div className={css.diffScroll} data-review-diff={path}>
      <div className={css.diffHead}>
        {file !== null && file.oldPath !== null && <span className={css.renameFrom}>{file.oldPath} → </span>}
        <span className={css.diffPath}>{path}</span>
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
          : file.hunks.map((hunk, index) => <Hunk hunk={hunk} key={`${hunk.oldStart}:${hunk.newStart}:${index}`} />)}
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
function RoundDiffBody({ round, file, t }) {
  if (file.deleted === true) {
    return (
      <div className={css.diffScroll} data-review-round-diff={file.path}>
        <div className={css.diffHead}><span className={css.diffPath}>{file.path}</span></div>
        <p className={css.notice}>{t('round.deleted')}</p>
      </div>
    )
  }
  if (file.hunks.length === 0) {
    return (
      <div className={css.diffScroll} data-review-round-diff={file.path}>
        <div className={css.diffHead}><span className={css.diffPath}>{file.path}</span></div>
        <p className={css.notice}>{t('diff.noBody')}</p>
      </div>
    )
  }
  return (
    <div className={css.diffScroll} data-review-round-diff={file.path}>
      <div className={css.diffHead}>
        <span className={css.renameFrom}>{t('round.label', { turn: String(round.turn) })} · </span>
        <span className={css.diffPath}>{file.path}</span>
      </div>
      {file.hunks.map((hunk, index) => {
        const rows = lineDiff(hunk.oldText, hunk.newText)
        let oldNumber = 1
        let newNumber = 1
        return (
          <div className={css.hunk} key={index}>
            <div className={css.hunkHeader}>
              <span className={css.hunkCoordinates}>{t('round.hunk', { index: String(index + 1) })}</span>
            </div>
            {rows.map((row, at) => {
              const oldCell = row.kind === 'add' ? null : oldNumber
              const newCell = row.kind === 'del' ? null : newNumber
              if (row.kind !== 'add') oldNumber += 1
              if (row.kind !== 'del') newNumber += 1
              return (
                <div className={css.line} data-kind={row.kind} key={at}>
                  <span className={css.gutter}>{oldCell ?? ''}</span>
                  <span className={css.gutter}>{newCell ?? ''}</span>
                  <span className={css.marker}>{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}</span>
                  <span className={css.text}>{row.text === '' ? '\u00a0' : row.text}</span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The Review tab's body.
 * @param {object} props - The Slot shares this registration derives.
 * @returns {import('react').ReactNode} The tab body.
 */
export function ReviewBody({ useTabInfo, useStore, actions, start, refresh, select, open, t, conversation }) {
  const { tab } = useTabInfo()
  const { signal } = tab
  const state = useStore(store => store.byTab[tab.id])
  const [filterStaged, setFilterStaged] = useState(false)
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [turnCollapsed, setTurnCollapsed] = useState(() => new Set())

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

  // Opening a path reads its diff on demand. The face dispatches only when the
  // body is not held, so a re-render does not refetch, and `held` is a
  // dependency so a body cleared by a refresh is read again.
  useEffect(() => {
    if (selected === null || held !== undefined || signal.aborted) return
    open(tab.id, selected, signal)
  }, [selected, held, tab.id, signal, open])

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

  const header = (
    <div className={css.header}>
      <span className={css.switch}>
        {switchButton('git', t('source.uncommitted'))}
        {switchButton('rounds', t('source.rounds'))}
      </span>
      {source === 'git' && summary !== undefined && (
        <span className={css.branch} title={summary.root ?? undefined}>
          {summary.detached || summary.branch === null ? 'HEAD' : summary.branch}
          {summary.ahead > 0 && <span className={css.ahead}>↑{summary.ahead}</span>}
          {summary.behind > 0 && <span className={css.behind}>↓{summary.behind}</span>}
        </span>
      )}
      {source === 'git' && summary !== undefined && directoryPaths(tree.directories).size > 0 && (
        <button
          type="button"
          className={css.action}
          onClick={() => {
            const every = directoryPaths(tree.directories)
            const allCollapsed = every.size > 0 && collapsed.size >= every.size
            setCollapsed(allCollapsed ? new Set() : every)
          }}
          title={collapsed.size > 0 ? t('expandAll') : t('collapseAll')}
          aria-label={collapsed.size > 0 ? t('expandAll') : t('collapseAll')}
        >
          {collapsed.size > 0 ? '⊞' : '⊟'}
        </button>
      )}
      <span className={css.totals}>
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
            <div className={css.split}>
              <div className={css.list}>
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
                {tree.directories.map(node => (
                  <DirectoryRows
                    key={node.path}
                    node={node}
                    depth={0}
                    selected={selected}
                    collapsed={collapsed}
                    onToggle={onToggle}
                    onSelect={(path) => { select(tab.id, path, state.diffs[path] !== undefined, signal) }}
                    t={t}
                  />
                ))}
                {tree.files.map(file => (
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
              <div className={css.body}>
                {selected === null
                  ? <p className={css.notice}>{t('diff.select')}</p>
                  : held === undefined
                    ? <p className={css.notice}>{t('refreshing')}</p>
                    : <DiffBody state={held} path={selected} t={t} />}
              </div>
            </div>
          )}
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
      {rounds.length === 0
        ? (
          <div className={css.empty} data-review-state="rounds-empty">
            <p className={css.emptyTitle}>{t('round.empty')}</p>
          </div>
        )
        : (
          <div className={css.split}>
            <div className={css.list}>
              {rounds.map(round => {
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
              <p className={css.count}>{t('files.count', { count: String(rounds.length) })}</p>
            </div>
            <div className={css.body}>
              {selectedRound === undefined || selectedRoundFile === undefined
                ? <p className={css.notice}>{t('round.select')}</p>
                : <RoundDiffBody round={selectedRound} file={selectedRoundFile} t={t} />}
            </div>
          </div>
        )}
    </div>
  )
}
