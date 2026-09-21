# How a Third-Party / Local DSH Plugin Is Distributed and Installed

Research report on the DeepSeek Harness (DSH) checkout at `/home/fit/00lib/deepseek-harness`.
All findings are read-only; no repository file was modified. Line numbers refer to files as they
exist in this checkout.

**Scope:** the "plugin authoring" story for someone who is **not** editing the monorepo.

---

## 0. Executive summary — the three routes, and which one is "distribution"

| Route | Mechanism | Persistence | Audience |
|---|---|---|---|
| **A. `--patch` overlay** | `dsh web --patch ./scratch-plugin/cordis.yml` | process lifetime | trying a local `.ts` plugin from a checkout |
| **B. Profile/hand patch** | edit `$DSH_HOME/profiles/<name>/cordis.patch.yml` or the home-level `$DSH_HOME/cordis.patch.yml` | durable, hot-reloaded | machine-local tweaks |
| **C. `dsh plugin add` (a *bundle*)** | `dsh plugin --profile web add <pkg-or-git-spec>` | durable, pnpm-managed | **the actual distribution story for third parties** |
| **D. Dynamic in-memory packages** | `cordis_define` / `cordis_run` model tools | **process memory only, lost on restart** | agent self-extension, *not* distribution |

The single most important correction to the task's framing: **there is no `packages/self-modification/`
directory.** That path exists only in the stale root `AGENTS.md` layout list (`AGENTS.md:38`,
`self-modification/  the agent inspects/mounts its own plugins`). The concept was regrouped into
`packages/extensions/`, confirmed by `packages/README.md:63`:

> `| [`extensions/`](extensions/README.md) | Agent runtime self-modification: live plugin/service inspection and model-written mount/unmount |`

Route **C** is the answer to "how is a third-party plugin distributed and installed". Route **D** is
runtime self-modification and is explicitly *not* an installation path.

---

## 1. `docs/cordis-tutorial/` — the documented authoring flow

`docs/cordis-tutorial/index.md:11` is the fork in the road, and it points *away* from the tutorial for
harness work:

> To write plugins for the harness itself — loaded from a `cordis.yml` and driven from the Web UI
> rather than the launcher below — start from [your first Harness plugin](../user/develop/basic/index.md).

### 1.1 `01-first-plugin.md` — what a plugin is (verbatim)

`docs/cordis-tutorial/01-first-plugin.md:5`:

> In the loader configuration used here, a Cordis plugin module named-exports an `apply` function.
> When Cordis loads it, it calls `apply` with a **context** — the `ctx` object through which the
> plugin registers everything it contributes.

The plugin shape (`01-first-plugin.md:11-19`):

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello'

export function apply(ctx: Context) {
  console.log('hello from my first plugin')
}
```

> The `name` export is optional display metadata; it labels the plugin in diagnostics.

The composition file is a **list of plugin entries** (`01-first-plugin.md:27-31`):

```yaml
- name: './hello.ts'
```

> The file is a list of plugin entries. `name` is a module specifier — a relative path or an npm
> package name — and the loader mounts every entry. Entries start concurrently, so list position
> guarantees nothing about which plugin loads first; ordering comes from service dependencies
> (`inject`, [chapter 3](03-services.md)), not from position in the file.

Run it (`01-first-plugin.md:36`): `node --import tsx ../../vendor/cordis/bin.js`

Three accepted plugin shapes (`01-first-plugin.md:55-77`): function plugin (`export function apply`),
object plugin (`export const objectPlugin = { name, apply }`), class plugin
(`export class MyService extends Service`).

**A caveat that matters directly for third-party installs** — `01-first-plugin.md:91`:

> One caveat worth knowing early: a config entry whose module cannot be **resolved** — a typo'd path
> or package name — is reported through the Cordis logger service instead of crashing the process,
> and at boot that report can be lost before a console exporter is watching. If a freshly added entry
> seems to do nothing, check the spelling first.

### 1.2 `05-config.md` — configuration

`docs/cordis-tutorial/05-config.md:34`:

> The exported `Config` is both a TypeScript interface and a runtime schema with the same name —
> consumers get the type, Cordis gets the validator. This repo uses
> [Schemastery](https://github.com/shigma/schemastery) for schemas; Cordis itself accepts any
> [Standard Schema](https://standardschema.dev/) validator, so a plain object exported as `Config`
> will not work.

`05-config.md:80` documents the `!!js` tag, constrained to `config` and `disabled`:

> `!!js` works only inside `config` and in an entry's `disabled` field. `disabled: !!js ...` evaluates
> against the loader context at every mount decision (this repo's extension), so a row can gate itself
> on platform or environment; the other metadata (`name`, `id`, `inject`, ...) stays static, where an
> expression is ordinary truthy data.

### 1.3 `06-composition-and-hmr.md` — entry metadata

`06-composition-and-hmr.md:19`:

> `id` gives the entry a stable identity so the loader can tell an edit to an existing entry apart
> from a removal plus an addition. `disabled: true` unmounts a plugin without deleting its entry —
> flip it back and the plugin (and everything PENDING on its services) loads again.

`06-composition-and-hmr.md:59` explains why `id` matters for third-party rosters:

> This is why the entries above carry explicit `id`s — an entry without one gets a generated id on
> every read, so after any config-file edit it counts as removed-plus-added and remounts even if its
> own lines did not change.

### 1.4 `07-into-the-harness.md` — the bridge to `--patch`

`07-into-the-harness.md:99`:

> A real agent is this composition plus more plugins: an LLM adapter, the agent loop, persistence, and
> an application entry. Compare the [base profile layer](../../packages/bundle/base/cordis.patch.yml)
> and [headless layer](../../packages/bundle/headless/cordis.patch.yml) — you can read their entries
> now. **Add your `greet-tool.ts` through a small `--patch` overlay.**

So the tutorial itself ends by handing the reader to the `--patch` mechanism.

---

## 2. `docs/cordis-primer.md` — and an important gap

`docs/cordis-primer.md` is only **45 lines**. It covers plugin concepts but **does not mention
`$DSH_HOME` or profiles at all.** The task's premise that the primer documents loader configuration
"and profiles" is only half right: it has a `## Loader Configuration` section (line 37) but profile
mechanics live in `packages/boot/app-boot/README.md` and `apps/cli/reference/README.md`.

