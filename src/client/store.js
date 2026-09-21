/**
 * The Review tab's view state.
 *
 * One bucket per tab id inside an exclusive store: the last report the Host
 * sent, the per-path diff bodies already fetched, which path is open, and
 * whether the reader has staged the tree by path. The report itself is Host
 * business data and stays in the wire result — the store holds only what the
 * tab is looking at.
 *
 * Writers run between `start` and `forget`, which the tab record's abort signal
 * brackets.
 */

import { defineStore } from '@deepseek-ai/dsh-client-store'

/**
 * A Remote read's outcome as the tab shows it.
 * @typedef {{ kind: 'loading' }
 *   | { kind: 'ready', report: object }
 *   | { kind: 'failed', code: string, message: string }} ReviewAsync
 */

/**
 * What one path's diff body is doing. A record absent from the map was never
 * asked for.
 * @typedef {{ kind: 'loading' }
 *   | { kind: 'ready', diff: object }
 *   | { kind: 'failed', code: string, message: string }} ReviewDiffState
 */

/**
 * One tab's review state.
 * @typedef {object} ReviewTabState
 * @property {ReviewAsync} report The last report read, or the read in flight.
 * @property {Record<string, ReviewDiffState>} diffs Diff bodies by path.
 * @property {string|null} selected Path whose diff the body draws.
 * @property {Record<string, true>} staged Paths the reader hid with the staged filter.
 */

/**
 * Declare the Review tab's store.
 * @returns {object} The store handle to declare on the registration.
 */
export function createReviewStore() {
  return defineStore({
    init: () => ({ byTab: {} }),
    actions: {
      /**
       * Seed one tab's bucket so every later writer has somewhere to land.
       * @param {object} draft - Draft state.
       * @param {string} tabId - The tab being drawn.
       */
      start: (draft, tabId) => {
        draft.byTab[tabId] = {
          report: { kind: 'loading' },
          diffs: {},
          selected: null,
          staged: {},
          source: 'git',
          roundTurn: null,
          roundPath: null,
        }
      },
      /**
       * Switch the tab between the two change sources.
       * @param {object} draft - Draft state.
       * @param {string} tabId - The tab being drawn.
       * @param {'git'|'rounds'} source - Which grouping to draw.
       */
      setSource: (draft, tabId, source) => {
        const tab = draft.byTab[tabId]
        if (tab !== undefined) tab.source = source
      },
      /**
       * Open one round's file.
       * @param {object} draft - Draft state.
       * @param {string} tabId - The tab being drawn.
       * @param {number} turn - The round number.
       * @param {string} path - The path to open.
       */
      selectRound: (draft, tabId, turn, path) => {
        const tab = draft.byTab[tabId]
        if (tab === undefined) return
        tab.roundTurn = turn
        tab.roundPath = path
      },
      /**
       * Mark the file list as being read.
       * @param {object} draft - Draft state.
       * @param {string} tabId - The tab being drawn.
       */
      loading: (draft, tabId) => {
        const tab = draft.byTab[tabId]
        if (tab === undefined) return
        tab.report = { kind: 'loading' }
      },
      /**
       * Record a report and reconcile what the tab is looking at.
       *
       * The open diff survives a refresh whenever its path is still changed, so
       * a reload does not move the reader; otherwise the selection falls back to
       * the first row, or to nothing when the tree is clean.
       * @param {object} draft - Draft state.
       * @param {string} tabId - The tab being drawn.
       * @param {object} report - The report the Host sent.
       */
      loaded: (draft, tabId, report) => {
        const tab = draft.byTab[tabId]
        if (tab === undefined) return
        tab.report = { kind: 'ready', report }
        const present = new Set(report.files.map(file => file.path))
        // A refreshed diff body belongs to the old report, so it is dropped
        // whether or not the path survived; the body refetches on demand.
        tab.diffs = Object.fromEntries(Object.entries(tab.diffs).filter(([path]) => present.has(path)))
        const stale = tab.selected === null || !present.has(tab.selected)
        tab.selected = stale ? report.files[0]?.path ?? null : tab.selected
        // A path that left the report stops being hidden, so a file that comes
        // back later is visible rather than silently filtered away.
        tab.staged = Object.fromEntries(Object.entries(tab.staged).filter(([path]) => present.has(path)))
      },
      /**
       * Record why the file list could not be read.
       * @param {object} draft - Draft state.
       * @param {string} tabId - The tab being drawn.
       * @param {string} code - The Remote failure code.
       * @param {string} message - The Remote failure message.
       */
      failed: (draft, tabId, code, message) => {
        const tab = draft.byTab[tabId]
        if (tab === undefined) return
        tab.report = { kind: 'failed', code, message }
      },
      /**
       * Mark one path's diff as being read.
       * @param {object} draft - Draft state.
       * @param {string} tabId - The tab being drawn.
       * @param {string} path - The path being read.
       */
      diffLoading: (draft, tabId, path) => {
        const tab = draft.byTab[tabId]
        if (tab !== undefined) tab.diffs[path] = { kind: 'loading' }
      },
      /**
       * Record one path's diff body.
       * @param {object} draft - Draft state.
       * @param {string} tabId - The tab being drawn.
       * @param {string} path - The path that was read.
       * @param {object} diff - The parsed diff the Host sent.
       */
      diffLoaded: (draft, tabId, path, diff) => {
        const tab = draft.byTab[tabId]
        if (tab !== undefined) tab.diffs[path] = { kind: 'ready', diff }
      },
      /**
       * Record why one path's diff could not be read.
       * @param {object} draft - Draft state.
       * @param {string} tabId - The tab being drawn.
       * @param {string} path - The path that was read.
       * @param {string} code - The Remote failure code.
       * @param {string} message - The Remote failure message.
       */
      diffFailed: (draft, tabId, path, code, message) => {
        const tab = draft.byTab[tabId]
        if (tab !== undefined) tab.diffs[path] = { kind: 'failed', code, message }
      },
      /**
       * Forget one path's diff body, so opening it reads it again.
       * @param {object} draft - Draft state.
       * @param {string} tabId - The tab being drawn.
       * @param {string} path - The path to forget.
       */
      diffForget: (draft, tabId, path) => {
        const tab = draft.byTab[tabId]
        if (tab !== undefined) delete tab.diffs[path]
      },
      /**
       * Open one path's diff.
       * @param {object} draft - Draft state.
       * @param {string} tabId - The tab being drawn.
       * @param {string} path - The path to open.
       */
      select: (draft, tabId, path) => {
        const tab = draft.byTab[tabId]
        if (tab !== undefined) tab.selected = path
      },
      /**
       * Show or hide the staged paths.
       * @param {object} draft - Draft state.
       * @param {string} tabId - The tab being drawn.
       * @param {readonly string[]} paths - Every staged path in the current report.
       */
      toggleStaged: (draft, tabId, paths) => {
        const tab = draft.byTab[tabId]
        if (tab === undefined) return
        if (Object.keys(tab.staged).length > 0) {
          tab.staged = {}
          return
        }
        tab.staged = Object.fromEntries(paths.map(path => [path, true]))
      },
      /**
       * Forget one tab's bucket, for a tab record that is gone.
       * @param {object} draft - Draft state.
       * @param {string} tabId - The tab that went away.
       */
      forget: (draft, tabId) => {
        delete draft.byTab[tabId]
      },
    },
  })
}
