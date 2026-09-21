# How a right-sidebar tab plugin is built in the DSH web client

Template package: `packages/client/ui-sidebar-files` (`@deepseek-ai/dsh-client-ui-sidebar-files`).
Host package: `packages/client/ui-sidebar-right` (`@deepseek-ai/dsh-client-ui-sidebar-right`).
All paths are relative to the checkout `/home/fit/00lib/deepseek-harness`. Nothing was modified.

---

## 0. TL;DR — the minimal contract of a right-sidebar tab type

A tab type is **two registrations in two stages**, both inside the plugin's own `ctx.effect`, both keyed by the
type definition's `id` (never by `kind`):

```ts
// stage 1 — what the type IS  (ctx.sidebarRightTabs.register)
ctx.effect(() => ctx.sidebarRightTabs.register(filesDefinition(t)), '...')
// stage 2 — what it DRAWS     (ctx.slots.inject + ctx.slots.register)
ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab',       () => ctx.slots.register({ name: 'sidebar.right.pane.tab',       key: FILES_ID, locale: NS, store, inject }, FilesBody )), '...')
ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: FILES_ID }, FilesTitle)), '...')
```

Plus: `ctx.locale.bind(NS)` + `ctx.locale.register(NS, { zh, en })`, an exported `inject` service-name array, an empty
node-half `apply` in `src/index.ts`, a `dsh.client` manifest, a `clientBundle(...)` tsdown config, and three
registration surfaces outside the package (`tsconfig.client.json`, `cordis.patch.yml`, `packages/bundle/web-app/package.json`).
Checklist authority: `packages/client/AGENTS.md:134-143` ("New plugin package checklist").

---

## 1. `packages/client/ui-sidebar-files/` file by file

### 1.1 `package.json` — identity, entrypoints, client manifest, publication payload

- `name` / `version` / `description`: `package.json:2-4`. Description states the plugin's product role.
- `main: "lib/index.js"`, `types: "lib/types/index.d.ts"` (`package.json:14-15`).
- `exports` (`package.json:16-27`) — the four required subpaths:
  - `.` → `./lib/types/index.d.ts` + `./lib/index.js` (node half);
  - `./client` → `./lib/types/client/index.d.ts` + `./lib/client.js` (browser bundle; **required** by the `dsh.client`
    scan, see `packages/client/AGENTS.md:140`);
  - `./src/*` → `./src/*` (test-time direct source access);
  - `./package.json`.
- `dsh.client` (`package.json:28-38`):
  ```json
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-api-workspace-files",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-api-remotes"
      ],
      "platform": "web"
    }
  }
  ```
  `platform: 'web'` always; `inject` is the **informational package-name edge list** (preflight display, HMR diffing —
  `packages/client/AGENTS.md:140`), not activation order. Activation order is Cordis fiber `inject` waiting on
  *services*. `scripts/verify-client-packages.ts` checks/repairs this array from real imports
  (`scripts/verify-client-packages.ts:234`).
- `scripts`: `bundle: "tsdown"`, `watch: "tsdown --watch"` (`package.json:39-42`).
- `peerDependencies`: only `@deepseek-ai/cordis` (`package.json:44-46`) — every client package keeps Cordis in matching
  peer+dev sections (`packages/client/AGENTS.md:61`).
- `devDependencies` (`package.json:47-68`): Cordis; the workspace packages it type-imports
  (`dsh-api-remotes`, `dsh-api-workspace-files`, `dsh-client-locale`, `dsh-client-store`,
  `dsh-client-test-runtime`, `dsh-client-ui-dockkit`, `dsh-client-ui-primitives`, `dsh-client-ui-renderer`,
  `dsh-client-ui-session`, `dsh-client-ui-sidebar-right`, `dsh-client-ui-slots`, `dsh-session`,
  `dsh-util-workspace-path`) plus React/testing libs. **Browser and type relationships are dev-only**
  (`packages/client/AGENTS.md:63`); `clsx` is a dev-dep because it is inlined into the bundle.
- `files` (`package.json:69-73`): `lib/index.js`, `lib/client.js`, `lib/types/**/*.d.ts` — the published payload must
  cover every relative runtime import and emitted asset (`packages/client/AGENTS.md:67`).
- Note what is **absent**: no `./invariant` export, no `lib/invariant.js`. The README must then carry the
  "No companion is published" sentence that `scripts/package-invariants.ts:18` requires:
  `OMITTED_COMPANION_REASON = /No (?:(?:runtime )?invariant )?companion is published(?: because|[.:;—])\s+\S/i`
  — satisfied verbatim by the closing line of `README.md`.

### 1.2 `tsconfig.json` — project references, one per workspace edge

```json
{ "extends": "../../../tsconfig.base.client.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
  "include": ["src"],
  "references": [ cordis, api/remotes, core/session, ../locale, ../store, ../ui-dockkit, ../ui-primitives,
                  ../ui-session, ../ui-sidebar-right, ../ui-slots, util/workspace-path, api/workspace-files ] }
```
(`tsconfig.json:1-47`.) `outDir: lib/types` is what produces the `lib/types/client/index.js` the browser bundle
consumes (`packages/client/tsdown.client.ts:97-98`). One `references` entry per workspace dependency is mandatory
(`packages/client/AGENTS.md:138`).

### 1.3 `tsdown.config.ts` — 3 lines

```ts
import { clientBundle } from '../tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-client-ui-sidebar-files', ['lib/types/index.js'])
```
(`tsdown.config.ts:1-3`.) See §7 for what the preset does.

### 1.4 `src/index.ts` — the node (host) half

```ts
/** Pure host half; the whole tab type lives in the browser export. */

/** Host plugin body: the file tree contributes nothing to the host tree. */
export function apply(): void {}
```
(`src/index.ts:1-4`.) Every client UI plugin ships this inert host entry so the host Loader can import the package
(`packages/client/tsdown.client.ts:94-96`). `tests/apply.client.spec.ts:62-64` asserts it stays inert.

### 1.5 `src/css-modules.d.ts` — ambient CSS Modules + raw CSS declarations