### 2.1 What a plugin is (primer lines 9-13, verbatim)

> - **A plugin is a object that implements Service.** It can be a function with optional `inject` and
>   `apply(ctx)` fields, or a `Service` subclass whose lifecycle Cordis mounts into the current context.
> - **A context is a repository of services.** A service claims a stable `ctx.<key>` such as
>   `ctx.tools`, `ctx.llm`, or `ctx.sessions` from a context; other plugins find services via key
>   instead of importing a concrete implementation.
> - **Declare service dependency via `inject`.** A plugin that names required services waits until
>   those services exist, so load order is expressed through service requirements rather than manual
>   boot sequencing.
> - **Typed Events for communication.** ...
> - **Registrations are reversible effects.** Prompt sections, tool schemas, adapters, providers, and
>   listeners are installed through `ctx.effect()` or `ctx.on()` so reload and teardown unwind them
>   predictably.

### 2.2 Loader configuration (primer line 39, verbatim, the whole section)

> `@deepseek-ai/cordis-plugin-include` parses `!!js` into expression nodes. Loader interpolates an
> entry's `config` (after declared injections activate, against that plugin context — `ctx.serviceName`)
> and its `disabled` field (at every mount decision, against the loader context); Include preserves
> nested row expressions until target activation. Other entry metadata stays literal. Use overlays when
> the environment selects plugins.

Key phrase for third-party distribution: **"Use overlays when the environment selects plugins."**

### 2.3 How plugins are mounted from `cordis.yml`

The profile directory contains a root `cordis.yml` that is deliberately **empty** — the composition is
built entirely from patches. Verified live on this machine,
`~/.dsh/profiles/web/cordis.yml`:

```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

### 2.4 `$DSH_HOME`

Defined in `packages/util/home-paths/src/index.ts`:

- `:12` — `export const DSH_HOME_DIR_NAME = '.dsh'`
- `:15` — `export const DEFAULT_DSH_HOME_DISPLAY = `~/${DSH_HOME_DIR_NAME}``
- `:18` — `export const DSH_HOME_ENV = 'DSH_HOME'`

Precedence (`packages/util/home-paths/src/index.ts:77-80`):

> Precedence, highest first: an explicit configured path, `$DSH_HOME`, then `~/.dsh`. The harness
> keeps all user data under one root. An empty or whitespace-only `$DSH_HOME` is treated as unset, so
> a blank override never resolves the home to the current working directory.

`defaultDshHome()` at `:61-63` is `join(homedir(), '.dsh')`.

### 2.5 Where profiles live

`packages/boot/app-boot/README.md:50`:

> A profile is how one dsh installation ships different app surfaces: `web`, `headless`, `acp`,
> `sdk`, and `sdk-minimal` start distinct compositions from the same launcher. **A profile lives at
> `$DSH_HOME/profiles/<name>`** and combines installable bundles, its own `cordis.patch.yml`, and
> `patchReload: live | startup`; omitted reload policy keeps the historical `live` default for custom
> profiles.

`packages/boot/app-boot/src/profile.ts:45` — `export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'`

A profile directory holds (`docs/user/develop/basic/publish.md:68-71`):

> - `package.json` — the profile's out-of-tree plugin dependencies (managed by pnpm) plus the
>   `dsh.profile` manifest with its ordered `bundles` list.
> - `cordis.patch.yml` — the user's own patch layer, applied after every bundle layer.

### 2.6 The `node_modules` fallback from `packages/client/AGENTS.md`

The exact sentence the task quoted is `packages/client/AGENTS.md:139`, item 2 of the
"New plugin package checklist":

> **Three registration surfaces, all required** (missing any one fails at a different, later point):
> the `tsconfig.client.json` aggregate `references` entry; a `dsh.client` row in
> `packages/bundle/web-app/cordis.patch.yml`; a `packages/bundle/web-app/package.json` dependency
> (**profile boots resolve bare row names through the healed `$DSH_HOME/profiles/node_modules`
> fallback, which mirrors the app's and each bundle's declared dependencies — a row whose package no
> manifest declares fails to import**). `pnpm-workspace.yaml` already globs `packages/*/*`.

The authoritative mechanism is `apps/cli/reference/README.md:11`:

> Bundle names resolve from the dsh installation first, then from the profile directory. In-box
> bundles (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless`,
> `@deepseek-ai/dsh-sdk-app`, `@deepseek-ai/dsh-sdk-minimal`, `@deepseek-ai/dsh-acp-app`) therefore
> always come from the same installation as the running `dsh`; out-of-tree bundles come from the
> profile's pnpm-managed `node_modules`. **A bare plugin `name` in any patch row resolves through the
> profile directory's Node parent walk, which reaches the maintained installation fallback
> `$DSH_HOME/profiles/node_modules`.** Plain Node installations place one healed symlink there per
> dependency-closure package. A pkg executable instead places a real ESM proxy that mirrors explicit
> exports and re-exports the virtual package URL, because operating-system symlinks cannot enter pkg's
> `/snapshot` filesystem. Every launch also links packages carried only by selected external bundles
> through a dsh-owned directory into the current profile's `node_modules`; existing pnpm entries win,
> and each profile owns its links independently.

**Verified live on this machine.** `~/.dsh/profiles/node_modules/` is exactly that healed symlink farm
pointing back into the monorepo installation:

```
chokidar  -> /home/fit/00lib/deepseek-harness/apps/cli/node_modules/@deepseek-ai/cordis-plugin-hmr/node_modules/chokidar
commander -> /home/fit/00lib/deepseek-harness/apps/cli/node_modules/commander
compression -> /home/fit/00lib/deepseek-harness/apps/cli/node_modules/@deepseek-ai/dsh-web-app/node_modules/@deepseek-ai/dsh-host-webserver/node_modules/compression
js-yaml   -> /home/fit/00lib/deepseek-harness/apps/cli/node_modules/js-yaml
```

There is also a per-profile variant: `~/.dsh/profiles/web/.dsh-module-fallback/node_modules/`
(holds `d3-*`, `@iconify`, `schemastery`, `marked`, `react-icons`, …), i.e. the "dsh-owned directory"
from the last sentence of the quote above.

**Why this matters for a third-party author:** a bare `name:` in your patch only resolves if the
package is reachable from the profile. Installing via `dsh plugin add` guarantees that; hand-writing a
bare name without installing it fails to import.

---

## 3. How a user's own / dynamic plugin gets loaded at runtime

### 3.1 The durable install path — `dsh plugin` (this is *the* answer)

`apps/cli/reference/README.md:55`:

> `dsh plugin --profile <name> <args...>` initializes the profile when missing (shipped template, or
> `@deepseek-ai/dsh-base` alone for other names), then **forwards `<args...>` to `pnpm` with the
> profile directory as working directory** — `add`, `remove`, `why`, `update`, and every other pnpm
> verb work unchanged; pnpm must be on PATH. Relative path specs (`.`, `../plugin`, and their
> `file:`/`link:` forms) are anchored to the invoking directory first, so `add .` from a plugin
> checkout installs that checkout, not the profile. **After every successful run,
> `dsh.profile.bundles` is reconciled against the installed state**: each dependency resolving to a
> package whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` joins the
> layer stack (so an `update` that gains the declaration activates it), a bundle-less dependency stays
> plain with a one-time warning, and a removed dependency leaves the stack.

`apps/cli/reference/README.md:105`:

> Install external plugin bundles through `dsh plugin --profile <name> add <package-or-git-spec>`. The
> installed package owns its dependencies and contributes its declared `cordis.patch.yml` layer.

### 3.2 The two manifests — bundle vs profile

`docs/user/develop/basic/publish.md:13-16`:

> - A **bundle** is an npm package that ships a configuration layer. Its manifest declares
>   `dsh.bundle`, answering "what does this package contribute?": a patch file that inserts or
>   overrides plugin rows.
> - A **profile** is a directory under `$DSH_HOME/profiles/<name>` describing one runnable composition.
>   Its manifest declares `dsh.profile`, answering "which bundles compose this setup, in what order?".
>
> A bundle is what you author and distribute; a profile is what a user boots with `dsh --profile <name>`.
> Nothing is both.

A minimal bundle (`publish.md:36-62`): `package.json` with
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, an `index.js` exporting `apply`, and a
`cordis.patch.yml`:

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

The install command and its effect (`publish.md:80-101`):

```sh
dsh plugin --profile demo add ./hello-plugin
```

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": { "dsh-hello-plugin": "link:/path/to/hello-plugin" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-hello-plugin"]
    }
  }
}
```

Verify without booting, then boot (`publish.md:106-110`):

```sh
dsh --profile demo --dump-config   # shows a "# == dsh-hello-plugin" layer
dsh --profile demo
dsh plugin --profile demo remove dsh-hello-plugin
```

### 3.3 The loading order (layer precedence)

`publish.md:114-123` and `apps/cli/reference/README.md:9` agree, verbatim from `publish.md`:

> The effective configuration composes over an empty root by applying, in order:
>
> 1. Each bundle patch named in the profile's `dsh.profile.bundles` list, in list order —
>    `@deepseek-ai/dsh-base` first, then each installed bundle in the order it was added.
> 2. The profile's own `cordis.patch.yml`.
> 3. The home-level `$DSH_HOME/cordis.patch.yml` — machine-local preferences shared by every profile.
> 4. Each `--patch <path>` overlay, in argv order.
>
> Later layers win per row, and **a patch replaces a row's entire `config` value rather than
> deep-merging keys.**

Two consequences for bundle authors (`publish.md:125-126`):

> - Your patch can override rows from earlier layers by `id` — the same way the `dsh-web-app` bundle
>   overrides `dsh-base` rows — but must restate every key the row needs, not just the changed one.
> - Users can override your rows in their profile's `cordis.patch.yml` without touching your package,
>   so prefer configuration defaults users are likely to keep and let the schema carry the rest.

### 3.4 The `--patch` overlay path (fastest local loop)

`docs/user/develop/basic/index.md:48-62` — note the **absolute path requirement**:

> Run `pwd` from the repository root, then create `scratch-plugin/cordis.yml` as a Web overlay that
> inserts the local plugin. Replace `/absolute/path/to/deepseek-harness` below with the printed path:
>
> ```yaml
> - insert:
>     - id: hello
>       name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/my-plugin.ts'
> ```
>
> **The plugin path must be absolute. A patch file contributes configuration but does not change the
> profile directory from which the loader resolves module paths.**
>
> ```sh
> pnpm dsh web --patch ./scratch-plugin/cordis.yml
> ```

`packages/boot/app-boot/README.md:59` clarifies path handling:

> Inserted plugin names may be absolute filesystem paths, file URLs, or package specifiers. Patch
> loading converts absolute paths and patch-relative `./` or `../` paths to file URLs within `insert`
> rows and their nested groups; existing-entry name assertions and replacement `config` values remain
> literal.

**Correction — "must be absolute" is over-strict for `insert` rows.** The implementation confirms
relative paths work and are anchored beside the patch file. `packages/boot/app-boot/src/index.ts:325-336`:

```ts
/** Convert inserted filesystem paths to file URLs, anchoring relative paths beside the patch; keep assertion names literal. */
function anchorInsertedPluginNames(patches: PatchOptions[], file: string): PatchOptions[] {
  const base = dirname(resolve(file))
  const visit = (entry: EntryOptions): void => {
    if (typeof entry.name === 'string' && (isAbsolute(entry.name) || entry.name.startsWith('./') || entry.name.startsWith('../'))) {
      entry.name = pathToFileURL(resolve(base, entry.name)).href
    }
    if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit)
  }
  for (const patch of patches) patch.insert?.forEach(visit)
  return patches
}
```

So `name: './my-plugin.ts'` inside an `insert` row resolves relative to the **patch file's directory**.
Two bounds: it applies only to `insert` rows (and nested groups), not to `id`-targeted assertion rows;
and a bare `my-plugin.ts` without a `./` or `../` prefix is treated as a **package specifier**, not a path.

This is corroborated by real shipped examples that use relative paths:
- `docs/user/develop/basic/config.md:39` — `name: './src/my-plugin.ts'`
- `apps/cli/config/examples/github-review/cordis.yml:8-9` — `- id: github-ready-review-rule` /
  `name: './github-ready-review-rule.mjs'`, the one local-file plugin load among the shipped examples

The tutorial's absolute-path advice remains the safe default when the patch is generated or moved, but a
hand-written patch beside its plugin source works with a relative path.

Home-level patch layer, `packages/boot/app-boot/README.md:55`:

> **`cordis.patch.yml`** — your tweak layer, applied after every bundle layer (per-profile first, then
> the home-level file, which therefore outranks it): replace one entry's whole config (restating the
> fields you keep), insert new entries, or interpolate `!!js` expressions at boot. A patch naming an
> entry that does not exist prints a stderr warning; an empty or comments-only file fails boot —
> disable the layer with `[]` instead.

### 3.5 Self-modification / dynamic plugins — **not** an install path

The dynamic runtime lives in `packages/extensions/` (four packages, per
`packages/extensions/README.md`):

| Package | Role | ctx key |
|---|---|---|
| `tool-cordis` | Seven model-facing tools: inspect, define, run, stop, remove dynamic packages | registers on `ctx.tools` |
| `cordis-host-runner` | Host half: definition registry, sandboxed host-half lifecycle, inspect registry | `ctx.dynamicCordisRunner`, `ctx.cordisInspect` |
| `cordis-client-runner` | Browser half: evaluates browser-half source into a live plugin | browser `ctx.dynamicCordisRunner` |
| `ui-cordis` | Browser surfaces: frame-wide panel, lifecycle tool cards, `@pluginId` input source | registers slots |

The seven tools (`docs/tool-catalog.md:24`): `cordis_define`, `cordis_inspect_list`,
`cordis_inspect_query`, `cordis_inspect_self`, `cordis_run`, `cordis_stop`, `cordis_undefine`.

**Path correction:** `cordis-client-runner` and `ui-cordis` live under `packages/extensions/`, **not**
`packages/client/`. `packages/extensions/README.md:51` explains why:

> The two browser-half packages live in this group rather than under `packages/client/` because they are
> halves of this subsystem's dual-half packages; the client face compiles them through the client
> program, while the host program references only the host runner.

Plugin code arrives as an **inline JavaScript source string** in the tool call, not a file —
`docs/tool-catalog.md:373-380` describes `code.host` as "Plain JavaScript function body that returns the
Host-half Cordis Plugin" and `code.client` likewise for the browser half. `tool-cordis/README.md:183`:

> **Plain JavaScript only** — dynamic package code is not transformed: no TypeScript, JSX, or imports,
> and the sandbox withholds Node globals such as `require`, `setTimeout`, and `fetch`, redirecting
> filesystem, network, and process work to Cordis services.

**This is explicitly not distribution** — `packages/extensions/tool-cordis/README.md:12`:

> Package versions are immutable, so a failed package can be corrected by adding a new version and
> updating the active one. **Definitions exist only in process memory and disappear when DSH restarts;
> the package does not write repository files, install dependencies, or change `cordis.yml`.**

It is opt-in and in no shipped tree (`docs/tool-catalog.md:24`: "Not in any shipped tree (a deliberate
opt-in — dynamic package code reaches the real runtime…)"). `tool-cordis/README.md:59` on trust:

> The sandbox isolates globals but is not a security boundary — treat a dynamic package like bash
> access, and load this plugin as deliberately as you would grant one.

…and `:182`:

> **The sandbox is containment for honest code, not a security boundary**

Lifetime (`tool-cordis/README.md:59`):

> Definitions are session-scoped and process-local: a package is visible and controllable only in the
> session that defined it, stays active across later turns, and can affect other sessions in the same
> process while running. Stopping, removing, unloading the toolset, or restarting DSH clears it.

`cordis_stop` keeps the definition runnable; `cordis_undefine` removes it permanently. The session log
retains the submitted source (`cordis-host-runner/README.md:50`), but **nothing is written to disk**
(`cordis-host-runner/README.md:12`). Enable it via the checked-in example
overlay (`docs/user/develop/practice/dynamic-cordis.md:12`):

```sh
pnpm dsh web --patch apps/cli/config/examples/cordis/cordis.yml
```

That overlay (`apps/cli/config/examples/cordis/cordis.yml`) inserts `cordis-host-runner` and
`tool-cordis` rows. Its head comment is a blunt safety statement:

```yaml
# Opt-in Web composition for inspecting the self-referential Cordis tools.
# Temporary Plugin code can reach every injected live capability; treat this
# deployment like shell access, not as a security boundary.
```

The design note `.agents/notes/rejected/architecture/2026-08-08-cordis-web-dynamic-packages.md` was
**rejected** — its own header says the shipped `packages/extensions` runtime and READMEs own the
design. So the dynamic path is settled as runtime-only.

### 3.6 The plugin-inventory UI is read-only

`packages/host/plugin-inventory/README.md:40`:

> The inventory is a snapshot for display and diagnostics: a client can render the roster, flag failed
> entries, and detect changes by comparing snapshots. **It cannot enable, disable, add, or remove
> plugins**, and it carries no history — a fiber that already failed and was removed is absent.

`packages/host/plugin-inventory/README.md:100`:

> **No provenance or mutation** — the service does not identify which bundle, profile, or override
> introduced an entry, and it cannot enable, disable, add, or remove plugins in either plane.

`packages/client/ui-settings-plugin-inventory/README.md:93`:

> **Read-only in both planes** — the tab shows global and preset enablement but mutates neither;
> enable/disable controls that write a custom preset's own composition file are deliberate follow-up
> work.

So **the Plugins settings page is a diagnostic view, not an install surface.** Installation is CLI-only.
Separately, `packages/client/ui-settings-plugins/README.md:28` shows the **Plugin configuration** tab
edits only four host-plane setting namespaces (shell executor `bash`, `agent-loop`,
`subagent-model-selection`, `web-search-deepseek`) — not plugin membership.

### 3.7 Shipped example overlays (`apps/cli/config/examples/`)

Four example overlays ship in the CLI package: `cordis/`, `github-review/`, `mcp-memory/`,
`schedule/`. They demonstrate overlay composition, not installation:

- **`cordis/cordis.yml`** — enables the dynamic runtime (see §3.5). Its head comment is the clearest
  available statement of what an overlay is:

  ```yaml
  # This file is a PATCH OVERLAY over the web profile (dsh-base + dsh-web-app
  # bundle layers), not a tree: `dsh web --patch` applies it as one more sibling
  # patch list at the same include level, so these patches reach every bundle
  # row. A patch replaces the targeted row's whole `config`.
  ```

- **`github-review/cordis.yml:8-9`** — the one shipped example that loads a **local file** plugin by a
  relative path:
  ```yaml
  - id: github-ready-review-rule
    name: './github-ready-review-rule.mjs'
  ```
- **`mcp-memory/mcp-reference-memory.cordis.yml:1-2`** — an explicit boundary statement: "Install the
  pinned executable first; DSH starts it but does not run a package manager." Third-party MCP binaries
  are the user's responsibility, outside DSH's install machinery.
- **`schedule/cordis.yml`** — first-party rows only.

### 3.8 Other real-world install paths found in docs

- Git host: `dsh plugin --profile demo add github:you/hello-plugin` (`publish.md:158`)
- Tarball: `dsh plugin add ./hello-plugin-0.1.0.tgz` (`publish.md:178`)
- npm prebuilt: `dsh plugin add your-package` (`publish.md:177`)
- SDK minimal profile: `dsh plugin --profile sdk-minimal add file:/absolute/path/to/my-plugin-bundle`
  (`docs/user/guide/python-sdk.md:117`)
- Published opt-in bundle example: `dsh plugin --profile headless add @deepseek-ai/dsh-experimental-agent-team-profile`
  (`packages/experimental/agent-team-profile/README.md:33`)

---

## 4. `DSH_HOME` default and finding the running user's `$DSH_HOME` on Linux

### 4.1 Default

`~/.dsh` — from `packages/util/home-paths/src/index.ts:12` (`DSH_HOME_DIR_NAME = '.dsh'`) and `:61-63`:

```ts
export function defaultDshHome(): string {
  return join(homedir(), DSH_HOME_DIR_NAME)
}
```

Precedence: explicit configured path → `$DSH_HOME` → `~/.dsh`. Tilde forms (`~`, `~/`, `~\`) are
expanded (`:70-74`). The display form never leaks the machine path: the default renders as `~/.dsh`,
a configured home as `$DSH_HOME` (`packages/util/home-paths/README.md:42`).

### 4.2 Finding the *currently running* user's `$DSH_HOME` on Linux

The running harness exports it into the environment. **Verified live in this session:**

```sh
$ env | grep -i '^DSH_'
DSH_HOME=/home/fit/.dsh
DSH_SESSION_ID=d465720e-a083-4c15-8fee-3043250276cf
DSH_SHELL=1
DSH_WEB_URL=http://127.0.0.1:3080
```

Practical recipes, in order of reliability:

1. **Read `DSH_HOME` from the process environment** — authoritative when the harness was launched with
   it set (as here). `tr '\0' '\n' < /proc/<pid>/environ | grep '^DSH_HOME='` for a running PID.
2. **Fall back to `~/.dsh`** when `DSH_HOME` is unset. On this machine both agree.
3. **Confirm by directory shape**: `$DSH_HOME` contains `profiles/`, `sessions/`, `storages/`,
   `logs/`, `.credentials.yaml`, `settings.yaml`. Verified here as
   `~/.dsh/{profiles,sessions,storages,logs,.credentials.yaml,settings.yaml,.anonymous-user-id}`.
4. `DSH_WEB_URL` tells you the live GUI URL; it is **not** the home.

Note `packages/util/http-proxy/README.md:52` and `packages/boot/app-boot/README.md:54`: `$DSH_HOME/.env`
is a launch-environment layer, but `DSH_*` variables are **rejected from `.env` files** — "Variables
that decide how the process starts (`PATH`, `DSH_*`, `XDG_*` and similar) are rejected from files:
export them instead." So `DSH_HOME` must be exported, not written to `.env`.

---

## 5. `packages/bundle/web-app/cordis.patch.yml` — roster format

### 5.1 The head comment block (lines 1-12, verbatim)

```yaml
# The dsh-web-app bundle patch: the browser surface over the dsh-base layer.
# Applied after dsh-base's insert; rows here override base rows by id, with
# the profile's own cordis.patch.yml and any --patch overlays still to come.
#
# A patch replaces the targeted row's whole `config`, so each row below
# restates every key it owns.
#
# The web-startup plugin injects `cmdlineArgs` and provides `webStartup` as an
# ordinary Cordis service. Rows configured from flags inject that service, so
# Loader resolves their expressions only after it exists. The web runtime then
# provides bind-dependent `webRuntime` values to the trust fence.
# `dsh --profile web --help` provides neither service, so no server binds.
```

### 5.2 The browser-roster divider (lines 42-44, verbatim)

```yaml
# `dsh.client` rows are the browser roster the modules node half scans into
# window.__DSH_BOOT__; the modules row is simultaneously a host row.
- insert:
```

### 5.3 Three `dsh.client` rows verbatim

`modules` — the dual-face row that owns the whole roster (lines 172-177):

```yaml
    # Dual-face: the node half scans this tree, composes window.__DSH_BOOT__,
    # and serves /plugins/<id>/client.js; the browser half is the module table
    # the shell kernel constructs before cordis exists (adopted as a plugin
    # entry by the kernel, never fetched).
    - id: modules
      name: '@deepseek-ai/dsh-client-modules'
