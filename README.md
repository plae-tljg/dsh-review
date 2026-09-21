# dsh-review

An opencode-style **Review** panel for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI's right sidebar. One plugin owns both ends of its data path — a read-only `git` service on the Host and a `review` tab in the browser — and shows the session workspace two ways:

- **Uncommitted** — the working tree against `HEAD`, as a directory tree of every changed file, with per-file `+added`/`-removed`, the branch's grand total, and the selected file's unified diff in red/green.
- **Rounds** — what the agent changed in each conversation round, derived from the live conversation snapshot, shown with the same tree and the same diff body.

```
┌ 审阅 ────────────────────────────────────────────────────────┐
│  [ 未提交 | 按轮次 ]   main ↑1              +42 -7        ⟳   │
├──────────────────────┬───────────────────────────────────────┤
│ ▾ src/        +42 -5 │ @@ -14,7 +14,9 @@ export function r…  │
│   ▾ api/      +8 -2  │   14  14   const rows = parse(input)  │
│     M api.ts  +8 -2  │   15     -  return rows.map(r=>r.id)  │
│   ▸ new/     +30 -0  │        15 +  return rows.map(r=>r.key)│
│ ▾ old/legacy/  +0 -5 │   16  16 }                            │
│ M renamed.ts   +4 -0 │                                       │
│ U notes.md    +30 -0 │                                       │
└──────────────────────┴───────────────────────────────────────┘
```

The look is a deliberate port of **opencode's** right-hand review panel (see [docs/REFERENCES.md](docs/REFERENCES.md)): 28px tree rows with a 6px radius and whole-row hover/selection, a rotating chevron, 16px file and folder glyphs, an uppercase change letter in the theme's state colour, tabular-figure counts, and a segmented source switch.

## What it does

- **A directory tree, not a flat list.** Files group under folders, each folder row carries the totals for everything below it, and a chain of single-child directories is folded into one row (`src/client/`) — the same shape opencode's review pane uses. Root-level files sit beside the tree.
- **Every uncommitted change**, staged, unstaged and untracked, from `git status --porcelain=v1 -z`.
- **Per-file counts** from `git diff --numstat -z`, with a binary change marked `bin` rather than `+0 -0`, plus the **grand total** across the report.
- **A real unified diff**, parsed on the Host into hunks: context lines appear once, additions and deletions each carry their own gutter number, and every hunk opens with its `@@ -a,b +c,d @@` coordinates.
- **Per-round changes**, derived client-side from the conversation snapshot: each round's tool calls (`write` / `edit` / `str_replace_editor`, and Code Mode `run_code` sub-calls) are folded into the files they touched, and `rm`-family deletions are kept as display-only rows.
- **Renames resolve as renames.** The status listing is read for the source path and both names are diffed; a pure rename reports "no text" rather than a whole-file addition.
- **Untracked files** are rendered by `git diff --no-index` against the null device, so Git itself decides the encoding, the binary case and the hunk header.
- **Path-safe.** Paths reach Git as bare repository-relative pathspecs under `--literal-pathspecs`, single-quoted for the shell, so a name holding a space, a `*`, a quote or a newline round-trips exactly.
- **Nothing writes.** Every invocation is a read; `GIT_OPTIONAL_LOCKS=0` keeps a refresh from taking an index lock a concurrent Agent operation might want.

## Install

```sh
dsh plugin --profile web add dsh-review
# or, from a checkout:
dsh plugin --profile web add /path/to/dsh-review
# or straight from this repository:
dsh plugin --profile web add github:plae-tljg/dsh-review
```

The built artifacts are committed under `lib/`, so a git install needs no build step. Restart the harness (`dsweb`), then open the right panel's **+** menu → **审阅**. The tab registers both in the native right sidebar and in [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) when that plugin is present.

For development against a checkout, symlink the package into a profile's `node_modules` (which keeps rebuilds instant) and rebuild only the browser half:

```sh
ln -sfn /path/to/dsh-review ~/.dsh/profiles/web/node_modules/dsh-review
node build/build.mjs
```