```ts
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'
```
(`src/css-modules.d.ts:1-6`.) Required only when the package imports CSS; the tsdown preset rewrites
`*.module.css` into a hashed class map + injected `<style>` (§7), so this file only satisfies `tsc`.

### 1.6 `src/client/` — seven source files, one responsibility each

The split is the package's layering, stated in `src/client/index.ts:8-11`:

| File | Role |
|---|---|
| `definition.tsx` | **What the type IS** — the `SidebarRightTabDefinition` + the two exported constants. |
| `store.ts` | **What it keeps** — the `createFilesStore()` factory, state and write set. |
| `face.ts` | **How it talks** — the async listing, the Remote binding, the Slot `inject` factory. |
| `FilesBody.tsx` | **What it draws** — the body component + pure helpers. |
| `FilesTitle.tsx` | **The chip title** — the `sidebar.right.pane.tab.title` component. |
| `locales.ts` | **What it says** — `zh`/`en` dictionaries + `LocaleNamespaceMap` merge. |
| `index.ts` | **The wiring** — `inject`, `apply`, public type re-exports. |
| `FilesBody.module.css` | The body's CSS Module (tokens only). |

#### `src/client/index.ts` (verbatim, `index.ts:13-58`)

```ts
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { FILES_ID, filesDefinition } from './definition.tsx'
import { createList, filesFace } from './face.ts'
import { FilesBody } from './FilesBody.tsx'
import { FilesTitle } from './FilesTitle.tsx'
import { en, zh } from './locales.ts'
import { createFilesStore } from './store.ts'

export type { SidebarFilesKey } from './locales.ts'
export type { DirLevel, FilesState, FilesTabState, LevelState } from './store.ts'
export type { FilesInjected, ListWorkspaceDirectory, WorkspaceFilesListRemote } from './face.ts'
export type { FilesBodyProps } from './FilesBody.tsx'

/** This package's copy namespace. */
const NS = 'sidebarFiles'

/**
 * Required browser services: the tab registry, the keyed seat, the Remote
 * carrier and its namespace, and copy.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']

/**
 * Client plugin body: register the type, its dictionaries, its body, and its chip title.
 * @param ctx - client root context carrying the registry, the slots, and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(filesDefinition(t)), 'ui-sidebar-files: files type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar-files: dictionaries')

  const store = createFilesStore()
  const inject = filesFace(createList(ctx.remote))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: FILES_ID, locale: NS, store, inject },
    FilesBody,
  )), 'ui-sidebar-files: files tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: FILES_ID },
    FilesTitle,
  )), 'ui-sidebar-files: files tab title')
}
```

Export discipline that this file obeys (`packages/client/AGENTS.md:30-36`): only `apply`/`inject` (loading needs) +
shared *types* + the store factory's return type. `createFilesStore` itself is a value export consumed as
`ReturnType<typeof createFilesStore>` by components; implementation helpers stay internal.

#### `src/client/definition.tsx` (verbatim core, `definition.tsx:13-41`)

```tsx
/** The tab kind this package owns. */
export const FILES_KIND = 'files'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const FILES_ID = '@deepseek-ai/dsh-client-ui-sidebar-files'

/** The type's coloured folder sheet at the guide capsule's glyph size, as the chip title draws it. */
function FolderSheetGlyph({ size, className }: IconProps) {
  return <FileTypeIcon kind="folder" size={size} className={className} />
}

export function filesDefinition(t: TranslateNS<'sidebarFiles'>): SidebarRightTabDefinition {
  return {
    id: FILES_ID,
    kind: FILES_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      order: 10,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: FolderSheetGlyph,
    }],
  }
}
```

Key decisions:
- `patterns` omitted ⇒ **page type**, opened by `kind`, claims no resource address (contrast
  `ui-sidebar-documentpreview/src/client/definition.ts:45-53`, which declares `patterns: ['dsh-resource://file/**']`,
  `priority: 'fallback'`, `canOpen`, and `title: basenameOf`).
- `priority: 'builtin'` — the band for product-shipped types (`extension` is the default and highest; `fallback` is
  for plain viewers). Bands are string literals so no runtime import from `ui-sidebar-right` is needed
  (`ui-sidebar-right/src/client/tab-registry.ts:35-58`).
- Thunked copy (`title`, `guide[].title`, `guide[].description`) is re-read on every use, so a language change needs
  no re-registration (`tab-registry.ts:23-25`).
- `id` is the implementation identity (unique across all registrations; a second registration of an id throws —
  `tab-registry.ts:245`) and **is the key both seats register under**.

#### `src/client/store.ts` — see §5.

#### `src/client/face.ts` — the Slot-standard `inject` factory

Declares the two injected pieces of data access: `ListWorkspaceDirectory` (a `RemoteResult`-returning call) and
`WorkspaceFilesListRemote` (the `Pick<ClientRemote['workspaceFiles'], 'list'>` slice the package may name —
`face.ts:34-46`); `createList(remote)` adapts the endpoint's payload down to `{ entries, truncated }` (`face.ts:53-59`);
`filesFace(list)` returns `(sessionId, actions) => FilesInjected` — **exactly the `InjectParams` shape** the slot
framework calls: strict session scope ⇒ `sessionId` definite, declared store ⇒ baked `actions` appended
(`ui-slots/src/index.ts:499-506`). The returned face is three plain callbacks, `start` / `load` / `toggle`
(`face.ts:75-98`), plus generation bookkeeping so a superseded listing writes nothing (`face.ts:112-132`) and an
abort listener that drops the tab's bucket (`face.ts:136-139`).

#### `src/client/FilesBody.tsx` — the body

Props = the four shares (`FilesBody.tsx:29-34`):

```tsx
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createFilesStore>>
  & FilesInjected
  & PropsLocale<'sidebarFiles'>
```

Where each share comes from: `PropsRuntime` gives `useTabInfo` (slot-level inject) + `sessionId`/`useSessions`
(session standard kit) + global hooks (`ui-slots/src/index.ts:222-232`); `PropsStore` gives `useStore`/`actions`
(`client/store/src/contract.ts:135-137`); `FilesInjected` is the inject factory's return; `PropsLocale` gives `t`
(`ui-slots/src/index.ts:90-94`). The component reads `tab.signal` and `tab.actions.openResource` from `useTabInfo`
(`FilesBody.tsx:173-175`), seeds its bucket on first render (`FilesBody.tsx:180-185`), and never awaits.

