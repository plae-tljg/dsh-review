# How to add a new Remote namespace (client ⇄ host RPC) to the DSH Web GUI

Read-only investigation of `/home/fit/00lib/deepseek-harness` (nothing modified). Every claim below is cited to a file path and line number.

---

## 0. TL;DR — the 9 surfaces a new namespace touches

A "Remote namespace" is **not** registered by hand on either side. A namespace is *derived* from a Host Cordis **service key** plus `@Remote` decorators on its methods, materialised as build artifacts by the Typert generator, auto-registered on the Host by the Typert loader, and **explicitly selected + mounted** on the Client by the `@deepseek-ai/dsh-api-remotes` client assembly.

| # | Surface | File | Example line |
|---|---|---|---|
| 1 | Host class extends `TypertRemoteService`, methods marked `@Remote` / `@RemoteScope` | `packages/api/workspace-files/src/index.ts` | `182`, `231` |
| 2 | Client-safe wire types + `RemoteErrorDetailsMap` merge in a separate `/types` module | `packages/api/workspace-files/src/types.ts` | `19`, `145-165` |
| 3 | `package.json` `exports` gains `./typert` (+ `./remote` when Remote methods exist) and `files` lists the generated artifacts | `packages/api/workspace-files/package.json` | `29-38`, `74-83` |
| 4 | Split TypeScript faces (`tsconfig.host.json` + `tsconfig.client.json`) for a dual-face package | `packages/api/workspace-files/tsconfig.host.json`, `.../tsconfig.client.json` | — |
| 5 | Registered in the root aggregates `tsconfig.host.json` / `tsconfig.client.json` | `/tsconfig.host.json`, `/tsconfig.client.json` | `174`, `115` |
| 6 | One Loader row in the Web bundle patch (serves host half **and** is the browser roster row) | `packages/bundle/web-app/cordis.patch.yml` | `110-111` |
| 7 | Package declared as a dependency of the Web bundle | `packages/bundle/web-app/package.json` | `47` |
| 8 | **Client assembly mount**: value-import `<pkg>/remote` + `ctx.remote.$mount(...)` + `export type {} from '<pkg>/remote'` | `packages/api/remotes/src/client/index.ts` | `18`, `39`, `158` |
| 9 | Consumer declares `inject: ['remote', 'remote.<namespace>']` and calls `ctx.remote.<ns>.<method>()` | `packages/client/ui-sidebar-files/src/client/index.ts` | `37`, `49` |

Nothing else. In particular there is **no** hand-written namespace table, no `useRemote` hook, and no client-side registry file to edit beyond the `api-remotes` assembly.

---

## 1. The mechanism

### 1.1 The package: `packages/api/remotes`

The real directory is exactly `packages/api/remotes` (npm name `@deepseek-ai/dsh-api-remotes`, `packages/api/remotes/package.json:2`). Its README calls it a *"Two-sided BFF for Host Remote capabilities selected by this application"* (`packages/api/remotes/README.md:11`):

> "The Host entry owns the forwarded-event selection and registers its application event source with API Gateway; the Client entry imports generated `/remote` artifacts as runtime values, mounts each contribution through `ctx.remote.$mount()`, and re-exports their declaration merges."

The **client** half is the mount point — `packages/api/remotes/src/client/index.ts:150-168`:

```ts
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [
      agentPresetsRemote, commandsRemote, settingsControllerRemote, goalsRemote, llmRemote, dynamicRemote,
      pluginInventoryRemote, messageFeedbackRemote, sessionFeedbackRemote, fileUploadsRemote, sessionReferencesRemote,
      subagentsRemote, sessionRemote, workspaceRemote, workspaceFilesRemote,
    ]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
```

with the value import at line 18 and the declaration-merge re-export at line 39:

```ts
import workspaceFilesRemote from '@deepseek-ai/dsh-api-workspace-files/remote'   // :18
export type {} from '@deepseek-ai/dsh-api-workspace-files/remote'                // :39
export type * from '@deepseek-ai/dsh-api-workspace-files/types'                  // :40 (payload vocabulary)
```

The `remote` service itself is declared as a Cordis Context member at `packages/api/remotes/src/client/index.ts:135-143`:

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: ClientRemote
  }
}
export const inject = ['remote']
```

Note the host half (`packages/api/remotes/src/index.ts:35-43`) only registers *forwarded Cordis events* (`ctx.typertGateway.registerRemoteEvents(...)`); it does **not** enumerate namespaces. Namespace selection is a Client-assembly concern.

### 1.2 The declaration API — `packages/typert/protocol`

`@deepseek-ai/dsh-typert-protocol` is a declarations-only package (`packages/typert/protocol/README.md:12`). Its public surface:

**Binding a service to a wire namespace** — `packages/typert/protocol/src/index.ts:153-167`:

```ts
export abstract class TypertRemoteService<out T = never> extends Service<T> {
  /** Visible binding consumed by the Gateway's source-mode discovery. */
  readonly typertRemote: TypertGatewayBinding<this>