```

`connection` — a row with a `!!js` config expression (lines 179-188):

```yaml
    # Owns both ends of the web transport: node half binds the gateway to the
    # webserver under /api; browser half is the fetch/SSE client.
    - id: connection
      name: '@deepseek-ai/dsh-client-connection'
      inject: [webRuntime]
      config:
        # LAN literals derived from the active bind plus --trusted-host extras.
        # A deployment adding authorities keeps this expression and concatenates
        # its literals, for example: ['app.internal', ...ctx.webRuntime.trustedHosts].
        trustedHosts: !!js ctx.webRuntime.trustedHosts
```

`ui-settings-plugin-inventory` — a plain leaf row (lines 246-247):

```yaml
    - id: ui-settings-plugin-inventory
      name: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory'
```

### 5.4 A `disabled` row for contrast (lines 303-308)

```yaml
    # Read-only active Schedule catalog. The shipped Web graph resolves the
    # client package but leaves it disabled; the explicit Schedule overlay
    # enables this same row together with the host Schedule services.
    - id: ui-schedule
      name: '@deepseek-ai/dsh-client-ui-schedule'
      disabled: true
```

### 5.5 Row shape summary

Every row is `{ id, name, inject?, config?, disabled? }` inside a top-level YAML **array**, where
new plugins go under a nested `- insert:` list. Rows outside `insert` target an existing entry by `id`
to override `config` / `disabled`. `!!js` is allowed only in `config` values and `disabled`.

---

## 6. `packages/extensions/*`, `packages/experimental/*`, `packages/bundle/*`

### 6.1 `packages/extensions/`

Documents **runtime self-modification only**, not package installation. `packages/extensions/README.md:12`:

> The extensions group lets an agent inspect and modify the live DSH runtime without editing repository
> files or configuration. It can define, run, update, stop, and remove dynamic Cordis packages from
> model tools or a browser panel. A package may affect the host, browser, or both, and immutable
> versions support controlled updates. **Definitions exist only in process memory and disappear when
> DSH restarts.**

**No documented "install a local plugin package here" path.** Verified by a full README sweep of the
group: no `npm install`, `pnpm add`, tarball, GitHub, or `file:` install syntax appears anywhere in
`packages/extensions/*/README.md`. The one adjacent instruction (`tool-cordis/README.md`, "Minimal
composition", lines 32-37) is a YAML **composition** patch, not an install. Manifest check: **no**
`packages/extensions/*` package ships a `cordis.patch.yml`, so none is activatable as a
`dsh plugin add` layer; `ui-cordis` and `cordis-client-runner` declare only `dsh.client`.

### 6.2 `packages/experimental/`

Group README documents prototypes and carries no install command; `agent-team-profile` and
`agent-team-web-profile` are the only two packages here that declare `dsh.bundle.patch`, i.e. the only
two activatable as an installed layer. **Both are first-party `@deepseek-ai/dsh-experimental-*`
packages — not third-party code.**

`packages/experimental/agent-team-profile/README.md:33`:

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-agent-team-profile
```

`packages/experimental/agent-team-web-profile/README.md:33-34` (order matters):

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-team-profile
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-team-web-profile
```

Its README `:86` states the required layer order `dsh-base` → `dsh-web-app` →
`dsh-experimental-agent-team-profile` → this package, and `:88` "**Opt-in only**". Both packages are
removable with `dsh plugin --profile <name> remove <pkg>`.

`packages/experimental/agent-team-profile/package.json` carries exactly the bundle declaration:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
"files": ["lib/index.js", "cordis.patch.yml", "lib/types/**/*.d.ts"]
```

**Gap:** no README in `packages/extensions/*` or `packages/experimental/*` documents installing a
genuinely third-party (non-`@deepseek-ai`) or local-path plugin. That path is owned by
`packages/bundle/README.md:32` and `docs/user/develop/basic/publish.md` (§3 above).

### 6.3 `packages/bundle/*` — bundle/profile concepts

`packages/bundle/README.md:12,32`:

> This group maps the installable patch layers used by `dsh --profile`. Each package declares
> `dsh.bundle.patch`; the launcher stacks those patch documents to assemble a named profile. The
> `web`, `headless`, `acp`, and `sdk` profiles build on `dsh-base`, while `sdk-minimal` supplies its
> complete tree in one bundle.
>
> In-box bundles resolve from the dsh installation; **out-of-tree bundles install into a profile
> through `dsh plugin --profile <name> add <package>`.**

---

## 7. Can a client (browser) plugin be added WITHOUT rebuilding `apps/web`?

### Verdict: **Yes — `lib/client.js` is served at runtime from disk. No `apps/web` rebuild is required to add a client plugin.**

This was verified directly in `packages/client/modules/src/index.ts`, not merely inferred from READMEs.

### 7.1 The node half scans the Loader at runtime and serves per-plugin bundles

Module header, `packages/client/modules/src/index.ts:1-24`:

> Node half of the client module system (`dsh.client` dual-face package): **scans the host Loader's
> entries for packages declaring `dsh.client`, composes the `window.__DSH_BOOT__` entry graph** (wire
> single source: {@link WebBootEntry} in `./client/manifest.ts`) in module-graph order, **serves
> one-or-more-plugin combo scripts plus their source maps**, … and provides the `clientModuleHost`
> service.
>
> Scanning is incremental per package — there is no full-rescan code path. Every cordis
> `internal/plugin` emission (fiber construction/disposal) marks the fiber's entry name dirty; a
> microtask flush reconciles each dirty name against the live loader entries. … **Bundle content
> changes reach the graph only through `ClientModuleRegistry.rebuilt`.**

So the roster is derived from **live Loader entries**, not a build-time constant.

The subscription and initial activation scan, `:547-565`:

```ts
    ctx.on('internal/plugin', (fiber) => {
      ...
      this.dirty.add(entryName)
      if (this.flushQueued) return
      this.flushQueued = true
      ...
    })
    // Activation pass: the initial scan IS the incremental path over the
    // current entries, flushed synchronously ...
    for (const entry of ctx.loader.entries()) this.dirty.add(entry.options.name)
    this.composed = this.compose()
```

The HTTP route, `:570-575`:

```ts
    const registerWebCarrier = (webCtx: Context): void => {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'prefix', path: '/plugins', handler: this.serveBundle }),
        'client-modules: bundle route',
      )
    }
```

Per-plugin URL, `:293` — `/plugins/${record.entry.id}/client.js`.

The bundle bytes are **read from the package's own build output at runtime**:

- `:639-640` — `const bundle = readFileSync(record.meta.clientPath)`
- `:304-311` — `sourceMapSnapshot()` does `readFileSync(`${clientPath}.map`)`, tolerating `ENOENT`
- `:770` — `clientPath: join(dirname(pkgPath), clientRel)`
- `:806` — `path: createRequire(baseUrl).resolve(`${expectedPackageName}/package.json`)`

I.e. the node half resolves each row's package via Node resolution (which reaches the profile's
`node_modules`) and reads the `./client` export target off disk per request.

### 7.2 Confirmed against real third-party plugins installed on this machine

`~/.dsh/profiles/web/package.json` currently contains genuine out-of-tree plugins:

```json
"dependencies": {
  "@dsh-external/dsh-diff-viewer": "github:lehhair/dsh-diff-viewer",
  "dsh-better-sidebar": "^0.19.1",
  "dsh-file-review-tab": "^0.5.0",
  "dsh-plugin-git": "github:CnsMaple/dsh-plugin-git"
},
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
  "@dsh-external/dsh-diff-viewer", "dsh-plugin-git",
  "dsh-better-sidebar", "dsh-file-review-tab" ] } }
```

Three of them ship **browser halves**, and their prebuilt `lib/client.js` files exist on disk in the
exact lazy-CJS factory format. `dsh-better-sidebar/lib/client.js` begins:

```js
window.__ModuleLoader__.load({
	id: "dsh-better-sidebar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
```

`@dsh-external/dsh-diff-viewer/lib/client.js` is identical in shape (709 KB, id
`@dsh-external/dsh-diff-viewer`). Each declares `dsh.client` in `package.json`, e.g. `dsh-plugin-git`:

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right",
               "@deepseek-ai/dsh-client-ui-session",
               "@deepseek-ai/dsh-api-remotes"]
  }
}
```

and its own bundle patch, `dsh-plugin-git/cordis.patch.yml`:

```yaml
# The dsh-plugin-git bundle patch: the Git tab for the right Sidebar.
# One dual-face row owns both halves: the Host mounts the read-only
# `workspaceGit` Remote service …, and the browser roster serves the `git` tab
# type, which mounts its own Remote contribution.
# Install with `dsh plugin --profile web add <this package>`.
- insert:
    - id: plugin-git
      name: 'dsh-plugin-git'
```

These packages were installed by `dsh plugin add` from npm and GitHub and their client halves run in
the browser. **This is empirical proof that a third-party client plugin needs no `apps/web` rebuild.**

### 7.3 The reload signal does not require `dev:web` either

`scripts/dev-web.ts:1-8` (module header, verbatim):

> Watch-build for the web dev loop: rebuilds every artifact the browser reads from a source edit.
> **Reload signaling is not this script's business — the host webserver stat-polls the bundles it
> serves and broadcasts `rebuilt` frames itself (`dsh web`), so any process that rewrites
> `lib/client.js` files triggers reloads**; this script is merely the convenient way to keep them all
> rebuilt on source change.

So the chain is: something rewrites the plugin's `lib/client.js` on disk → the webserver's stat-poll
notices → a `rebuilt` frame goes to the browser → the page re-imports that bundle. `pnpm run dev:web`
is a convenience for *keeping* artifacts rebuilt, not a requirement for the mechanism.

### 7.4 The shell statically links only a tiny baseline — everything else is dynamic

`packages/client/web/src/platform.ts:8-18`:

```ts
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/** Client-bundle specifiers whose factories the parser preloads before the shell starts. */
export const PRELOADED_CLIENT_EXTERNALS = [
] as const
```

This is the complete set of shell-seeded identities a dynamic plugin may `require` without bundling.
It confirms the design intent: feature client plugins are **dynamic rows**, not shell build inputs.
Per `packages/client/AGENTS.md:77`: "**Baseline externals are implicit for every dynamic bundle.** Do
not repeat React, Cordis, `client/store`, `ui-primitives`, `ui-slots`, or `ui-dockkit` in package
manifests."

### 7.5 What actually needs a rebuild — the precise distinction

| Change | Needs `apps/web` rebuild? | Why |
|---|---|---|
| Add a **new** client plugin package + install + row | **No** | New Loader entry → `internal/plugin` → dirty → rescan → `/plugins/<id>/client.js` served from disk |
| Build the plugin's own `lib/client.js` | Yes (the *plugin's* build, not `apps/web`) | The artifact must exist; the registry serves it, never sources |
| Edit the **content** of an existing bundle | Yes, or run `pnpm run dev:web` | "Bundle content changes reach the graph only through `ClientModuleRegistry.rebuilt`" (`modules/src/index.ts:21-22`) |
| Change the web **shell** (`packages/client/web`, `apps/web`) | Yes | Shell is statically built; `PLATFORM_MODULES` seeds shell-side identities |

`packages/client/AGENTS.md:142` states the artifact rule plainly:

> Rebuild the bundle (`pnpm --filter <pkg> bundle`) before probing a live `dsh web` server — **the
> registry serves `lib/client.js`, not sources.**

And `apps/cli/reference/README.md:79` on the HMR path:

> The client-plugin HMR receiver is always mounted and stays idle until a separate `pnpm run dev:web`
> watcher rebuilds client bundles.

### 7.6 The real friction for out-of-repo authors: the build preset is not published

This is the one genuine blocker, and it is documented as a known limitation in
`packages/client/ui-settings-plugins/README.md:96`:

> **A card still needs a browser bundle** — the browser half must be a `dsh.client` package built in
> the client module system's lazy-CJS factory format, and the `clientBundle` preset that emits it lives
> in `../../../packages/client/tsdown.client.ts` **rather than a published package, so a plugin
> outside this repository has to reproduce that build itself.**

So the author must reproduce the factory wrapper (`window.__ModuleLoader__.load({ id, factory })`),
the baseline externals (React, Cordis, `client/store`, `ui-primitives`, `ui-slots`, `ui-dockkit` —
`packages/client/AGENTS.md:75-77`), and `dsh.client.external` requests themselves. The four real
plugins above demonstrate this is reproducible in practice (the diff-viewer uses a plain `tsdown`
build script, `dsh-plugin-git` uses `node build.mjs`).

### 7.7 Related constraint: client plugins must not depend on host-side bundles

`packages/bundle/web-app/cordis.patch.yml:163-168`:

```yaml
    # The client-plugin reload chain, always mounted: it is idle until a
    # rebuild watcher (pnpm run dev:web) actually rewrites client bundles. It
    # is a row rather than a child of web-runtime because its node half is a
    # client-side package, which a host-side bundle cannot import.
    - id: client-hmr
      name: '@deepseek-ai/dsh-client-hmr'