#### `README.md` / `README.zh.md` / `README.i18n.yaml`

`README.md` is a `package-reference` doc (front matter `description`/`kind`, `README.md:1-4`) with a fixed section
order gated by `scripts/verify-package-readme-model-experience.ts`: `## Model Experience` (with the
`#### KV Cache effect` field) before `## Known Limitations and Deferred Work`, and a closing runtime-invariant line.
`README.i18n.yaml` records the git blob hashes of the bilingual pair, maintained by
`pnpm run verify-translation-pairing --write <README.md>`.

---

## 2. The four seats — exact keys, cardinality, scope, owner props

Declared in `packages/client/ui-sidebar-right/src/client/contract/slots.ts:34-88` — quoted **verbatim**:

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Right-Sidebar chrome, docking-kit vocabulary, and guide copy. */
    sidebarRight: SidebarRightKey
  }

  interface SlotMap {
    /** Session content selected by the root-scoped right Sidebar controller. */
    'rightbar.session': { kind: 'single'; scope: 'session'; owner: RightbarOwnerProps }
    /**
     * One tab's body, dispatched with the `id` of the type in force for
     * `tab.kind`. A tab type registers here under its definition's `id` and
     * receives every tab of that kind, in every pane, docked or floating. A kind
     * with no type in force renders the owner's "nothing can view this" notice
     * rather than an empty pane.
     */
    'sidebar.right.pane.tab': {
      kind: 'keyed'
      scope: 'session'
      hookContext: TabHookContext
      inject: SidebarRightTabInjected
    }
    /**
     * A tab's title as its chip (and a floating panel's header) shows it,
     * dispatched with the same key and information hook as the body. A type with a
     * live title — a terminal named after its shell, a chat after its first
     * line — registers here and reads its own store; one without registers
     * nothing and the chip shows the registry's `title(address)` text captured
     * at open time.
     */
    'sidebar.right.pane.tab.title': {
      kind: 'keyed'
      scope: 'session'
      hookContext: TabHookContext
      inject: SidebarRightTabInjected
    }
    /**
     * The guide tab's body. Selectors run in chain order and the first
     * non-declining entry replaces the shipped guide entirely; with no entry, or
     * with every entry declining, the shipped guide renders.
     */
    'sidebar.right.tab.guide': {
      kind: 'chain'
      scope: 'session'
      hookContext: UseSidebarRightTabInfo
      inject: { hooks: { tabInfo: SlotHookFactory<'sidebar.right.tab.guide', UseSidebarRightTabInfo> } }
    }
    /**
     * Extra items at the end of one tab's actions menu, in registration order.
     * Entries decide their own visibility from the tab they are given. Without a
     * registrant the menu shows only the kit's own layout actions.
     */
    'sidebar.right.tab.menu.item': { kind: 'list'; scope: 'session'; owner: SidebarRightTabMenuOwnerProps }
  }
}
```

| Key | kind | scope | owner share | hookContext | slot-level `inject` |
|---|---|---|---|---|---|
| `sidebar.right.pane.tab` | `keyed` | `session` | none declared ⇒ owner props are `object`; the owner dispatches with `{}` | `TabHookContext` | `SidebarRightTabInjected` = `{ hooks: { tabInfo } }` → component gets `useTabInfo` |
| `sidebar.right.pane.tab.title` | `keyed` | `session` | none | `TabHookContext` (with `title: true`) | same, `useTabInfo` |
| `sidebar.right.tab.guide` | `chain` | `session` | none; `GuideBody` dispatches with `{}` | `UseSidebarRightTabInfo` (the hook *itself*) | `{ hooks: { tabInfo: SlotHookFactory<…> } }` |
| `sidebar.right.tab.menu.item` | `list` | `session` | `SidebarRightTabMenuOwnerProps` = `{ tab: TabRecord; dismiss: () => void }` (`contract/slots.ts:161-173`) | — | — |

Owner props have no `owner` field for two of these keys: `OwnerOf<K>` falls back to `object`
(`ui-slots/src/index.ts:157-159`), and the seat literally passes `{}`:

```tsx
// ui-sidebar-right/src/client/shell/SidebarRight.tsx:194
return renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind, fallback, hookContext })
```

**How a tab declares its key.** Not `key: 'files/text'` — the key is the **definition's `id` string**:

```ts
{ name: 'sidebar.right.pane.tab', key: FILES_ID, locale: NS, store, inject }   // FILES_ID = '@deepseek-ai/dsh-client-ui-sidebar-files'
```

The seat computes the dispatch key from the *definition in force for the tab's kind* (`SidebarRight.tsx:184-194`):

```tsx
const definition = useTabTypes(types => types.find(definition => definition.kind === tab.kind))
…
return renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind, fallback, hookContext })
```

So: `kind` is the open discriminator (an `extension` may take a builtin's kind over), while `id` is the cell key —
which is why an extension and the builtin it shadows hold *distinct* cells and the seat renders the one in force
(`sidebar-right/README.md:77`, `tab-registry.ts:20-22`). If nothing is registered for the kind, `entryKey` degrades to
`tab.kind` and the owner's fallback renders: for bodies the "nothing can view this" paragraph
(`SidebarRight.tsx:215`), for titles the captured `tab.title` (`SidebarRight.tsx:222`). The key domain is an open
`string` (`EntryKeyOf` falls back to `string` — `ui-slots/src/index.ts:161-165`), so a tab type may ship from outside
the repo.

Keyed cells collide only at the same priority: a second entry for the same key at priority 0 throws; a lower priority
shadows (`ui-slots/src/index.ts:844-851`).

---

## 3. How `ui-sidebar-files` registers its tab (verbatim)

Quoted in full in §1.6 from `src/client/index.ts:43-58`. The three load-bearing lines:

```ts
// src/client/index.ts:45   stage one: the type
ctx.effect(() => ctx.sidebarRightTabs.register(filesDefinition(t)), 'ui-sidebar-files: files type')

