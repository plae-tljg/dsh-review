/**
 * Render tests for the Review tab body.
 *
 * The component is rendered through `react-dom/server` against a driven store,
 * so the tree's real output is asserted rather than a guess about it: which
 * rows exist, what indent each carries, and which folder totals are shown. The
 * three framework hooks are stubs, which is the sanctioned way to feed a
 * component its props without render machinery.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import vm from 'node:vm'

/**
 * Resolve one specifier the way the running GUI does: through Node resolution
 * rooted at the profile that supplies the client baseline. The plugin carries no
 * React dependency of its own, because the shell provides those module rows.
 * @param {string} specifier - An npm specifier, subpaths included.
 * @returns {any} The loaded module.
 */
const profileRequire = createRequire(`${process.env.HOME}/.dsh/profiles/web/package.json`)

/**
 * Resolve one client-baseline specifier.
 *
 * The shell seeds `client-store`, so a profile never installs it and the harness
 * checkout is where the test finds it; React and React DOM are profile
 * dependencies, so they come from there.
 * @param {string} specifier - An npm specifier.
 * @returns {any} The loaded module.
 */
function clientRequire(specifier) {
  return specifier === '@deepseek-ai/dsh-client-store'
    ? createRequire(import.meta.url)(specifier)
    : profileRequire(specifier)
}

/** Build a report shaped exactly as the Host sends it. */
function reportFixture() {
  const files = [
    { path: 'README.md', status: 'modified', index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false, renamedFrom: null, added: 1, removed: 0 },
    { path: 'src/client/ReviewBody.tsx', status: 'modified', index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false, renamedFrom: null, added: 20, removed: 4 },
    { path: 'src/client/deep/leaf.ts', status: 'untracked', index: '?', worktree: '?', staged: false, unstaged: false, untracked: true, renamedFrom: null, added: null, removed: null },
  ]
  const tree = {
    directories: [{
      kind: 'directory',
      name: 'src',
      path: 'src',
      directories: [{
        kind: 'directory',
        name: 'client',
        path: 'src/client',
        directories: [],
        files: [files[1], files[2]],
        added: 20,
        removed: 4,
      }],
      files: [],
      added: 20,
      removed: 4,
    }],
    files: [files[0]],
  }
  return {
    isRepository: true,
    root: '/repo',
    branch: 'main',
    detached: false,
    upstream: 'origin/main',
    ahead: 2,
    behind: 0,
    files,
    tree,
    added: 21,
    removed: 4,
    truncated: false,
  }
}

/** Render the tab body against one report and return its HTML. */
async function renderBody(report, options = {}) {
  const { renderToStaticMarkup } = clientRequire('react-dom/server')
  const React = clientRequire('react')
  const { apply } = await loadClientHalf()
  let Body
  const css = { name: 'review' }
  const ctx = {
    plugin: (spec) => {
      // Cordis parks a child whose injected services are absent; the panel
      // child is skipped here because there is no `betterSidebar`.
      if (!(spec.inject ?? []).every(name => name === 'remote.workspaceReview' || ctx[name] !== undefined)) return
      spec.apply(ctx)
    },
    get: () => undefined,
    effect: (run) => run(),
    remote: {
      $mount: () => () => {},
      workspaceReview: { changes: async () => ({ ok: true, value: {} }), diff: async () => ({ ok: true, value: {} }) },
    },
    sidebarRightTabs: { register: () => () => {} },
    locale: { bind: () => (key) => key, register: () => () => {} },
    slots: {
      inject: (_name, contribution) => contribution(),
      register: (_options, component) => { Body = component; return () => {} },
    },
  }
  apply(ctx)
  const state = { byTab: { t1: { report: { kind: 'ready', report }, diffs: options.diffs ?? {}, selected: 'src/client/ReviewBody.tsx', staged: {}, source: 'git', roundTurn: null, roundPath: null, ...options.bucket } } }
  // The component goes through React, not a direct call: calling it as a plain
  // function would run its hooks outside a renderer and throw.
  return renderToStaticMarkup(React.createElement(Body, {
    useTabInfo: () => ({ tab: { id: 't1', signal: new AbortController().signal, actions: options.actions ?? {}, title: 'Review', visible: true, params: {} } }),
    useStore: (selector) => selector(state),
    actions: { toggleStaged: () => {}, select: () => {}, start: () => {} },
    start: () => {}, refresh: () => {}, select: () => {}, open: () => {},
    t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
    css,
    ...options.extra,
  }))
}