```

---

## 8. Consolidated "how to publish a third-party plugin" recipe

1. **Author a package** with `package.json` declaring
   `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, a `cordis.patch.yml` that `insert`s your
   row (referencing your package by **bare name**), and built entry points.
2. **If you ship a browser half**, add `"dsh": { "client": { "platform": "web", "inject": [...] } }`,
   export `./client`, and build `lib/client.js` in the lazy-CJS factory format yourself.
3. **Build before publishing** — npm publish with `lib/` built, or `pnpm pack` a tarball. A git install
   fetches **sources only**, so you must ship a `prepare` script and the user must allowlist it
   (`publish.md:161-173`):
   ```yaml
   allowBuilds:
     dsh-hello-plugin: true
   ```
   > Treat that allowance as **permission to execute the package's code on your machine at install
   > time**, outside any sandbox the agent runs under. Only allow packages whose source you trust, and
   > pin a commit (`github:you/hello-plugin#<sha>`).
4. **User installs**: `dsh plugin --profile <name> add <spec>` (npm name, `github:owner/repo[#sha]`,
   `./local-dir`, or `.tgz`).
5. **User verifies**: `dsh --profile <name> --dump-config | grep '# == <your-package>'`.
6. **User restarts the profile** — `apps/cli/reference/README.md:67`:
   > The successful pnpm operation changes the Profile manifest and Bundle list on disk; a running
   > Profile keeps the Bundle set from its current start. Restart that Profile after adding, removing,
   > or updating a Bundle. This startup boundary applies to Bundle membership, while ordinary edits to
   > the Profile or home `cordis.patch.yml` take effect through hot reload.

