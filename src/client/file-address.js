/**
 * The `dsh-resource://file/…` address this tab opens files with.
 *
 * The native right sidebar hands a tab `openResource(address)`, and the address
 * is a URI, not a path with a prefix: the harness's own grammar encodes every id
 * and path segment, so a name holding a space, `#`, `?` or `%` survives the
 * round trip (`packages/util/workspace-path/src/file-address.ts`). Building the
 * string by interpolation instead is only accidentally correct — the parser
 * cuts the address at the first `#` or `?`, so `notes#2.md` opens `notes`, and a
 * stray `%` makes `decodeURIComponent` throw, which leaves the address claimed
 * by no tab type at all.
 *
 * The encoder is local rather than imported from
 * `@deepseek-ai/dsh-util-workspace-path` for the same reason `zod` is bundled
 * into this package's client half: the shell owns the browser module table, and
 * a plugin cannot request a row it does not own. The rules are the harness's,
 * stated once here:
 *
 * - backslashes normalize to `/` and a leading `./` is dropped, so a
 *   Windows-shaped or relative path still names the same file;
 * - each segment is component-encoded, with `:` left literal so a Windows drive
 *   letter reads as written;
 * - an absolute path keeps its leading empty segment
 *   (`…/session/s//etc/hosts`), which is how the grammar spells one.
 */

/** The scheme and type every file address opens with. */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/**
 * Component-encode one id or path segment, keeping `:` literal for drive letters.
 * @param {string} segment - One `/`-separated piece of an id or path.
 * @returns {string} The encoded segment.
 */
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/**
 * The address of a file read through one Session.
 * @param {string} sessionId - The Session whose workspace resolves the path.
 * @param {string} path - Workspace-relative or absolute path, `/`-separated.
 * @returns {string} The `dsh-resource://file/session/<sessionId>/<path>` address.
 */
export function sessionFileAddress(sessionId, path) {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  const encoded = normalized.split('/').map(encodeSegment).join('/')
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encoded}`
}

export default sessionFileAddress