  protected constructor(ctx: Context, serviceKey: string, options: TypertGatewayBindingOptions = {}) {
    super(ctx, serviceKey)
    this.typertRemote = bindTypertRemote(this, this.name, options)
  }
}
```

`bindTypertRemote(service, serviceKey, { namespace? })` (same file, `141-150`) is the escape hatch for a class that cannot extend `TypertRemoteService`:

```ts
export function bindTypertRemote<Service extends object>(
  service: Service, serviceKey: string, options: TypertGatewayBindingOptions = {},
): TypertGatewayBinding<Service> {
  validateName('service key', serviceKey)
  const namespace = options.namespace ?? serviceKey   // namespace defaults to the Cordis service key
  validateName('namespace', namespace)
  return Object.freeze({ service, serviceKey, namespace })
}
```

**Marking methods** — `Remote` (three overloads, `packages/typert/protocol/src/index.ts:174-201`):

- `@Remote` — plain decorator, endpoint name = method name;
- `@Remote('exportName')` — different wire method name (`packages/typert/protocol/src/index.ts:188-191`);
- `@Remote({ mode: 'stream' })` — many result items over the logical stream carrier (`:192-198`).

`@RemoteScope(key, exportName?)` (`:226-233`) marks a method resolved from a **scoped** Context instead of the root service.

Markers are recorded as a *versioned prototype descriptor* by a class initializer (`:265-312`), so a Host started from source without the Typert build can still discover them via `remoteMethods(service)` (`:241-245`) — the "SRC fallback" documented at `docs/api-gateway.md:131-137`.

**Wire-name grammar** — `packages/typert/protocol/src/index.ts:13-22`: every namespace, method, lookup and Context segment must match `/^[A-Za-z0-9_$.-]+$/` and must not be `.`/`..`.

**The typed Client face** — `packages/typert/protocol/src/types.ts:306-324`:

```ts
export interface TypertClientRemote extends TypertRemoteNamespaceMap {
  $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>
  $on<Event extends TypertRemoteEvent>(event: Event, listener: TypertClientEventListener<Event>): () => void
}
```

`TypertClientRemote` is *merge-extensible*: the generated `/remote` `.d.ts` merges each namespace into `TypertRemoteNamespaceMap` (`TypertRemoteNamespaceMap {}` declared at `:204`; resolution helper `TypertRemoteNamespace<Namespace>` at `:172-176`).

### 1.3 How the client gets a typed handle

There is no hook and no `useRemote` (verified: zero `useRemote` hits under `packages/client/*/src`). The handle is an ordinary Cordis service property:

1. The Gateway client installs one child Cordis service per namespace, keyed `remote.<namespace>` — `packages/api/gateway/src/client/index.ts:659-661`:

```ts
function remoteServiceKey(namespace: string): string {
  return `remote.${namespace}`
}
```

   created in `createNamespace()` (`:346-378`) and its methods installed as own accessor properties (`RemoteNamespaceService.install`, `:576-599`);
2. The plugin that calls it declares both `remote` and `remote.<namespace>` in its `inject`, e.g. `packages/client/ui-sidebar-files/src/client/index.ts:37`:

```ts
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']
```

3. Types come from the declaration merge carried by `import type {} from '@deepseek-ai/dsh-api-remotes/client'` (re-exported by `packages/api/remotes/src/client/index.ts:39`). The call site is a plain method call.

Unary calls return `RemoteResult<T>` — they **never reject** on business failure (`docs/cookbook/adding-a-remote-api.md:109`). A mounted namespace service can also emit a `RemoteResult` failure for carrier/withdrawn reasons (`packages/api/gateway/src/client/index.ts:429-455`, `727-744`).

---

## 2. The complete minimal real pair

### 2.1 HOST half — `@deepseek-ai/dsh-api-workspace-files` (namespace `workspaceFiles`)

**`packages/api/workspace-files/src/index.ts`** — the entire namespace declaration is: a Context augmentation, a lookup-map augmentation, a class extending `TypertRemoteService`, and 7 `@Remote` methods.

Imports and bindings (`:22-42`):

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, TypertRemoteService, type TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceChangeFeed } from './changes.ts'
import type { /* wire payloads */ } from './types.ts'
```

Service key = namespace = `workspaceFiles` (`:46-51`, `:182-199`):

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `workspaceFiles` Remote namespace. */
    workspaceFiles: WorkspaceFiles
  }
}

export class WorkspaceFiles extends TypertRemoteService {
  static inject = ['fs', 'sandboxPolicy', 'sessions', 'typert']

  static Config: z<Config> = z.object({ /* maxBytes, maxFileBytes, maxLines, maxEntries */ })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'workspaceFiles')          // service key → wire namespace
    this.feed = new WorkspaceChangeFeed(ctx)
    ctx.inject(['sessions', 'typert'], (scope) => {
      scope.typert.lookups.register('workspaceFileScope', { /* ... */ })   // :202
    })
  }
```

The lookup that lets a *complex Host object* cross the wire as an id (`:61-66` declares it, `:201-220` registers the resolver):

```ts
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    /** Resolve a Session id to its workspace root without loading its event body or activating an Agent. */
    workspaceFileScope: TypertLookup<WorkspaceFileScope, SessionId>
  }
}
```

Methods (unary, cancellation-by-final-`AbortSignal`, work is delegated to `ctx.fs`):

