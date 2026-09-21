/**
 * Build `dsh-review` into the artifacts a DSH profile loads.
 *
 * Two halves come out of one script:
 *
 * - **Host** (`.`) — plain ESM for Node. Every `@deepseek-ai/*` specifier stays
 *   external because the harness owns those module identities and a second copy
 *   would break Cordis service identity. `zod` is bundled because nothing
 *   guarantees a profile hoists it.
 * - **Client** (`./client`) — the lazy-CJS factory the shell's module loader
 *   expects, `window.__ModuleLoader__.load({ id, factory })`. React, Cordis,
 *   and the client baseline (`client/store`, `ui-primitives`, `ui-slots`,
 *   `ui-dockkit`) arrive through the `require` the loader hands the factory, so
 *   they stay external. The compiled CSS is inlined and injected when the
 *   factory runs, because the loader fetches one script per plugin.
 *
 * esbuild is resolved from the harness checkout rather than from this package,
 * since a plugin outside the repository does not get the repo's build presets.
 * Point `DSH_CHECKOUT` elsewhere to use a different checkout's esbuild.
 */

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const checkout = process.env.DSH_CHECKOUT ?? '/home/fit/00lib/deepseek-harness'

/** The esbuild version the harness vendors; picked explicitly so a stray copy cannot decide the build. */
const ESBUILD_VERSION = process.env.DSH_ESBUILD_VERSION ?? '0.28.1'
const esbuildEntry = join(
  checkout, 'node_modules', '.pnpm', `esbuild@${ESBUILD_VERSION}`, 'node_modules', 'esbuild', 'lib', 'main.js',
)
const esbuild = await import(esbuildEntry).then(mod => mod.default ?? mod)

/**
 * `zod` is bundled rather than left external, because nothing guarantees a
 * profile hoists it and the client bundle cannot request a module-table row it
 * does not own. It resolves from the same checkout as esbuild: a plugin outside
 * the repository installs into a profile that has no reason to carry it.
 */
const ZOD_VERSION = process.env.DSH_ZOD_VERSION ?? '4.4.3'
const zodPath = join(checkout, 'node_modules', '.pnpm', `zod@${ZOD_VERSION}`, 'node_modules', 'zod')

/** Package name, which is also the client bundle's module-table id. */
const PACKAGE = 'dsh-review'

/** Specifiers the harness owns on both planes; a bundled copy would break identity. */
const harnessExternal = ['@deepseek-ai/*']

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'warning',
  legalComments: 'none',
  target: 'node22',
  alias: { zod: zodPath },
}

/** Build the Node-facing host half. */
async function buildHost() {
  await esbuild.build({
    ...shared,
    entryPoints: [join(root, 'src/index.js')],
    outfile: join(root, 'lib/index.js'),
    format: 'esm',
    platform: 'node',
    external: harnessExternal,
  })
}

/**
 * Build the browser half as one lazy-CJS factory.
 *
 * esbuild writes the CSS beside the JavaScript when a bundle imports a CSS
 * module, so the stylesheet is read back and injected by the wrapper instead.
 * @returns {Promise<void>} Resolves when both artifacts are written.
 */
async function buildClient() {
  const outfile = join(root, 'lib/client.js')
  const result = await esbuild.build({
    ...shared,
    entryPoints: [join(root, 'src/client/index.js')],
    outfile,
    format: 'cjs',
    platform: 'browser',
    jsx: 'automatic',
    // The entry imports a `.jsx` module and renders one element itself, so the
    // `.js` loader has to accept JSX too.
    loader: { '.css': 'local-css', '.js': 'jsx' },
    external: [...harnessExternal, 'react', 'react/*', 'react-dom', 'react-dom/*'],
    write: false,
  })
  const javascript = result.outputFiles.find(file => file.path === outfile)
  const stylesheet = result.outputFiles.find(file => file.path.endsWith('.css'))
  if (javascript === undefined) throw new Error(`build: esbuild wrote no ${outfile}`)
  const styles = stylesheet === undefined ? '' : stylesheet.text
  const header = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(PACKAGE)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n`
  const footer = '\n\t\treturn module.exports;\n\t}\n});\n'
  const injected = styles === ''
    ? ''
    : `\t\tvar __style = document.createElement("style");\n`
      + `\t\t__style.setAttribute("data-plugin-css", ${JSON.stringify(`${PACKAGE}/ReviewBody.module.css`)});\n`
      + `\t\t__style.textContent = ${JSON.stringify(styles)};\n`
      + `\t\tdocument.head.appendChild(__style);\n`
  mkdirSync(dirname(outfile), { recursive: true })
  writeFileSync(outfile, header + injected + javascript.text + footer)
  // esbuild's own map describes the unwrapped file; the wrapper shifts no line
  // of the appended text, so the map stays usable for stepping into sources.
  if (javascript.map !== undefined) writeFileSync(`${outfile}.map`, javascript.map)
}

/**
 * Emit `.d.ts` for the two entry points from a hand-written source.
 *
 * The plugin is written in JavaScript, so the declaration is authored rather
 * than generated; it exists so an in-repo consumer could import the service
 * type, and so the package's own tests type-check.
 * @returns {void}
 */
function buildTypes() {
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib/index.d.ts'), readFileSync(join(root, 'types/index.d.ts'), 'utf8'))
}

await buildHost()
await buildClient()
buildTypes()
console.log(`built ${PACKAGE}: lib/index.js, lib/client.js`)