/** One settled edit node for the Rounds snapshot fixture. */
function roundNode() {
  return {
    kind: 'tool-result',
    seq: 5,
    isError: false,
    callId: 'call-5',
    subCalls: [],
    call: { name: 'edit', argsRaw: JSON.stringify({ file_path: 'src/app.ts', old_string: 'old', new_string: 'new' }) },
    meta: { diffs: [{ path: 'src/app.ts', oldText: 'old', newText: 'new' }] },
  }
}

/** Render the tab body in Rounds mode against a hand-built snapshot. */
async function renderRounds() {
  const { renderToStaticMarkup } = clientRequire('react-dom/server')
  const React = clientRequire('react')
  const { apply } = await loadClientHalf()
  let Body
  const ctx = {
    plugin: (spec) => {
      if (!(spec.inject ?? []).every(name => name === 'remote.workspaceReview' || ctx[name] !== undefined)) return
      spec.apply(ctx)
    },
    get: () => undefined,
    effect: (run) => run(),
    remote: {
      $mount: () => () => {},
      workspaceReview: { changes: async () => ({ ok: true, value: {} }), diff: async () => ({ ok: true, value: {} }) },
    },
    sidebarRightTabs: { register: () => () => {} },
    locale: { bind: () => (key) => key, register: () => () => {} },
    slots: {
      inject: (_name, contribution) => contribution(),
      register: (_options, component) => { Body = component; return () => {} },
    },
  }
  apply(ctx)
  const snapshot = {
    views: {
      get: (name) => (name === 'chat'
        ? { legacy: { nodes: [roundNode()], turnEnds: new Map([[1, 100]]), partial: null, runningCalls: [] } }
        : undefined),
    },
  }
  const conversation = { subscribe: () => () => {}, getSnapshot: () => snapshot }
  const state = {
    byTab: {
      t1: {
        report: { kind: 'loading' }, diffs: {}, selected: null, staged: {},
        source: 'rounds', roundTurn: 1, roundPath: 'src/app.ts',
      },
    },
  }
  return renderToStaticMarkup(React.createElement(Body, {
    useTabInfo: () => ({ tab: { id: 't1', signal: new AbortController().signal } }),
    useStore: (selector) => selector(state),
    actions: { toggleStaged: () => {}, select: () => {}, start: () => {}, setSource: () => {}, selectRound: () => {} },
    start: () => {}, refresh: () => {}, select: () => {}, open: () => {},
    conversation,
    t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
  }))
}

test('the Rounds view renders a round, its tree, and the selected diff', async () => {
  const html = await renderRounds()
  assert.match(html, /data-review-state="rounds"/)
  assert.match(html, /round\.label/)
  assert.match(html, />src</)
  assert.match(html, /app\.ts/)
  assert.match(html, /data-review-round-diff="src\/app\.ts"/)
  // The recorded hunk is expanded into red/green lines.
  assert.match(html, /data-kind="del"/)
  assert.match(html, /data-kind="add"/)
})

test('the body renders the file tree with folder totals and root files', async () => {
  const html = await renderBody(reportFixture())
  // Both directories, including the folded one, with their aggregates.
  assert.match(html, />src</)
  assert.match(html, /\+20/)
  // The root-level file is rendered beside the tree, not dropped.
  assert.match(html, /README\.md/)
  assert.match(html, /ReviewBody\.tsx/)
  assert.match(html, /leaf\.ts/)
  // The workspace totals and the branch summary.
  assert.match(html, /\+21/)
  assert.match(html, /main/)
  // A binary file's row says so instead of showing a bogus +0 -0.
  assert.match(html, /bin/)
})

test('the diff header opens the file and defaults to no wrap', async () => {
  const diff = {
    untracked: false,
    truncated: false,
    patch: '@@ -1 +1 @@',
    file: {
      path: 'src/client/ReviewBody.tsx',
      oldPath: null,
      binary: false,
      notice: null,
      hunks: [{
        header: '',
        oldStart: 1,
        newStart: 1,
        oldCount: 1,
        newCount: 1,
        lines: [
          { kind: 'del', text: 'old', oldNumber: 1, newNumber: null },
          { kind: 'add', text: 'new', oldNumber: null, newNumber: 1 },
        ],
      }],
    },
  }
  const html = await renderBody(reportFixture(), {
    diffs: { 'src/client/ReviewBody.tsx': { kind: 'ready', diff } },
    extra: { sessionId: 's1', openFile: () => {} },
  })
  // The open affordance is present when an opener exists, and the diff starts
  // unwrapped so a long line scrolls rather than being clipped.
  assert.match(html, /data-review-open/)
  assert.match(html, /data-wrap="off"/)
  assert.match(html, /data-kind="del"/)
  assert.match(html, /data-kind="add"/)
})