```ts
  @Remote                                                              // :323-327
  async stat(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileStat> {
    const { target, info } = await this.locateFile(workspaceFileScope, path, signal)
    return this.statOf(target, info)
  }

  @Remote({ mode: 'stream' })                                          // :364-367
  changes(workspaceFileScope: WorkspaceFileScope, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> {
    return this.feed.follow(workspaceFileScope.workspaceRoot, signal)
  }
```

Failures are one class + a merged code table (`packages/api/workspace-files/src/types.ts:145-165`):

```ts
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'workspace-file/not-found': { readonly path: string }
    'workspace-file/outside-workspace': { readonly path: string }
    'workspace-file/too-large': { readonly path: string; readonly limit: number }
    /* … */
  }
}
```

thrown at the failure point, e.g. `packages/api/workspace-files/src/index.ts:100`:

```ts
throw new RemoteError('gateway/bad-request', `${name} must be a safe integer of at least ${min}`, {})
```

**`package.json`** (`packages/api/workspace-files/package.json`) — the generated-artifact contract:

```jsonc
"exports": {
  ".":        { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
  "./types":  { "types": "./lib/types/types.d.ts",        "default": "./lib/types/types.js" },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
  "./typert": { "types": "./lib/typert.host.d.ts",          "default": "./lib/typert.host.js" },
  "./remote": { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" },
  "./src/*": "./src/*",
  "./package.json": "./package.json"
},                                                                    // :16-39
"dsh": { "client": { "inject": [ "@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-client-resources" ], "platform": "web" } },   // :40-48
"dependencies":    { "@deepseek-ai/dsh-typert-protocol": "workspace:^", ... },   // :56  (VALUE import)
"devDependencies": { "@deepseek-ai/dsh-api-gateway": "…", "@deepseek-ai/dsh-fs": "…", "@deepseek-ai/dsh-sandbox-policy": "…", ... }, // :63-73 (type-only)
"files": [ "lib/index.js", "lib/client.js", "lib/types/**/*.js", "lib/types/**/*.d.ts",
           "lib/typert.host.js", "lib/typert.host.d.ts",
           "lib/typert.remote-client.js", "lib/typert.remote-client.d.ts" ]        // :74-83
```

**`tsdown.config.ts`** (`packages/api/workspace-files/tsdown.config.ts:1-7`) — `hostPhase: true` because the two halves must compile in different faces:

```ts
import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-api-workspace-files',
  ['lib/types/index.js'],
  { hostPhase: true },
)
```

(`hostPhase` semantics: `packages/client/tsdown.client.ts:118-123` — host phase emits only the Node entry, client phase emits only the browser bundle.)

### 2.2 CLIENT half of the same package — the browser consumer

`packages/api/workspace-files/src/client/index.ts:8-34`:

```ts
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import { ChangeFeed } from './change-feed.ts'
import { createFileResourceProvider } from './provider.ts'

/** Required browser services: the resource model, the Remote carrier and its namespace. */
export const inject = ['resources', 'remote', 'remote.workspaceFiles']

export function apply(ctx: ClientContext): void {
  const changes = new ChangeFeed(ctx.remote)
  const provider = createFileResourceProvider(ctx.remote, changes)
  ctx.effect(() => {
    const release = ctx.resources.register(provider)
    return async () => { release(); await changes.settle() }
  }, 'workspace-files: file resource provider')
}
```

The wire payloads are referenced **through the generated merge**, never re-declared (`packages/api/workspace-files/src/client/remote.ts:6-8`, `:38`, `:41-50`):

```ts
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
// Merges the generated `workspaceFiles` namespace into the Remote face.
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'

/** The `workspaceFiles` namespace methods this package calls, as the generated Remote declares them. */
export type WorkspaceFilesNamespace = Pick<ClientRemote['workspaceFiles'], 'stat' | 'changes'>
```

### 2.3 The separate UI consumer — `@deepseek-ai/dsh-client-ui-sidebar-files`

`packages/client/ui-sidebar-files/src/index.ts:1-4` is the pure host half of a browser plugin:

```ts
/** Pure host half; the whole tab type lives in the browser export. */

/** Host plugin body: the file tree contributes nothing to the host tree. */
export function apply(): void {}
```

`packages/client/ui-sidebar-files/src/client/index.ts:13-58` — type-only merge import, `inject`, and the call wiring:

```ts
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'     // carries the generated declaration merge
/* … slots / sidebar imports … */
import { createList, filesFace } from './face.ts'

export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']

export function apply(ctx: ClientContext): void {
  /* … */
  const store = createFilesStore()
  const inject = filesFace(createList(ctx.remote))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: FILES_ID, locale: NS, store, inject },
    FilesBody,
  )), 'ui-sidebar-files: files tab body')
```

The actual RPC call site — `packages/client/ui-sidebar-files/src/client/face.ts:21`, `:44-46`, `:53-59`:

```ts
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'

export type WorkspaceFilesListRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list'>
}

export function createList(remote: WorkspaceFilesListRemote): ListWorkspaceDirectory {
  return async (sessionId, path, signal) => {
    const result = await remote.workspaceFiles.list(sessionId, path, signal)
    if (!result.ok) return result
    return { ok: true, value: { entries: result.value.entries, truncated: result.value.truncated } }
  }
}
```

