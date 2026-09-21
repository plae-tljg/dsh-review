# What this is built on, and what it references

`dsh-review` is not developed in a vacuum: it is written against the DeepSeek
Harness plugin contracts and it borrows a per-round derivation and a visual
language from other open-source projects. This page states exactly which
versions, APIs and repositories it depends on, so the design can be audited and
re-derived.

## 1. The platform it develops upon

| Thing | Version / location | Role |
|---|---|---|
| DeepSeek Harness | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness), pinned to **0.1.5-rc.2** | the host and browser this plugin plugs into |
| Cordis | `@deepseek-ai/cordis` (harness-vendored) | the plugin/service runtime (`ctx.plugin`, `ctx.effect`, `inject`, `ctx.provide`) |
| Typert Remote protocol | `@deepseek-ai/dsh-typert-protocol` | the client⇄host RPC surface (`@Remote`, `TypertRemoteService`) |
| Native right sidebar | `packages/client/ui-sidebar-right` | the `sidebarRightTabs` registry + `sidebar.right.pane.tab` slot this tab registers in |
| Reference native tab | `packages/client/ui-sidebar-files` | the copy-paste template for a native tab (definition, exclusive store factory, inject face, locales, build) |
| File Remote service | `packages/api/workspace-files` | the model for a Host service with a browser face and a hand-written Typert artifact |
| Diff primitive | `packages/client/ui-primitives` (`DiffBlock`, `diffTotals`) | the shared red/green body and `+A -R` footer; a baseline external, so no dependency declaration is needed |
| Plugin distribution | `apps/cli` (`dsh plugin --profile <name> add …`) + `packages/boot/app-boot` | how a profile installs a bundle via its `cordis.patch.yml` |

The exact registration contract — stage-one `ctx.sidebarRightTabs.register({ id,
kind, title, guide? })`, stage-two `ctx.slots.register({ name:
'sidebar.right.pane.tab', key: <id>, store, inject }, Body)`, the `dsh.client`
manifest rules, and the `/plugins/<id>/client.js` serving path — is captured with
file:line citations in
[docs/research/dsh-right-sidebar-tab-plugin-report.md](research/dsh-right-sidebar-tab-plugin-report.md).

The Remote namespace mechanics (the Typert generator, the `ctx.remote.$mount()`
escape hatch, the `api-remotes` mount trap) are captured in
[docs/research/adding-a-remote-namespace.md](research/adding-a-remote-namespace.md).

Third-party/local distribution (bundle + profile, the `dsh plugin` CLI, the
`~/.dsh/profiles` resolution walk) is captured in
[docs/research/dsh-plugin-distribution.md](research/dsh-plugin-distribution.md).

## 2. Code references (and what was taken)

### dsh-file-review-tab — per-round derivation (ported)

- Repo: [`Lzh3070/dsh-file-review-tab`](https://github.com/Lzh3070/dsh-file-review-tab), MIT, © ZhangWenChao.
- Upstream of its diff/review engine: [`left0ver/dsh-file-review`](https://github.com/left0ver/dsh-file-review), MIT, © ZhangWenChao.
- Taken: the client-side round derivation in [`src/client/rounds.js`](../src/client/rounds.js) —
  `callIntent` / `appliedDiffs` (the `write` / `edit` / `str_replace_editor`
  vocabulary), `deletedPathsFromCommand` (literal `rm`-family deletions),
  `normalizeSnapshot` (the `views.get('chat').legacy` compatibility slice), and
  `turnAttribution` (mapping a tool-result `seq` onto its round). Also the
  `UnifiedDiff` idea of expanding a `{ oldText, newText }` hunk into numbered
  lines, reimplemented here without the `diff` dependency.
- Not taken: undo/reapply (`fileReview/apply`), the chat turn-tail row, archival,
  and the Host-side Code Mode recorder.

### dsh-better-sidebar — panel registration API

- Repo: [`omdsh-dev/DSH-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar), MIT, © dsh-external.
- Taken: the documented `ctx.betterSidebar.registerTab(descriptor)` contract and
  the `{ ctx, store, scope, tab, visible }` component props, used by
  [`src/client/panel.jsx`](../src/client/panel.jsx). It is **not** value-imported;
  the bridge only talks to the provided service, and the store is observed with
  `useSyncExternalStore` because that panel supplies no reactive store hook.

### opencode — visual reference

- Repo: [`anomalyco/opencode`](https://github.com/anomalyco/opencode), MIT, © 2025 opencode.
- Visual reference: the web GUI's right-hand **review panel** (the "Files
  Changed / Git changes" tree with red/green diff).
- Specifically mirrored:
  - `packages/ui/src/v2/components/file-tree-v2.css` — the 28px row, 6px
    radius, 6px gaps, hover/selected overlays, rotating chevron, the 16×16
    uppercase change badge with per-state colours, and the tabular-figure counts.
  - `packages/session-ui/src/v2/components/session-review-v2.css` — the
    sidebar/preview split, header and filter spacing, and the file-header
    typography (13px file name, muted path).
  - `packages/app/src/pages/session/v2/review-panel-v2.tsx` — the panel's
    composition (sidebar tree + stats + preview) that
    [`src/client/ReviewBody.jsx`](../src/client/ReviewBody.jsx) follows.
- Adapted to the DSH theme: opencode's `--v2-*` tokens are replaced by the
  harness's `--dsw-alias-*` aliases, so the panel follows the active DSH theme.

### dsh-diff-viewer — diff styling reference

- Repo: [`lehhair/dsh-diff-viewer`](https://github.com/lehhair/dsh-diff-viewer).
- Reference only: its PiUI-style unified diff (gutter pair, change bars,
  word-level marks) informed the red/green body. No code is shared.

## 3. Visual reference

The target the UI is measured against is opencode's right-side review panel: a
narrow folder tree with per-file change letters on the left, the selected file's
red/green unified diff on the right, and a `+A -R` total in the header. The
screenshot the design was derived from shows `Files Changed 3`, `Git changes +6
-0`, a filter field, and a `testing/` folder that folds. `dsh-review` reproduces
that shape inside the DeepSeek Harness right sidebar and its `dsh-better-sidebar`
panel, and adds the per-round source that opencode does not have.

## 4. Research reports shipped with this plugin

| File | What it establishes |
|---|---|
| [research/dsh-right-sidebar-tab-plugin-report.md](research/dsh-right-sidebar-tab-plugin-report.md) | How a right-sidebar tab plugin is built: the two registrations, the four slots, the store contract, i18n, the build preset, and the out-of-package surfaces. |
| [research/adding-a-remote-namespace.md](research/adding-a-remote-namespace.md) | How a client⇄host Remote namespace is declared, generated, mounted and consumed, including the `api-remotes` mount trap. |
| [research/dsh-plugin-distribution.md](research/dsh-plugin-distribution.md) | How third-party plugins are distributed and installed (bundle + profile, `dsh plugin`, `$DSH_HOME`/profile resolution, no `apps/web` rebuild). |

These reports contain verbatim `file:line` citations against the 0.1.5-rc.2
checkout at the time they were written; they are kept as the derivation record
for the contracts encoded in `src/`.