// src/client/index.ts:50-53   stage two: the body, keyed by the definition id
ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab', key: FILES_ID, locale: NS, store, inject },
  FilesBody,
)), 'ui-sidebar-files: files tab body')

// src/client/index.ts:54-57   stage two (optional): the live chip title
ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab.title', key: FILES_ID },
  FilesTitle,
)), 'ui-sidebar-files: files tab title')
```

Why `ctx.slots.inject(key, () => ctx.slots.register(...))` rather than a bare `register`: a bare register into an
undeclared slot throws. `inject` waits for the actual declaration, installs the callback as a nested effect, removes
the contribution when the declaration collapses, and reruns after redeclaration — and the whole thing belongs to the
caller's fiber, so plugin unload cascades (`ui-renderer/src/client/registry.ts:157-234`,
`packages/client/AGENTS.md:141`). Use a generator callback to install several contributions transactionally.

For comparison, the owner side (ui-sidebar-right) declares the keys and installs its own shipped guide type through
the identical public path — `packages/client/ui-sidebar-right/src/client/index.ts:149-197`:

```ts
const disposeSeat = ctx.slots.inject('rightbar', function* () {
  yield ctx.slots.register({
    name: 'rightbar',
    children: { 'rightbar.session': { kind: 'single', scope: 'session' } },
  }, RightbarRoot)
  yield ctx.slots.register({
    name: 'rightbar.session',
    locale: NS,
    children: {
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: tabInfoFactory } } },
      'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: tabInfoFactory } } },
      'sidebar.right.tab.menu.item': { kind: 'list', scope: 'session' },
    },
    store,
    inject: (sessionId): SidebarRightInjected => ({
      ...injected,
      keyedHooks: { tabNavigation: key => controller.tabDomain.occurrence(sessionId, { id: key as TabId }).navigation },
      occurrence: tab => controller.tabDomain.occurrence(sessionId, tab),
    }),
  }, RightbarSeat)
})
…
const disposeGuide = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: GUIDE_ID,
  children: {
    'sidebar.right.tab.guide': {
      kind: 'chain', scope: 'session', inject: { hooks: { tabInfo: guideTabInfoFactory } },
    },
  },
  inject: () => guideInjected,
}, GuideBody))
const disposeGuideTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab.title', key: GUIDE_ID },
  GuideTitle,
))
```

Two things here are the "declaring is claiming" rule in action (`packages/client/AGENTS.md:12`,
`ui-slots/src/index.ts:149-155`): only the entry that declares a child key may render it, and the guide's body
declaration is what *creates* `sidebar.right.tab.guide` — which is why a guide replacement must also use
`ctx.slots.inject`.

**Declaration-merge ownership**: the `SlotMap` block lives in the package that *declares* the slots at runtime
(`contract/slots.ts:19-22`, "TYPE HOME RATIONALE"), and the same file merges the `sidebarRight` locale namespace. A
consumer only writes `import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'` to pick the types up
(which also drags in the module augmentation), never a value import.

---

## 4. The chip title, the tab strip, and the guide

### 4.1 The title seat

`src/client/FilesTitle.tsx:17-24` (whole component):

```tsx
export function FilesTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <FileTypeIcon kind="folder" size={16} className={css.titleIcon} />
      {tab.title}
    </>
  )
}
```

- Registering the title is **optional**: without an entry the chip shows the `title(address)` text the registry
  captured when the tab opened (`SidebarRight.tsx:222`, `contract/slots.ts:56-63`).
- `tab.title` comes from the tab record; a live title is only possible through this seat.
- The title/body share the same `useTabInfo` hook and the same `TabHookContext`; the difference is
  `title: seat === 'sidebar.right.pane.tab.title'` (`SidebarRight.tsx:187`), which drives
  `tab.visible = pane.host === 'float' || (layout.expanded && (title || pane.activeTabId === tabId))`
  (`tab-info.ts:43`) — a docked title renders while the pane is expanded even if the tab is inactive; a docked body
  renders only when it is the active tab.
- The title seat registration carries **no** `locale` and **no** `store`: it reads only the record.

### 4.2 How the chip reaches the strip

`SidebarRight.tsx:204-223` builds the two renderers the docking kit calls:

```tsx
function bodiesFor(panel: PanelProps): TabRenderer {
  const { t, ...rest } = panel
  return tab => (
    <TabSlot key={tab.id} {...rest} tab={tab} seat="sidebar.right.pane.tab"
      fallback={<p className={css.unavailable} data-sidebar-right-unavailable>{t('tab.unavailable')}</p>} />
  )
}
function titlesFor(panel: PanelProps): TabRenderer {
  return tab => <TabSlot key={tab.id} {...panel} tab={tab} seat="sidebar.right.pane.tab.title" fallback={tab.title} />
}
```

`bodiesFor` carries the `key={tab.id}` deliberately: the keyed slot keys on the *type*, so without it two tabs of one
kind would share a component instance and its local state (`SidebarRight.tsx:205-208`). They are handed to
`DockSurface` as `renderTab` / `renderTabTitle` (`SidebarRight.tsx:316-317`) and to `FloatLayer`
(`SidebarRight.tsx:339-340`). The strip's chip is
`<TabTitle>{callbacks.renderTabTitle?.(tab) ?? tab.title}</TabTitle>` in
`packages/client/ui-dockkit/src/components/TabPanel.tsx:324` (floating panel header: `FloatLayer.tsx:126`).

### 4.3 The guide slot, and "no open tabs"

Three separate mechanisms, easy to conflate:

1. **Which page a pane shows by default.** The store seeds a newly expanded/emptied pane from the *registry's guide
   entries*, not from the guide tab itself (`contract/seed.ts:26-33`):

   ```ts
   export function defaultSeed(tabs: SidebarRightTabRegistry): SidebarRightSeed {
     const [only, ...others] = tabs.guide()
     const single = only !== undefined && others.length === 0
     const kind = single ? only.kind : GUIDE_KIND
     const definition = tabs.get(kind)
     if (definition === undefined) throw new Error(`sidebarRight: default tab kind "${kind}" is not registered`)
     return { kind, title: definition.title(pageAddress(kind)) }
   }
   ```

   So with **exactly one** registered guide entry the default page is *that type* — and in the shipped composition
   that entry is `ui-sidebar-files`'s (`definition.tsx:35-40`, `order: 10`; it is the only `guide: [...]` in a
   non-test `packages/` source — verified by grep over `packages/**/*.{ts,tsx}`). With zero or multiple entries the default page is the guide. A session starts collapsed and
   empty; the expansion that would first show an empty layout is what seeds the default page
   (`sidebar-right/README.md:66`, `stores.ts:13-16`). Explicitly adding a guide still opens the guide.
2. **The guide tab's body is a chain host.** `GuideBody` renders its declared chain child with the shipped guide as
   the fallback (`tabs/guide/GuideBody.tsx:86-97`):

   ```tsx
   export function GuideBody({ useTabInfo, useGuideEntries, renderSlotChain }: GuideBodyProps): ReactNode {
     const { tab } = useTabInfo()
     const entries = useGuideEntries(entries => entries)
     const options = {
       hookContext: useTabInfo,
       fallback: (
         <ShippedGuide entries={entries}
           onPick={(entry) => { tab.actions.openTab(entry.kind, { replaceTab: true }) }} />
       ),
     } satisfies ChainRenderOpts & { hookContext: HookContextOf<'sidebar.right.tab.guide'> }
     return renderSlotChain('sidebar.right.tab.guide', {}, options)
   }
   ```

   A replacement registers `{ name: 'sidebar.right.tab.guide', select: owner => … }` (chain entries must supply a pure
   `select` — `ui-slots/src/index.ts:536-541`); the first non-null selector wins and receives its result as the
   `matched` prop; all-null falls back to the shipped guide. `useGuideEntries` is the inject `hooks` compartment bound
   to a `use<Name>` selector hook (`ui-slots/src/index.ts:437-450`) — the sanctioned way to publish a
   registrant-private reactive fact.
3. **The shipped guide's contents** are one capsule per registered guide entry, ordered by `order`; with ≤4 entries a
   capsule shows its `description`, otherwise descriptions are dropped; picking one calls
   `tab.actions.openTab(entry.kind, { replaceTab: true })` (`GuideBody.tsx:69-83`, `MAX_DESCRIBED_ENTRIES = 4`).
   The strip's add control is drawn only while a pane holds no guide and opens one there
   (`SidebarRight.tsx:157`, `:312`).

---

## 5. The store pattern

### 5.1 The shape required by `packages/client/AGENTS.md:16`

> Write the store as an exported `createXXXStore()` factory (module-level handles are forbidden — de-facto singletons);
> share by passing one handle to several registers inside `apply`. Production code never calls the factory or
> `.create()` outside `apply`; tests do.

Declaring the **factory function** (not a handle) at the register site makes it an *exclusive* store: the framework
calls it per entry × scope and mints one instance per session id
(`client/store/src/contract.ts:106-118`, `ui-renderer/src/client/registry.ts:60-67`). That is why `ui-sidebar-files`
can pass `store` into one registration and still have per-session instances, and why the store itself must be bucketed
by tab id.

### 5.2 State and write set (`src/client/store.ts`)

```ts
export interface DirLevel { readonly entries: readonly WorkspaceDirectoryEntry[]; readonly truncated: boolean }

export type LevelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly level: DirLevel }
  | { readonly kind: 'failed'; readonly failure: RemoteFailure }

export interface FilesTabState {
  /** Absolute path of the workspace root this tree is rooted at. */
  root: string
  /** Level state by absolute directory path; a path absent here was never asked for. */
  levels: Record<string, LevelState>
  /** Expanded absolute directory paths, root included. */
  expanded: string[]
}

export interface FilesState { byTab: Record<TabId, FilesTabState> }
```
(`store.ts:24-55`.)

The write set is an explicit action table, draft-first, each action naming its tab (`store.ts:70-79`):

```ts
type FilesActions = {
  start:   (draft: FilesState, tabId: TabId, root: string) => void
  loading: (draft: FilesState, tabId: TabId, path: string) => void
  loaded:  (draft: FilesState, tabId: TabId, path: string, level: DirLevel) => void
  failed:  (draft: FilesState, tabId: TabId, path: string, failure: RemoteFailure) => void
  toggled: (draft: FilesState, tabId: TabId, path: string) => void
  reset:   (draft: FilesState, tabId: TabId) => void
  forget:  (draft: FilesState, tabId: TabId) => void
}
```

and the factory (`store.ts:88-99`, closing at `:164`):

```ts
export function createFilesStore(): EngineStoreHandle<FilesState, FilesActions> {
  return defineStore({
    init: (): FilesState => ({ byTab: {} }),
    actions: {
      start: (d, tabId: TabId, root: string) => {
        d.byTab[tabId] = { root, levels: {}, expanded: [root] }
      },
      …
```

`defineStore` is the runtime engine (`@deepseek-ai/dsh-client-store`, contract at
`packages/client/store/src/contract.ts:139-144`); `EngineStoreHandle` is re-exported by `dsh-client-store`.

### 5.3 Selection / view state, and its lifetime

- **Selection state lives in the store, bucketed by `tab.id`** — `expanded: string[]` is exactly "which directories
  the reader has opened", and `levels` is what each expanded level holds. Two tabs of the same kind in one session
  expand independently (`store.ts:1-11`).
- All writers run **between `start` and `forget`**: the owner tab record's `signal` ends a bucket's life
  (`store.ts:10-11`); `bucket()` throws for an unknown tab so a mis-ordered write is loud (`store.ts:64-68`).
  The face adds the abort listener that calls `actions.forget(tabId)` (`face.ts:136-139`).
- Component reads: `const state = useStore(store => store.byTab[tab.id])` (`FilesBody.tsx:176`); component writes:
  `actions.reset(tab.id)` / `toggle(...)` / `load(...)` (`FilesBody.tsx:197-207`). No `useSyncExternalStore`, no manual
  subscribe anywhere in the component (`packages/client/AGENTS.md:24`).