Note the lookup parameter is **injected as the first wire argument**: the Host signature is `list(workspaceFileScope: WorkspaceFileScope, path, signal)` but the generated client signature is `list(workspaceFileScopeId: SessionId, path, signal?)` — see the generated declaration in §3.3.

That is the whole pair. A new namespace = copy this shape.

---

## 3. Exact code-level detail

### 3.1 Typert decorator/annotation style

- Standard **TC39 method decorators**, not legacy/experimental ones; the generator lowers them before bundling (`packages/typert/generator/README.md:52`, root wiring `tsdown.config.ts:30`: `typertPlugin({ mode: 'workspace', faces: ['host'] })` with the client pass having `plugins: []`).
- Annotations carry *only* a method name + invocation kind + optional export name/stream mode (`packages/typert/protocol/src/index.ts:88-97` — `RemoteMethodMarker`). Full parameter/result/lookup reflection is the **build pipeline's** job (`packages/typert/protocol/README.md:82`, `:138`).
- Restrictions (`docs/api-gateway.md:117`): public, non-static instance method with a concrete implementation; no generics; parameters must be required, named simple identifiers — no destructuring, defaults, rest, or optional parameters.
- Cooperative cancellation = **final** parameter `signal: AbortSignal`, injected not sent (`docs/api-gateway.md:56`; validation `packages/typert/loader/src/index.ts:229-234`).
- Complex Host objects need a `TypertLookupMap` declaration + a runtime resolver registered with `ctx.typert.lookups.register(key, provider)` (`packages/typert/protocol/src/types.ts:336-351`, `:460-473`).

### 3.2 How types flow (build-time catalog, not decorators)

The generator (`@deepseek-ai/dsh-typert-generator`) statically analyses the Host `ts.Program` seeded from `tsconfig.host.json` and emits four files per contributing package (`docs/api-gateway.md:103-113`):

| File | Consumer | Contents |
|---|---|---|
| `typert.host.js` | Host Loader | runtime reflection, strict invocation descriptors, schema registration values |
| `typert.host.d.ts` | Host type system | Host-face declarations |
| `typert.remote-client.js` | `api-remotes` | mountable `TypertRemoteContribution` (strict descriptors + codecs) |
| `typert.remote-client.d.ts` | Client type system | `TypertRemoteNamespaceMap` / `TypertRemoteScopeMap` merges |

Build order is mandatory (`docs/api-gateway.md:97`): `build:lib:host` (`tsc -b tsconfig.host.json` then `tsdown --env.DSH_BUILD_FACE host`) **then** `build:lib:client`. Rerun `pnpm run build:lib` after any signature/code-table/namespace/export-name change (`docs/cookbook/adding-a-remote-api.md:105`, `:194`).

Publication is validated at build time — `packages/typert/generator/src/workspace.ts:96-147`:

```ts
const subpath = artifact.face === 'host' ? './typert' : './client/typert'
const expected = { types: `./lib/typert.${artifact.face}.d.ts`, default: `./lib/typert.${artifact.face}.js` }
/* … */
if (artifact.remote === undefined) {
  if (remoteActual !== undefined || remoteFiles.some(file => files.includes(file))) {
    throw new TypertAnalysisError(`typert(host): ${artifact.package} publishes Remote artifacts but has no Remote methods`)
  }
  return
}
if (!sameExport(remoteActual, remoteExpected)) {
  throw new TypertAnalysisError(`typert(host): ${artifact.package} must export ./remote as ${JSON.stringify(remoteExpected)}`)
}
```

### 3.3 What the generated artifacts actually contain (real, built output)

`packages/api/workspace-files/lib/typert.remote-client.d.ts` (generated header + merge):

```ts
/* Generated by @deepseek-ai/dsh-typert-generator from the Host FaceModel — do not edit. */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$776f726b737061636546696c6573 {
    changes: (workspaceFileScopeId: SessionId, signal?: AbortSignal) => AsyncIterable<WorkspaceFileWatchFrame>
    list: (workspaceFileScopeId: SessionId, path: string, signal?: AbortSignal) => Promise<RemoteResult<WorkspaceDirectoryListing>>
    read: (workspaceFileScopeId: SessionId, path: string, range: WorkspaceFileRange, signal?: AbortSignal) => Promise<RemoteResult<WorkspaceFileText>>
    /* readAll, readBytes, readRelated, stat … */
  }
  interface TypertRemoteMap {
    'workspaceFiles/list': (workspaceFileScopeId: SessionId, path: string, signal?: AbortSignal) => Promise<RemoteResult<WorkspaceDirectoryListing>>
    /* … */
  }
  interface TypertRemoteNamespaceMap {
    'workspaceFiles': TypertRemoteNamespace$776f726b737061636546696c6573
  }
}

export declare const TYPERT_REMOTE: TypertRemoteContribution
export default TYPERT_REMOTE
```

`packages/api/workspace-files/lib/typert.host.js` — the `TYPERT` manifest auto-registered on the Host:

```js
export const TYPERT = {
  package: '@deepseek-ai/dsh-api-workspace-files',
  face: 'host',
  schemas: [ ],
  invocations: [
    {
      id: '@deepseek-ai/dsh-api-workspace-files#workspaceFiles/changes',
      service: 'workspaceFiles',
      namespace: 'workspaceFiles',
      method: 'changes',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'workspaceFileScope', wire: 'workspaceFileScopeId', source: 'lookup',
          lookup: 'workspaceFileScope',
          codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', schema: … } },
      ],
      cancellation: { parameter: 'signal' },
      result: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-api-workspace-files/types#WorkspaceFileWatchFrame', schema: … },
      sourceLocation: {"file":"packages/api/workspace-files/src/index.ts","line":365,"column":3},
    },
    /* list, read, readAll, readBytes, readRelated, stat */
  ],
}
```

So **the namespace and method table are emitted, not authored**. `service` + `namespace` come from `TypertRemoteService`'s binding; `wire` fields come from the lookup declarations.

### 3.4 Where the namespace is registered / mounted

- **Host registration is automatic.** `@deepseek-ai/dsh-typert-loader` (`packages/typert/loader/src/index.ts`) watches the Loader and, for every mounted entry whose package exports `./typert`, imports it and calls the registry — `:39`, `:41-44`, `:380-390`:

```ts
export const TYPERT_HOST_EXPORT = './typert'
export const name = 'typert-loader'
export const inject = ['typert', 'loader']
/* … */
const task = loadManifest(entryName, path).then((manifest) => {
  if (!active || !qualifies(entryName) || registered.has(entryName)) return
  registered.set(entryName, ctx.typert.register(manifest))
})
```

  Plugins nested behind another Loader entry need the explicit `packages: [...]` config (`:46-50`, `:335-337`). Manual `ctx.typert.register()` remains available for non-Loader compositions (`:20-23`).

- **Host dispatch** resolves the strict descriptor from the registry, then the live service by descriptor `service`, then validates the `typertRemote` binding — `packages/api/gateway/src/index.ts:597-620`, `:626-637`:

```ts
private resolveDescriptor(namespace: string, method: string, endpoint: string): InvocationDescriptor {
  const strict = this.ctx.typert.local.get(endpoint)
  if (strict !== undefined) return strict
  if (this.ctx.typert.local.hasSeen(endpoint)) { throw new TypertGatewayError('gateway/definition-unavailable', …) }
  return this.resolveSrcDescriptor(namespace, method, endpoint)
}
```

- **Client mount is explicit and lives in exactly one place**: `packages/api/remotes/src/client/index.ts:18` (value import) and `:158` (`await ctx.remote.$mount(contribution)`). `$mount` installs traced `remote.<namespace>` child services — `packages/api/gateway/src/client/index.ts:201-209`, `:321-378`.

- **Loader row** — `packages/bundle/web-app/cordis.patch.yml:104-111`:

```yaml
    # Session commands, cold reads, and live control over Typert Remote.
    - id: session-controller
      name: '@deepseek-ai/dsh-api-session-controller'

    # Workspace file service: bounded read, directory listing, and the
    # agent-write change feed inside the session workspace root.
    - id: workspace-files
      name: '@deepseek-ai/dsh-api-workspace-files'
```

  The same single row is both the host row and the browser roster row — see the file's own explanation at `:42-43` ("`dsh.client` rows are the browser roster the modules node half scans into `window.__DSH_BOOT__`") and `:176-177`.

### 3.5 Failure vocabulary

One class, `RemoteError`, code `<domain>/<reason>`, discriminated by `code` (never `instanceof`); universal codes `gateway/bad-request|gateway/cancelled|gateway/internal` are declared in protocol (`packages/typert/protocol/src/types.ts:47-54`). Details that reach the client are typed through the merge in your `/types` module. `remoteErrorOf(value)` recognises a failure across module/realm copies (`packages/typert/protocol/src/index.ts:11`). Client-side discrimination helper: `isRemoteFailure` (`packages/api/gateway/src/client/index.ts:753-755`).

---

## 4. Host-side filesystem / subprocess / shell access

A Host Remote half is an ordinary Cordis plugin, so it uses the same capability services as any other host plugin. Declare them in `inject` and read them off `ctx`.

There is **no `ctx.shell`-vs-`ctx.fs` choice for "sandboxed": the sandbox is a policy service**, and each capability has two providers (local vs sandbox-consuming) of which a composition mounts exactly one.

| Service | Package (service class) | Declaration | Providers / rows |
|---|---|---|---|
| `ctx.fs` | `@deepseek-ai/dsh-fs` — `packages/fs/fs/src/index.ts:36-40` (`interface Context { fs: FileSystem }`) | mount a backend | `fs-local`, `fs-sandbox` (`packages/bundle/base/cordis.patch.yml:479-480`) |
| `ctx.subprocess` | `@deepseek-ai/dsh-subprocess` — `packages/subprocess/subprocess/src/index.ts:81-83` | abstract `spawn` | `dsh-subprocess-local` (`packages/bundle/base/cordis.patch.yml:199-200`) |
| `ctx.shell` | `@deepseek-ai/dsh-shell` — `packages/shell/shell/src/index.ts:39-43, 64-67` (`abstract class ShellExecutor extends Service { constructor(ctx){ super(ctx,'shell') } }`) | abstract `resolve`/`run`/`start` | `dsh-bash-sandbox` / `dsh-bash-local` etc. (`packages/bundle/base/cordis.patch.yml:214-215`) |
| `ctx.sandboxPolicy` | `@deepseek-ai/dsh-sandbox-policy` — `packages/sandbox/sandbox-policy/src/index.ts:59` (`sandboxPolicy: SandboxPolicyService`) | `resolve(request?) → SandboxExecutionPolicy` (`:163`) | row `sandbox-policy` (`packages/bundle/base/cordis.patch.yml:203-211`) |
| `ctx.sandbox` | `@deepseek-ai/dsh-sandbox` (confinement runner) | — | row `sandbox` / `dsh-sandbox-local` |