---

## 9. Corrections to premises in the research request

1. **`packages/self-modification/` does not exist.** Only the stale root `AGENTS.md:38` layout line
   mentions it; the live group is `packages/extensions/` (`packages/README.md:63`).
2. **`docs/cordis-primer.md` does not document `$DSH_HOME` or profiles** — it is 45 lines and covers
   only Cordis concepts plus a 3-line Loader Configuration section. Profile/home mechanics live in
   `packages/boot/app-boot/README.md` and `apps/cli/reference/README.md`.
3. **The plugin-inventory UI cannot install anything** — it is read-only by explicit design; there is
   no in-GUI "add plugin" flow. Installation is CLI-only (`dsh plugin`).
4. **Dynamic/self-modifying plugins are not a distribution channel** — they are in-memory and vanish
   on restart, and `tool-cordis` is in no shipped tree.
5. **A client plugin does not need an `apps/web` rebuild** — but it does need its own build step, and
   the repo's `clientBundle` tsdown preset is not published for outside use.
6. **`cordis-client-runner` and `ui-cordis` are under `packages/extensions/`, not `packages/client/`.**
   `packages/extensions/README.md:51` states the reason: they are browser halves of dual-half packages
   in that group.
7. **The tutorial's "the plugin path must be absolute" is over-strict for `insert` rows.** Relative
   `./` and `../` names are converted to `file:` URLs anchored beside the patch file
   (`packages/boot/app-boot/src/index.ts:325-336`). Only `insert` rows get this treatment, and a bare
   name without `./` is treated as a package specifier.
8. **`$DSH_HOME` cannot be set from a `.env` file.** `DSH_*` names are rejected from `.env` layers
   (`packages/boot/app-boot/README.md:54`); it must be exported in the environment.
