/**
 * Wiring test for the browser half.
 *
 * The bundle is not a module the test runner can import: it is the shell's
 * lazy-CJS factory, which registers itself on a global loader and only then
 * hands back an `apply`. Running it inside a `node:vm` with a stub `window`,
 * `document`, and `require` is what makes the registration observable at all,
 * and it is the only place that proves the three-child composition and the
 * registrations the tab system needs are actually wired.
 *
 * The stub context honors each child's `inject` the way Cordis does — a child
 * whose services are absent is parked, not applied — so the panel child is
 * exercised both with and without `dsh-better-sidebar`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

/** Load `lib/client.js` as the shell's module loader would, and return its `apply`. */
function loadClientHalf() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const sheets = []
  let registration
  globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value } } }
  globalThis.document = {
    createElement: () => ({
      attrs: {},
      setAttribute(name, value) { this.attrs[name] = value },
      set textContent(value) { this.css = value },
    }),
    head: { appendChild: (element) => sheets.push(element) },
  }
  new vm.Script(source, { filename: 'lib/client.js' }).runInThisContext()
  const react = {}
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: {} }
  const clientStore = { defineStore: (spec) => ({ spec, create: () => ({}) }) }
  const rows = new Map([
    ['react', react],
    ['react/jsx-runtime', jsx],
    ['@deepseek-ai/dsh-client-store', clientStore],
    ['@deepseek-ai/dsh-client-ui-primitives', { FileTypeIcon: () => null }],
  ])
  const exports = registration.factory((name) => {
    if (!rows.has(name)) throw new Error(`client bundle requested an undeclared module row: ${name}`)
    return rows.get(name)
  })
  return { apply: exports.apply, registration, sheets }
}

/**
 * A Cordis-shaped context that records what the plugin contributes.
 * @param {object} [services] - Stand-ins for optional services `ctx.get` may return.
 * @returns {{ ctx: object, record: object }} The context and its record.
 */
function recordingContext(services = {}) {
  const record = {
    plugins: [], applied: [], effects: [], mounts: [], tabTypes: [], locales: [], slotInjects: [], slotRegisters: [], panelTabs: [],
  }
  const ctx = {
    plugin: (spec) => {
      record.plugins.push({ name: spec.name, inject: spec.inject })
      // Cordis parks a child until every injected service exists; emulate that
      // so the panel child is not applied without `betterSidebar`.
      if (!(spec.inject ?? []).every(name => hasService(ctx, services, name))) return
      record.applied.push(spec.name)
      spec.apply(ctx)
    },
    get: (name) => services[name],
    effect: (run, label) => { record.effects.push(label); return run() },
    // `$mount` provides the namespace; the stub carries it directly, because
    // the face refuses to build without a mounted `workspaceReview`.
    remote: {
      $mount: (contribution) => { record.mounts.push(contribution.package); return () => {} },
      workspaceReview: { changes: async () => ({ ok: true, value: {} }), diff: async () => ({ ok: true, value: {} }) },
    },
    sidebarRightTabs: {
      register: (definition) => {
        record.tabTypes.push({
          id: definition.id,
          kind: definition.kind,
          priority: definition.priority,
          patterns: definition.patterns,
          guide: definition.guide,
        })
        return () => {}
      },
    },
    locale: {
      bind: (namespace) => (key) => `${namespace}:${key}`,
      register: (namespace, dictionaries) => {
        record.locales.push({ namespace, languages: Object.keys(dictionaries).sort() })
        return () => {}
      },
    },
    slots: {
      inject: (name, contribution) => { record.slotInjects.push(name); return contribution() },
      register: (options, component) => {
        record.slotRegisters.push({
          name: options.name,
          key: options.key,
          locale: options.locale,
          hasStore: options.store !== undefined,
          hasInject: options.inject !== undefined,
          component: component.name,
        })
        return () => {}
      },
    },
  }
  if (services.betterSidebar !== undefined) ctx.betterSidebar = services.betterSidebar
  return { ctx, record }
}

/** Whether a stub context carries one Cordis service name. */
function hasService(ctx, services, name) {
  if (name === 'remote.workspaceReview') return ctx.remote.workspaceReview !== undefined
  if (name === 'betterSidebar') return ctx.betterSidebar !== undefined
  return ctx[name] !== undefined
}

test('the client bundle registers under this package name', () => {
  const { registration, sheets } = loadClientHalf()
  assert.equal(registration.id, 'dsh-review')
  // The plugin loader fetches one script per plugin, so the stylesheet has to
  // travel inside it.
  assert.equal(sheets.length, 1)
  assert.equal(sheets[0].attrs['data-plugin-css'], 'dsh-review/ReviewBody.module.css')
  assert.match(sheets[0].css, /--dsw-alias-state-success-primary/)
})

test('apply composes a mount child, a UI child, and a panel child', () => {
  const { apply } = loadClientHalf()
  const { ctx, record } = recordingContext()
  apply(ctx)
  assert.deepEqual(record.plugins.map(entry => entry.name), ['dsh-review/mount', 'dsh-review/ui', 'dsh-review/panel'])
  const ui = record.plugins.find(entry => entry.name === 'dsh-review/ui')
  assert.ok(ui.inject.includes('remote.workspaceReview'))
  const panel = record.plugins.find(entry => entry.name === 'dsh-review/panel')
  assert.ok(panel.inject.includes('betterSidebar'))
})

test('apply mounts the Remote contribution', () => {
  const { apply } = loadClientHalf()
  const { ctx, record } = recordingContext()
  apply(ctx)
  assert.deepEqual(record.mounts, ['dsh-review'])
})