**Real example of the composed pattern** — `@deepseek-ai/dsh-api-workspace-files` injects the ordinary fs seam plus the policy (`packages/api/workspace-files/src/index.ts:183`):

```ts
static inject = ['fs', 'sandboxPolicy', 'sessions', 'typert']
```

and reads through the composed filesystem, e.g. `packages/api/workspace-files/src/index.ts:265`, `:347`, `:451`:

```ts
const data = await this.ctx.fs.readByteRange(target, { offset, length }, signal)
const children = await this.ctx.fs.listDir(target, signal)
absolutePath: this.ctx.fs.processPath(target),
```

It uses `sandboxPolicy.workspaceRoot` as the cwd fallback (`:216`) and `fs.contains(root, target)` for the workspace containment gate on `list` (`:416-422`).

**Tiny real example of invoking a shell command through `ctx.shell`** — `packages/hooks/hook-protocol/src/runner.ts:67-105` (the hook runner is handed the service, so the same three lines work with `ctx.shell`):

```ts
export async function runHook(
  bash: ShellExecutor,                 // in a plugin: ctx.shell
  hook: CommandHook,
  options: RunHookOptions,
  now: () => number,
): Promise<RunHookResult> {
  const request = {
    command: hook.command,
    timeoutMs,
    stdin,
    signal: options.signal,
    ...options.cwd !== undefined ? { workdir: options.cwd } : {},
    ...options.env !== undefined ? { env: options.env } : {},
  }
  const result = await bash.run(bash.resolve(request))   // :87 — resolve() then run()
  const exitCode = result.exitCode ?? undefined          // non-zero exits do NOT reject
```

The in-tree tool that does it directly (`packages/shell/tool-bash/src/index.ts:379-382`, foreground) and `:369` (background `ctx.shell.start(...)` → jobs registry):

```ts
const result = await ctx.shell.run(ctx.shell.resolve({
  ...request,
  signal: exec.signal,
}))
```

And the sandbox-consuming provider shows how it composes with the other seams — `packages/shell/bash-sandbox/src/index.ts:43-46`:

```ts
export class SandboxBashExecutor extends LocalBashExecutor {
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy']
```

Its docstring (`:35-42`) records the rule: the sandbox **mode + workspace root are not executor config** — they live on `ctx.sandboxPolicy`, which resolves each calling session's mode/cwd for every enforcing capability.

So a new host Remote half that must run a command or read files declares the seams it needs, e.g.:

```ts
export class MyService extends TypertRemoteService {
  static inject = ['shell', 'fs', 'sandboxPolicy', 'typert']
  constructor(ctx: Context) { super(ctx, 'myNamespace') }

  @Remote
  async run(command: string, signal: AbortSignal): Promise<MyResult> {
    const result = await this.ctx.shell.run(this.ctx.shell.resolve({ command, signal }))
    return { exitCode: result.exitCode, stdout: result.stdout.text, stderr: result.stderr.text }
  }
}
```