A page refresh is enough to pick up a client rebuild; the Host half needs a restart.

## Build

```sh
node build/build.mjs
```

The build resolves `esbuild` and `zod` from a harness checkout rather than from this package, because the `clientBundle` tsdown preset that emits the browser format lives inside the repository and is not published. Override the checkout with `DSH_CHECKOUT=/path/to/deepseek-harness`.

Two artifacts come out:

| Artifact | Plane | Format |
|---|---|---|
| `lib/index.js` | Host (Node) | ESM; every `@deepseek-ai/*` specifier external, `zod` bundled |
| `lib/client.js` | Browser | the shell's lazy-CJS factory, `window.__ModuleLoader__.load({ id, factory })`, with the compiled CSS inlined and injected on materialization |
| `lib/typert.host.js` | Host | the hand-maintained Typert wire manifest |

## Test

```sh
npm test
```

`tests/parse.test.mjs` runs the Host parsers over recorded `git` output; `tests/rounds.test.mjs` drives the round derivation against a hand-built snapshot; `tests/face.test.mjs` covers the deadline-guarded reads; `tests/client-wiring.test.mjs` loads `lib/client.js` in a VM and asserts every registration; `tests/render.test.mjs` renders the tree and both sources through `react-dom/server`.

## Architecture

```
src/index.js               Host plugin entry: re-exports the service
src/host/review.js         WorkspaceReview — the `workspaceReview` Remote service (git reads)
src/host/unified.js        unified-diff, --numstat, status and tree parsers
src/client/index.js        Browser entry: mount, native, and panel children
src/client/remote.js       the client Remote contribution: codecs + namespace merges
src/client/definition.js   the `review` tab type
src/client/face.js         async reads; deadline-guarded, generation-guarded
src/client/store.js        per-tab view state (report, diffs, source, selection)
src/client/ReviewBody.jsx  the source switch, the tree, and both diff renderers
src/client/rounds.js       per-round derivation ported from dsh-file-review-tab
src/client/panel.jsx       the dsh-better-sidebar bridge (store subscription + hooks)
lib/typert.host.js         hand-maintained Typert host manifest
types/                     hand-written declarations and type-only augmentations
docs/                      references and the design research this was built from
```

**Three client children, not one.** Cordis guards namespace access, and one absent optional service must not stall the rest: the *mount* child mounts the Remote contribution and registers dictionaries, the *ui* child registers the native `sidebar.right.pane.tab`, and the *panel* child registers into `dsh-better-sidebar` — injecting `betterSidebar` so it waits for that service instead of racing it with `ctx.get`.

**No core assembly is touched.** A Remote namespace normally has to be value-imported and mounted by `packages/api/remotes`; this plugin instead calls `ctx.remote.$mount()` itself, the documented escape hatch for a contribution that does not use a generated artifact.

## Configuration

Deployment caps are the service's Cordis config:

```yaml
- id: review
  name: 'dsh-review'
  config:
    maxDiffBytes: 2097152     # largest patch that crosses the wire; larger arrives cut
    maxStatusEntries: 5000    # cap on reported files; the rest is reported cut
```

## Known limitations

- **Uncommitted list is memory-only and unrefreshed.** It reads when the tab mounts and when you press ⟳; there is no filesystem watch. The Rounds view follows the conversation live.
- **Code Mode (`run_code`) nested edits** are derived from the snapshot; the Host-side before/after recorder from the reference plugin is not ported, so an edge case that does not survive into the snapshot is not recovered.
- **Desktop split only.** The list and the diff sit side by side above 520px and stack below it; there is no draggable divider.
- **No word-level highlighting** and **no line comments** (opencode's inline-comment affordance is not ported).
- **Mode-only changes state no body** — a permission change appears with its counts and reads "no text".

## References

What this was developed on and against, and every project it borrows from, is catalogued in [docs/REFERENCES.md](docs/REFERENCES.md), with the full contract research under [docs/research/](docs/research/).

## License

[MIT](LICENSE). Portions are ported from MIT-licensed projects; see [LICENSE](LICENSE) for the attributions.