test('apply registers a page tab type with no guide entry', () => {
  const { apply } = loadClientHalf()
  const { ctx, record } = recordingContext()
  apply(ctx)
  assert.deepEqual(record.tabTypes, [{
    id: 'dsh-review',
    kind: 'review',
    priority: 'extension',
    patterns: undefined,
    guide: undefined,
  }])
})

test('apply registers both dictionaries and the native tab seat', () => {
  const { apply } = loadClientHalf()
  const { ctx, record } = recordingContext()
  apply(ctx)
  assert.deepEqual(record.locales, [{ namespace: 'sidebarReview', languages: ['en', 'zh'] }])
  assert.deepEqual(record.slotInjects, ['sidebar.right.pane.tab'])
  assert.deepEqual(record.slotRegisters, [{
    name: 'sidebar.right.pane.tab',
    key: 'dsh-review',
    locale: 'sidebarReview',
    hasStore: true,
    hasInject: true,
    component: 'ReviewBody',
  }])
})

test('the panel child is parked when dsh-better-sidebar is absent', () => {
  const { apply } = loadClientHalf()
  const { ctx, record } = recordingContext()
  apply(ctx)
  assert.deepEqual(record.panelTabs, [])
  assert.ok(!record.applied.includes('dsh-review/panel'))
  // The native half is unaffected.
  assert.ok(record.applied.includes('dsh-review/ui'))
})

test('the panel child registers the same tab when dsh-better-sidebar is present', () => {
  const { apply } = loadClientHalf()
  const { ctx, record } = recordingContext({
    betterSidebar: { registerTab: (descriptor) => { record.panelTabs.push(descriptor); return () => {} } },
  })
  apply(ctx)
  assert.equal(record.panelTabs.length, 1)
  const [descriptor] = record.panelTabs
  assert.equal(descriptor.id, 'dsh-review:panel')
  assert.equal(descriptor.single, true)
  assert.equal(typeof descriptor.component, 'function')
  // The panel's own seats are untouched: the native registration still happened.
  assert.deepEqual(record.slotRegisters.map(entry => entry.name), ['sidebar.right.pane.tab'])
})

/** Register the panel tab into a stub better-sidebar and return its descriptor. */
function panelDescriptor(services) {
  const { apply } = loadClientHalf()
  let descriptor
  const { ctx, record } = recordingContext({
    ...services,
    betterSidebar: {
      ...services.betterSidebar,
      registerTab: (value) => { descriptor = value; return () => {} },
    },
  })
  apply(ctx)
  assert.equal(record.applied.includes('dsh-review/panel'), true)
  assert.notEqual(descriptor, undefined)
  return { descriptor, record }
}

/** The props the panel body would receive for one tab. */
function panelProps(descriptor) {
  return descriptor.component({ scope: { sessionId: 's1', cwd: '/w' }, tab: { id: 't1' }, store: {} }).props
}

test('the panel opener falls back to the right column when the editor tab is off', () => {
  // The failure this exists for: better-sidebar's `openFile` opens a tab of type
  // `editor`, and its `openTab` refuses a disabled type with a console warning
  // only — so with the editor tab switched off in the side card settings, the
  // open action did nothing at all. The column is asked instead.
  const calls = []
  const { descriptor } = panelDescriptor({
    betterSidebar: {
      registerTab: () => () => {},
      isTabEnabled: () => false,
      openFile: (_scope, path) => calls.push(['panel', path]),
    },
    sidebarRight: { openResource: (address) => calls.push(['column', address]) },
  })
  const props = panelProps(descriptor)
  assert.equal(props.openBlocked, false)
  props.openFile('drafts/a b#c?.txt')
  assert.deepEqual(calls, [['column', 'dsh-resource://file/session/s1/drafts/a%20b%23c%3F.txt']])
})

test('the panel opener stays better-sidebar\'s while its editor tab is on', () => {
  const calls = []
  const { descriptor } = panelDescriptor({
    betterSidebar: {
      registerTab: () => () => {},
      isTabEnabled: () => true,
      openFile: (_scope, path) => calls.push(['panel', path]),
    },
    sidebarRight: { openResource: (address) => calls.push(['column', address]) },
  })
  panelProps(descriptor).openFile('a.txt')
  assert.deepEqual(calls, [['panel', 'a.txt']])
})

test('a disabled editor tab with no column to fall back to is stated, not offered', () => {
  const calls = []
  const { descriptor } = panelDescriptor({
    betterSidebar: {
      registerTab: () => () => {},
      isTabEnabled: () => false,
      openFile: (_scope, path) => calls.push(['panel', path]),
    },
  })
  const props = panelProps(descriptor)
  // Nothing can open it, so the body disables the button and says why.
  assert.equal(props.openBlocked, true)
})

test('the panel uses a column that throws rather than leaving the click dead', () => {
  // `openResource` throws when no seat is mounted; the panel's own opener is the
  // fallback path, because a viewer somewhere beats nothing happening.
  const calls = []
  const { descriptor } = panelDescriptor({
    betterSidebar: {
      registerTab: () => () => {},
      isTabEnabled: () => false,
      openFile: (_scope, path) => calls.push(['panel', path]),
    },
    sidebarRight: { openResource: () => { throw new Error('no session surface is mounted') } },
  })
  panelProps(descriptor).openFile('a.txt')
  assert.deepEqual(calls, [['panel', 'a.txt']])
})

test('the shipped dictionaries carry the same keys', async () => {
  // The client bundle exports no dictionaries, so they are read from source;
  // this is the check the missing `satisfies` clause would otherwise give.
  const source = readFileSync(new URL('../src/client/locales.js', import.meta.url), 'utf8')
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`)
  assert.deepEqual(Object.keys(module.zh).sort(), Object.keys(module.en).sort())
  assert.ok(Object.keys(module.zh).length > 20)
})