(Composition caveat: a host-side shell/fs call runs with the *deployment* policy unless a session id is threaded through a lookup, because `sandboxPolicy.resolve()` keys on the session — `packages/sandbox/sandbox-policy/src/index.ts:163`, and workspace-files' lookup at `packages/api/workspace-files/src/index.ts:201-220` is the reference pattern for exactly that.)

---

## 5. `dsh.client` and the registration surfaces

### 5.1 What `dsh.client` means

Declared type — `packages/util/package-manifest/src/types.ts:43-57`:

```ts
/** Client module declaration read by client-modules and the client build. */
export interface DshClientManifest {
  /** Client platform identifier; the Web consumer selects `web`. */
  platform: string
  /** Informational package-name dependencies, not Cordis service injection. */
  inject?: string[]
  /** Boot phase-one registration barrier; absent means the shared application batch. */
  immediately?: boolean
  /**
   * Exact module-table requests beyond the implicit client baseline, including
   * subpaths such as `<pkg>/client`; absent means baseline externals only.
   * Type-only imports are erased and create no module request.
   */
  external?: string[]
}
```

Operationally (`packages/client/modules/src/index.ts`, the node half that scans the Loader):

- `platform` must be the string `'web'` or the package is skipped (`:761-764`); a malformed field throws (`:186-206`).
- A package with `dsh.client` **must** export `./client` — `:765-770`:
  ```ts
  const clientRel = clientExportOf(packageName, pkg.exports)
  if (clientRel === undefined) {
    throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`)
  }
  ```
  (`scripts/verify-cordis-config.ts:114` states the converse: `exports "./client" but declares no dsh.client, so its browser half is never served`.)
- It makes the package a row in `window.__DSH_BOOT__` and serves its built `lib/client.js` at `/plugins/<id>/client.js` (`packages/client/modules/src/index.ts:1-24`).
- `immediately` = boot phase-one barrier (only infrastructure rows such as `api-remotes`, `packages/api/remotes/package.json:32-39`).
- `inject` is **informational only** — package-name edges for preflight display and HMR diffing; it does **not** sequence activation. Activation order is Cordis fiber inject on *services* (`packages/client/AGENTS.md:140` and the table at `:87-93`).

### 5.2 Quoted checklist — `packages/client/AGENTS.md:134-143`

> ## New plugin package checklist
>
> Bringing up a new `packages/client/<name>` plugin package (ui-workspace is a complete example; ui-sidebar/ui-user-questions are minimal skeletons):
>
> 1. **Package skeleton**: `package.json` (`@deepseek-ai/dsh-client-<name>`, exports `.`/`./client`/`./src/*`/`./package.json`, optional `./invariant` only for an independent runtime relationship, `dsh.client` manifest, `files` list), `tsconfig.json` (extends `tsconfig.base.client.json`, one `references` entry per workspace dependency), `tsdown.config.ts` (`clientBundle(id, ['lib/types/index.js'])`, plus `lib/types/invariant.js` only when published), `src/index.ts` (empty node-half apply), optional `src/invariant.ts`, `src/css-modules.d.ts` when using CSS Modules, and `README.md` with the Model Experience section and the reason when no invariant is published.
> 2. **Three registration surfaces, all required** (missing any one fails at a different, later point): the `tsconfig.client.json` aggregate `references` entry; a `dsh.client` row in `packages/bundle/web-app/cordis.patch.yml`; a `packages/bundle/web-app/package.json` dependency (profile boots resolve bare row names through the healed `$DSH_HOME/profiles/node_modules` fallback, which mirrors the app's and each bundle's declared dependencies — a row whose package no manifest declares fails to import). `pnpm-workspace.yaml` already globs `packages/*/*`.
> 3. **dsh.client manifest semantics**: `platform: 'web'` always, and the declaration requires a `./client` export (the scan throws without one); `immediately: true` only for stage-one-prefetch infrastructure rows. `inject` lists package-name dependency edges — they are **informational only** (preflight display, HMR diffing); they do not sequence entry activation or apply order. Activation order is Cordis fiber inject waiting on *services*, nothing else. A non-baseline `external` request sequences its dynamic supplier ahead of the consumer — see [shared modules](#shared-modules-and-the-module-graph).
> 4. **Registering into another package's slot**: apply order is unconstrained, and a business service is not a declaration barrier. Use `ctx.slots.inject(name, () => ctx.slots.register(...))`; it waits on the actual declaration, removes the contribution when that declaration collapses, reruns after redeclaration, and leaves with the caller's plugin fiber. Return a generator yielding each registration when several contributions must install and roll back atomically. A bare `slots.register` into an undeclared slot remains an error; keep service edges only for services the contribution actually reads.
> 5. Rebuild the bundle (`pnpm --filter <pkg> bundle`) before probing a live `dsh web` server — the registry serves `lib/client.js`, not sources.
> 6. **Declaration decisions**, each settled by [dependency declaration](#dependency-declaration) and [shared modules](#shared-modules-and-the-module-graph): does the package ship a `./client` export; which non-baseline value imports require `dsh.client.external`; which Host value imports are ordinary dependencies; which Browser and type inputs are dev-only; and whether `files` covers every relative runtime import and emitted asset.

### 5.3 Each surface, with the real paths for our example

For a **client-only** browser plugin (like `ui-sidebar-files`):

| Surface | Real file / line |
|---|---|
| `package.json` exports `.`/`./client`/`./src/*`/`./package.json` | `packages/client/ui-sidebar-files/package.json:16-27` |
| `dsh.client` manifest (`platform: 'web'`, informational `inject`) | `packages/client/ui-sidebar-files/package.json:28-38` |
| `files` list | `packages/client/ui-sidebar-files/package.json:69-73` |
| `tsconfig.json` extends `tsconfig.base.client.json` + one ref per workspace dep (incl. the api package's **client** face) | `packages/client/ui-sidebar-files/tsconfig.json:1-48` (ref to `../../api/remotes/tsconfig.client.json` at `:14-16`, `../../api/workspace-files/tsconfig.client.json` at `:44-46`) |
| `tsdown.config.ts` = `clientBundle(id, ['lib/types/index.js'])` | `packages/client/ui-sidebar-files/tsdown.config.ts:1-3` |
| `src/index.ts` empty node-half `apply` | `packages/client/ui-sidebar-files/src/index.ts:1-4` |
| **Surface 1**: aggregate reference | `tsconfig.client.json:90` → `{ "path": "./packages/client/ui-sidebar-files" }` |
| **Surface 2**: Loader/browser row | `packages/bundle/web-app/cordis.patch.yml:233-235` (`- id: ui-sidebar-files` / `name: '@deepseek-ai/dsh-client-ui-sidebar-files'`) |
| **Surface 3**: bundle dependency | `packages/bundle/web-app/package.json:85` |

For a **dual-face** package that owns a namespace (`api-workspace-files` style, inside `packages/api/`, so AGENTS rule 2 at `packages/client/AGENTS.md:62` applies: *"`dsh.client` marks a Client/Host package outside that directory"*):

| Surface | Real file / line |
|---|---|
| Split solution `tsconfig.json` (host + client) | `packages/api/workspace-files/tsconfig.json:1-11` |
| Host face project | `packages/api/workspace-files/tsconfig.host.json:1-39` (`files: src/index.ts, src/types.ts, src/changes.ts`) |
| Client face project | `packages/api/workspace-files/tsconfig.client.json:1-27` (`files: src/client/*.ts, src/types.ts`; refs `../gateway/tsconfig.client.json`, `../../client/resources`) |
| **Surface 1a**: host aggregate reference | `tsconfig.host.json:174` → `{ "path": "./packages/api/workspace-files/tsconfig.host.json" }` |
| **Surface 1b**: client aggregate reference | `tsconfig.client.json:115` → `{ "path": "./packages/api/workspace-files/tsconfig.client.json" }` |
| Consumer references the *client* face | `packages/client/ui-sidebar-files/tsconfig.json:44-46` |
| **Surface 2**: Loader row (also the browser roster row) | `packages/bundle/web-app/cordis.patch.yml:110-111` |
| **Surface 3**: bundle dependency | `packages/bundle/web-app/package.json:47` |
| tsdown preset with `hostPhase: true` | `packages/api/workspace-files/tsdown.config.ts:3-7` |
| **Plus** the api-remotes mount | `packages/api/remotes/src/client/index.ts:18`, `:39`, `:158` |

Why the api-remotes edit is non-optional: `docs/api-gateway.md:76` — *"Client applications assemble only `@deepseek-ai/dsh-api-remotes`. That package imports the `/remote` subpaths of selected business packages as runtime values, mounts their contributions through `ctx.remote.$mount()`, and re-exports the declaration merges from the same files. Adding a Host Remote package is an explicit choice by the Client composition owner."* And `packages/api/remotes/README.md` (Known Limitations): *"Additional capabilities require an explicit `/remote` value import and mount in this assembly."*

If you forget it, `inject: ['remote.<ns>']` never resolves: an unsatisfied Cordis inject *"stays PENDING, with no timeout"* (`packages/client/AGENTS.md:91`) — the plugin silently never applies. That is the single most common failure mode.

---

## 6. Gotchas / verification ladder

1. **Build order is not optional.** `pnpm run build:lib` (host phase first) after any signature, code table, namespace, or export-name change; `pnpm run build:lib:client` alone cannot invent the Host contract (`docs/api-gateway.md:150-156`).
2. **The generator fails the build** if `./typert` / `./remote` export targets differ from the exact expected paths or the `files` list omits the artifacts (`packages/typert/generator/src/workspace.ts:96-147`).
3. **Client refuses weak descriptors**: mounting an SRC descriptor without a strict codec throws at mount (`packages/api/gateway/src/client/index.ts:699-724`), and the Client never discovers decorators from the running Host (`docs/api-gateway.md:137`).
4. **Names must be endpoint segments**: `/^[A-Za-z0-9_$.-]+$/`, not `.`/`..` (`packages/typert/protocol/src/index.ts:13-22`); method names may not collide with the namespace service's own members (`packages/api/gateway/src/client/index.ts:536-540`, `:657`).
5. **UI plugin hygiene**: a browser plugin's `/client` entry exports no values beyond `apply`/`inject`/`Config`/store factories; feature plugins must not runtime-import another feature plugin's values, and must not declare `dsh.client.external` to get them (`packages/client/AGENTS.md:32-36`).
6. **Rebuild before probing**: `pnpm --filter <pkg> bundle` (or `apps/web` shell changes rebuilt + page refresh) — the registry serves `lib/client.js`, not sources (`packages/client/AGENTS.md:142`). Client-plugin HMR only auto-reloads while `pnpm run dev:web` is running.
7. **Testing a client double**: take `RemoteError` and `TestRemote` from `@deepseek-ai/dsh-client-test-runtime`, because a value import from the `api-remotes` facade would load the unbuilt assembly chain (`docs/cookbook/adding-a-remote-api.md:169`).
8. **Verification**: `pnpm run build:lib` → `pnpm run typecheck` → targeted `npx vitest run <owner spec> <client spec>` (`docs/cookbook/adding-a-remote-api.md:192-197`).

---

## 7. Authoritative docs to hand to whoever implements this

- `docs/cookbook/adding-a-remote-api.md` — the 5-step action list (declare, failures, register on the package, consume on the client, test).
- `docs/api-gateway.md` — mechanism: decorators, generation pipeline, artifact table, `/api` route, SRC fallback.
- `packages/typert/protocol/README.md` — declaration API and protocol maps.
- `packages/typert/generator/README.md` — what generates the declarations and the export/files publication contract.
- `packages/api/remotes/README.md` — the Client assembly's selection model and build boundary.
- `packages/client/AGENTS.md` — client plugin package rules and the New plugin package checklist.