test('the body indents a nested row deeper than its folder', async () => {
  const html = await renderBody(reportFixture())
  const indentOf = (needle) => {
    const at = html.indexOf(needle)
    assert.notEqual(at, -1, `missing ${needle}`)
    const tag = html.lastIndexOf('<button', at)
    return Number(/padding-left:(\d+)px/.exec(html.slice(tag, at))?.[1])
  }
  assert.ok(indentOf('>src<') < indentOf('>ReviewBody.tsx<'), 'a file must indent past its folder')
  assert.ok(indentOf('>README.md<') < indentOf('>ReviewBody.tsx<'), 'a root file must indent less than a nested one')
})

test('the body reports an empty tree as no changes', async () => {
  const empty = { ...reportFixture(), files: [], tree: { directories: [], files: [] }, added: 0, removed: 0 }
  const html = await renderBody(empty)
  assert.match(html, /data-review-state="empty"/)
  assert.match(html, /empty\.title/)
})

test('the Commit view lists commits', async () => {
  const oid = 'a'.repeat(40)
  const html = await renderBody(reportFixture(), {
    bucket: {
      source: 'commits',
      commits: {
        kind: 'ready',
        report: {
          isRepository: true,
          root: '/repo',
          commits: [{ oid, short: 'aaaaaaa', timestamp: 1, author: 'T', subject: 'first commit' }],
        },
      },
    },
  })
  assert.match(html, /data-review-state="commits"/)
  assert.match(html, /data-review-commit/)
  assert.match(html, /first commit/)
  assert.match(html, /aaaaaaa/)
})

test('the Files view shows a tree and the selected content', async () => {
  const entry = {
    path: 'notes.md', status: 'modified', index: ' ', worktree: ' ', staged: false,
    unstaged: false, untracked: false, renamedFrom: null, added: null, removed: null,
  }
  const html = await renderBody(reportFixture(), {
    bucket: {
      source: 'files',
      files: {
        kind: 'ready',
        report: { isRepository: true, root: '/repo', count: 1, truncated: false, files: [entry], tree: { directories: [], files: [entry] } },
      },
      filePath: 'notes.md',
      fileContent: { 'notes.md': { kind: 'ready', file: { path: 'notes.md', binary: false, truncated: false, bytes: 6, text: 'hello\n' } } },
    },
  })
  assert.match(html, /data-review-state="files"/)
  assert.match(html, /notes\.md/)
  assert.match(html, /data-review-file="notes\.md"/)
  assert.match(html, /hello/)
})

test('the body reports a non-repository workspace', async () => {
  const html = await renderBody({
    isRepository: false, root: null, branch: null, detached: false, upstream: null,
    ahead: 0, behind: 0, files: [], tree: { directories: [], files: [] }, added: 0, removed: 0, truncated: false,
  })
  assert.match(html, /data-review-state="not-repository"/)
  assert.match(html, /notRepository/)
})

/** Load the built client bundle and hand back its `apply`. */
async function loadClientHalf() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration
  globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value } } }
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, set textContent(value) {} }),
    head: { appendChild() {} },
  }
  new vm.Script(source, { filename: 'lib/client.js' }).runInThisContext()
  const react = clientRequire('react')
  const jsxRuntime = clientRequire('react/jsx-runtime')
  const clientStore = clientRequire('@deepseek-ai/dsh-client-store')
  const rows = new Map([
    ['react', react],
    ['react/jsx-runtime', jsxRuntime],
    ['@deepseek-ai/dsh-client-store', clientStore],
    ['@deepseek-ai/dsh-client-ui-primitives', { FileTypeIcon: () => null }],
  ])
  return registration.factory((name) => {
    if (!rows.has(name)) throw new Error(`undeclared module row: ${name}`)
    return rows.get(name)
  })
}