- The authoritative rule that business data is *not* store data (`packages/client/AGENTS.md:52`): "Entry-declared
  stores carry shared viewing/interaction state (selection, drafts, panel widths)". `ui-sidebar-files`' store holds
  only view state; the listing itself arrives from the Remote on demand and is never persisted.

### 5.4 Passing the store to the inject factory

`filesFace` is called with the **baked actions** the framework passes to the inject factory, typed
`BoundActions<ReturnType<typeof createFilesStore>>` (`face.ts:105-107`) — the same callbacks the component sees via
`props.actions` (`ui-slots/src/index.ts:491-506`). That is how an async face writes store state without ever touching
the instance (`face.ts:121-131`).

---

## 6. Locale / i18n

### 6.1 `src/client/locales.ts` — dictionary + declaration merge (verbatim)

```ts
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-tree type name, guide entry, row states, and failure lines. */
    sidebarFiles: SidebarFilesKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': '文件',
  'guide.title': '工作区文件',
  'guide.description': '浏览会话工作区的文件',
  loading: '正在读取…',
  empty: '空目录',
  truncated: '条目太多，只显示了一部分。',
  noWorkspace: '这个会话没有工作区目录。',
  reload: '重新读取',
  'entry.other': '这不是文件或目录，没法打开。',
  'error.notFound': '这个目录不在了。可能已被移动或删除。',
  'error.outsideWorkspace': '这个目录在工作区之外，侧栏不会读取它。',
  'error.notDirectory': '这不是一个目录。',
  'error.unavailable': '读取失败：{message}',
} satisfies Record<string, string>

/** Files dictionary key union. */
export type SidebarFilesKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Files',
  …
} satisfies Record<SidebarFilesKey, string>
```
(`locales.ts:12-56`; `en` mirrors every key.)

Rules embodied here:
- `zh` is the **key-set source of truth**; `SidebarFilesKey = keyof typeof zh`; `en` is
  `satisfies Record<SidebarFilesKey, string>`, so a missing/extra English key is a compile error.
- The `LocaleNamespaceMap` merge lives with its key set so any module naming `TranslateNS<'sidebarFiles'>` or
  `PropsLocale<'sidebarFiles'>` needs only this file (`locales.ts:8-10`).
- `{message}` is the translate template-param convention (`Translate<K> = (key, params?) => string`,
  `ui-slots/src/index.ts:51-52`).

### 6.2 The `t` seats

Three routes, all typed to the same key union:
1. **Registry thunks**: `const t = ctx.locale.bind(NS)` then `filesDefinition(t)` keeps `t` inside
   `title`/`guide[].title`/`guide[].description` thunks so a language change needs no re-registration
   (`index.ts:44-45`, `definition.tsx:34-40`).
2. **Component seat**: declaring `locale: NS` in the register options synthesizes `PropsLocale<'sidebarFiles'>` =
   `{ t: TranslateNS<'sidebarFiles'> }` on the component (`ui-slots/src/index.ts:86-94`); rendering without an installed
   locale face fails loud (`ui-slots/src/index.ts:580-586`). `FilesBody` receives it as `t` (`FilesBody.tsx:171`,
   used e.g. `:150`, `:190`, `:222`).
3. **Pure helpers take `t` as a parameter** rather than closing over ctx: `failureLine(t, failure)`
   (`FilesBody.tsx:59-68`).

Registration is `ctx.locale.register(NS, { zh, en })` inside an effect (`index.ts:46`). The service's typed overload
requires **every shipped locale in one call**, checked against `LocaleNamespaceMap`; duplicate `(ns, locale)` throws,
and registration bumps the revision so mounted outlets pick up late dictionaries
(`packages/client/locale/src/client/index.ts:358-370`).

### 6.3 What `pnpm run verify-client-ui-i18n` demands

`scripts/verify-client-ui-i18n.ts` (`package.json:134`). It is a **source-ownership** gate: "Locale dictionaries are
the only source files allowed to own translated text" (`:1-8`).

- Discovery (`:319-337`): `packages/client/*/src/**/*.tsx`, `packages/client/ui-*/src/**/*.{ts,tsx}`, every
  `src/client/**` tree containing a `.tsx`, `apps/web/src/**`, desktop mains; `.d.ts` excluded. It refuses to pass on a
  narrowed discovery (`MINIMUM_CLIENT_UI_SOURCES = 450`, `:15`, `:341-345`).
- Exempt files (`:69-75`): a basename of `locale.ts` / `locales.ts`, or any path containing `/locales/`.
- Violations (`findUiI18nViolations`, `:110-305`): JSX text nodes; copy-bearing JSX attributes — the fixed set
  `alt, aria-description, aria-label, aria-valuetext, cancelLabel, closeLabel, confirmLabel, copyLabel, description,
  emptyLabel, label, placeholder, title, truncatedLabel` plus any attribute matching
  `/(?:Aria|Copy|Description|Heading|Label|Message|Placeholder|Summary|Text|Title|Tooltip)$/` (`:17-33`);
  JSX child expressions; copy-named properties / variables / destructuring defaults / returns in `.tsx`
  (`:257-299`); string returns from functions with an explicit `: string` type in `.tsx` (`:296-298`).
- A literal is exempt when it is whitespace-only, in the immutable-token list (`B`, `KB`, `function()`, `true`, …), or
  matches `LOCALE_KEY = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)+$/` (`:37-53`, `:77-83`) — which is why dictionary
  *keys* like `'type.label'` are allowed anywhere but the *text* is not.

Practical consequence for a new tab plugin: put every user-visible string in `locales.ts` with **both** `zh` and `en`,
put the key union in the same file, and reach text only through `t` or an already-localized prop
(`packages/client/AGENTS.md:113`).

Related gates: `README.i18n.yaml` blob-hash pairing (`pnpm run verify-translation-pairing`) for the bilingual README
pair; `scripts/verify-package-invariants.ts` for the published-invariant sentence.

---

## 7. Build: `tsdown.config.ts`, the node half, and CSS Modules

### 7.1 `clientBundle(id, libEntry)`

`packages/client/tsdown.client.ts:107-124`:

```ts
export function clientBundle(id: string, libEntry: readonly string[], options: ClientBundleOptions = {}): BuildFaceConfig {
  const lib = clientLibraryConfig(id, libEntry, options.lib)
  return ({ env }) => {
    const face = buildFace(env?.DSH_BUILD_FACE)
    const clientEntry = face === undefined ? 'src/client/index.ts' : 'lib/types/client/index.js'
    const client = clientConfig(id, clientEntry)
    const node = [lib, ...(options.companions ?? [])]
    if (face === 'host') return options.hostPhase === true ? node : [SKIP_WORKSPACE_BUILD]
    if (face === 'client') return options.hostPhase === true ? [client] : [...node, client]
    return [...node, client]
  }
}
```

Consequences for a tab plugin:
- A package-level `tsdown.config.ts` **replaces** the root workspace layout, so the preset must restate the node half —
  that is exactly what `libEntry = ['lib/types/index.js']` does (`tsdown.client.ts:90-98`). Dropping it leaves no
  `lib/index.js` and the host Loader cannot import the node half.
- Node half (`clientLibraryConfig`, `:216-244`): `format: ['esm']`, `platform: 'node'`, `target: 'es2024'`, `dts:
  false`, `clean: false`, out `lib/`; production deps stay imports, everything else inlines.
- Browser half (`clientConfig`, `:428-571`): entry `{ client: … }`, `outDir: 'lib'`, `format: 'cjs'`,
  `platform: 'browser'`, `entryFileNames: 'client.js'` ⇒ **`lib/client.js`**, sourcemaps + `sourcemapPathTransform`
  back into `/packages/...` URLs, and the module-loader wrapper:
  ```ts
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
  footer: 'return module.exports; } });',
  intro: 'var module = { exports: {} }; var exports = module.exports;',
  ```
  (`:566-568`.) Lazy CJS: executing the artifact only *registers* the factory; module bodies (including CSS injection)
  run on materialization (`packages/client/modules/src/client/manifest.ts:9-16`).
- **Purity gate** (`:482-500`): every `@deepseek-ai/*` value import must be either a requested module-table row
  (`PLATFORM_MODULES` baseline + `dsh.client.external`), a vendored library, an inline-safe wire layer, or a generated
  `/remote` contribution — otherwise the build fails with "cross-plugin value imports are forbidden". React, Cordis,
  `client/store`, `ui-primitives`, `ui-slots`, `ui-dockkit` are baseline externals and must **not** be re-declared
  (`packages/client/AGENTS.md:75-77`).
- The client build consumes `lib/types` (tsc output) and chains tsc's source maps into the bundle
  (`tscSourceMapPlugin`, `:573-603`).

### 7.2 `src/index.ts` — the node-half empty apply

```ts
/** Pure host half; the whole tab type lives in the browser export. */

/** Host plugin body: the file tree contributes nothing to the host tree. */
export function apply(): void {}
```
(`src/index.ts:1-4`.) Same in `ui-sidebar-right` (`src/index.ts:1-4`). This keeps the package importable in the host
plugin tree (and in the Cordis catalog) while every behaviour lives behind `./client`.

### 7.3 `src/css-modules.d.ts`

(`src/css-modules.d.ts:1-6`, quoted in §1.5.) `declare module '*.module.css'` gives `tsc` a `Record<string,string>`
default export; the real class map is produced at bundle time by the preset's `dsh-css-modules-inline` plugin, which
compiles with lightningcss `cssModules: { pattern: '[hash]_[local]' }`, emits a virtual module that injects a
`<style data-plugin-css="<id>/<file>">` tag on first execution and default-exports the hashed class map
(`tsdown.client.ts:501-525`, `styleInjectionModule` `:33-53`). `x.css?inline` yields compiled text for a
plugin-owned lifecycle effect (`:526-541`), and a plain `.css` is injected globally (`:542-556`).

---

## 8. Beyond the package: what else a new tab plugin must touch

From `packages/client/AGENTS.md:134-143` ("New plugin package checklist"), verified against this package:

1. **`packages/client/tsconfig.client.json`** — add `{ "path": "./packages/client/<name>" }` to the aggregate
   `references` (`tsconfig.client.json:88` is `ui-sidebar-right`, `:90` is `ui-sidebar-files`).
2. **`packages/bundle/web-app/cordis.patch.yml`** — add the plugin row that actually mounts it:
   ```yaml
   # The right Sidebar's workspace file tree tab type.
   - id: ui-sidebar-files
     name: '@deepseek-ai/dsh-client-ui-sidebar-files'
   ```
   (`packages/bundle/web-app/cordis.patch.yml:234-235`.)
3. **`packages/bundle/web-app/package.json`** — declare the dependency
   (`"@deepseek-ai/dsh-client-ui-sidebar-files": "workspace:^"`, `package.json:85`), because profile boots resolve bare
   row names through the healed `$DSH_HOME/profiles/node_modules` fallback; a row whose package no manifest declares
   fails to import.
4. **`pnpm-workspace.yaml`** already globs `packages/*/*`.
5. Rebuild the artifact before probing a live server — the registry serves `lib/client.js`, not sources:
   `pnpm --filter @deepseek-ai/dsh-client-ui-sidebar-files bundle` (`packages/client/AGENTS.md:142`).

Tests worth mirroring (package-local, importing internals relatively — `packages/client/AGENTS.md:35`):
`tests/apply.client.spec.ts` (recorder faces + real `SidebarRightTabRegistry`, asserts the two seats' `name`/`key`/
`locale`/`store`/`inject` and full teardown), `tests/definition.client.spec.ts` (registry semantics of the
definition), `tests/store.client.spec.ts` (write set), `tests/*.client.spec.tsx` with a `// @vitest-environment jsdom`
first line and a hand-built props harness (`tests/mount.client.tsx`, `tests/scripted-list.client.ts`).

---

## 9. Gotchas a template must carry

1. **Key the seats by `id`, not `kind`.** `id` is the implementation identity and the cell key; `kind` is the open
   discriminator that an `extension` may take over. A second registration of the same `id` throws
   (`tab-registry.ts:245`).
2. **`ctx.slots.inject` is mandatory** for registering into another package's slot; a bare `register` into an
   undeclared slot throws (`ui-slots/src/index.ts:827-830`). It also gives free collapse/redeclare handling and fiber
   teardown.
3. **Both stages go inside `ctx.effect`** so the registration lives exactly as long as the plugin
   (`sidebar-right/README.md:75`).
4. **Don't declare `dsh.client.external` for another feature plugin** — the purity gate rejects it; cross-package
   behaviour goes through Cordis services and UI through slots (`packages/client/AGENTS.md:36`, `:78`).
5. **Every cross-package import in the client half must be `import type`** (with `import type {} from '…/client'` to
   pull in declaration merges). `ui-sidebar-files`' only runtime imports are its own files plus baseline externals
   (`index.ts:13-23`).
6. **One store handle, one scope** (`ui-slots/src/index.ts:872-882`): pass the *factory* for per-session instances,
   pass one *handle* only to several same-scope registrations. Never export a module-level handle.
7. **Component-local state vs store**: only shared/surviving viewing state goes in the store; a component that only
   needs to remember its own scroll or input uses local state (`packages/client/AGENTS.md:15`, `:150`).
8. **Store writers are bracketed by the record's `signal`** — `start` … `forget`. A writer that outlives the record
   must be guarded by generation/abort checks (`face.ts:112-132`).
9. **The guide entry is what makes your page the default page** in a composition with exactly one entry
   (`contract/seed.ts:26-33`). Declaring `guide: [...]` is opt-in and changes the shell's landing behaviour.
10. **Ship `README.md` + `README.zh.md` + `README.i18n.yaml`**; the README needs the Model Experience section and either
    an invariant companion or the "No companion is published" sentence.

---

## 10. Copy-paste skeleton for a new tab type `foo`

```
packages/client/ui-sidebar-foo/
├── package.json         @deepseek-ai/dsh-client-ui-sidebar-foo, main lib/index.js,
│                        exports {./client}, dsh.client { platform: 'web',
│                        inject: ['@deepseek-ai/dsh-client-ui-sidebar-right', …] }, files[3], scripts bundle/watch
├── tsconfig.json        extends ../../../tsconfig.base.client.json, rootDir src, outDir lib/types, references[…]
├── tsdown.config.ts     export default clientBundle('@deepseek-ai/dsh-client-ui-sidebar-foo', ['lib/types/index.js'])
├── README.md/.zh.md/.i18n.yaml
├── src/index.ts         /** Pure host half … */ export function apply(): void {}
├── src/css-modules.d.ts (when using CSS Modules)
├── src/client/
│   ├── index.ts         NS, export const inject = ['slots','locale','sidebarRightTabs', …], apply(ctx)
│   ├── definition.tsx   export const FOO_KIND / FOO_ID; fooDefinition(t): SidebarRightTabDefinition
│   ├── store.ts         createFooStore(): EngineStoreHandle<FooState, FooActions>
│   ├── face.ts          (optional) async work + fooFace(...) : InjectParams-shaped factory
│   ├── FooBody.tsx      PropsRuntime<'sidebar.right.pane.tab'> & PropsStore<…> & FooInjected & PropsLocale<'foo'>
│   ├── FooTitle.tsx     PropsRuntime<'sidebar.right.pane.tab.title'>
│   ├── locales.ts       declare module LocaleNamespaceMap { foo: FooKey }; zh / FooKey = keyof typeof zh / en
│   └── FooBody.module.css
└── tests/               *.client.spec.ts(x) + mount harness
```

`apply` body: `const t = ctx.locale.bind(NS)` → `ctx.effect(() => ctx.sidebarRightTabs.register(fooDefinition(t)), …)`
→ `ctx.effect(() => ctx.locale.register(NS, { zh, en }), …)` → `const store = createFooStore()` →
`ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab',
key: FOO_ID, locale: NS, store, inject }, FooBody)), …)` →
`ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name:
'sidebar.right.pane.tab.title', key: FOO_ID }, FooTitle)), …)`.

### Verbatim anchor index

| What | Where |
|---|---|
| `SlotMap` declaration-merge block (4 keys) | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:40-87` |
| Locale merge for the sidebar | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:34-38` |
| `TabHookContext` (hookContext shape) | `packages/client/ui-sidebar-right/src/client/tab-info.ts:9-18` |
| `SidebarRightTabInjected` / `SidebarRightTabMenuOwnerProps` / `SidebarRightTabActions` | `contract/slots.ts:114-173` |
| Owner declares the two keyed seats | `packages/client/ui-sidebar-right/src/client/index.ts:149-169` |
| Owner registers the shipped guide through the same path | `packages/client/ui-sidebar-right/src/client/index.ts:184-197` |
| Seat dispatch (`entryKey`, fallback) | `packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx:180-223` |
| `useTabInfo` implementation | `packages/client/ui-sidebar-right/src/client/tab-info.ts:26-51` |
| Default page seed | `packages/client/ui-sidebar-right/src/client/contract/seed.ts:26-47` |
| Guide chain host | `packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx:86-97` |
| Template `apply` | `packages/client/ui-sidebar-files/src/client/index.ts:43-58` |
| Template definition | `packages/client/ui-sidebar-files/src/client/definition.tsx:13-41` |
| Template store | `packages/client/ui-sidebar-files/src/client/store.ts:88-164` |
| Template locale file | `packages/client/ui-sidebar-files/src/client/locales.ts:12-56` |
| `PropsStore`/`StoreFactory` contracts | `packages/client/store/src/contract.ts:106-144` |
| `PropsRuntime`/`PropsLocale`/`InjectParams`/`ComposedProps` | `packages/client/ui-slots/src/index.ts:86-94, 222-232, 464-506` |
| `ctx.slots.inject` semantics | `packages/client/ui-renderer/src/client/registry.ts:157-234` |
| tsdown preset | `packages/client/tsdown.client.ts:107-124, 428-571` |
| i18n gate | `scripts/verify-client-ui-i18n.ts:1-359` |
| New-package checklist | `packages/client/AGENTS.md:134-143` |
