/**
 * Browser half: register the `review` tab in both right-sidebar compositions,
 * and mount this package's own `workspaceReview` Remote contribution.
 *
 * The plugin owns both ends of its data path: the Host row mounts the
 * `WorkspaceReview` service, and this module mounts the client contribution, so
 * the typed `remote.workspaceReview` face exists without any core assembly
 * knowing about this package.
 *
 * Three children, each with its own injection so one absent service cannot
 * stall the others:
 *
 * - **mount** mounts the Remote contribution and registers the dictionaries.
 *   `uiConversation` is read lazily rather than injected, so a release that
 *   spells the service differently degrades the Rounds view to unavailable
 *   instead of hanging activation.
 * - **ui** registers the native `sidebar.right.pane.tab` type and body.
 * - **panel** registers the same tab into `dsh-better-sidebar` when that plugin
 *   is present. It injects `betterSidebar` — the documented way to wait for the
 *   service — instead of reading it with `ctx.get` at apply time, which races
 *   the panel's own activation.
 */

import TYPERT_REMOTE from './remote.js'
import { REVIEW_ID, reviewDefinition } from './definition.js'
import { reviewFace } from './face.js'
import { sessionFileAddress } from './file-address.js'
import { ReviewBody } from './ReviewBody.jsx'
import { REVIEW_PANEL_ID, ReviewPanelBody } from './panel.jsx'
import { createReviewStore } from './store.js'
import { en, zh } from './locales.js'

/** This package's copy namespace. */
const NS = 'sidebarReview'

/**
 * Mount child: the one place this package calls `$mount`, plus the one place
 * the dictionaries are registered (a second register of the same namespace
 * would throw).
 * @param {object} ctx - Client context carrying the Remote carrier and locale.
 */
function mountApply(ctx) {
  ctx.effect(() => ctx.remote.$mount(TYPERT_REMOTE), 'dsh-review: workspaceReview remote')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-review: dictionaries')
}

/**
 * A lazy reader for the live `uiConversation` service.
 * @param {object} ctx - Client context.
 * @returns {Function} A function returning the service, or undefined.
 */
function conversationReader(ctx) {
  return () => ctx.get('uiConversation')
}

/**
 * Native UI child: register the tab type, then its body in the native seat.
 * @param {object} ctx - Client context carrying the registry, slots, and Remote face.
 */
function uiApply(ctx) {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(reviewDefinition(t)), 'dsh-review: review type')

  // The factory, not a handle: the registration is exclusive, so the framework
  // mints one instance per session and the tab's state is bucketed by tab id.
  const store = createReviewStore()
  const inject = reviewFace(ctx.remote, conversationReader(ctx))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: REVIEW_ID, locale: NS, store, inject },
    ReviewBody,
  )), 'dsh-review: review tab body')
}

/**
 * Panel child: register the same tab into `dsh-better-sidebar`.
 *
 * The panel keeps its own registry and its own store, so it hands the
 * component `{ store, scope, tab, visible }` instead of the native seat's
 * framework hooks; `ReviewPanelBody` bridges that to the shared body.
 * @param {object} ctx - Client context carrying the `betterSidebar` service.
 */
function panelApply(ctx) {
  const t = ctx.locale.bind(NS)
  const store = createReviewStore()
  const face = reviewFace(ctx.remote, conversationReader(ctx))
  const panel = ctx.betterSidebar
  ctx.effect(() => panel.registerTab({
    id: REVIEW_PANEL_ID,
    title: () => t('type.label'),
    description: () => t('guide.description'),
    order: 30,
    single: true,
    component: (props) => {
      // Two openers exist for a file, and the panel's own is not always usable.
      //
      // better-sidebar opens a file through its built-in `editor` tab, and its
      // `openTab` refuses a disabled type with nothing but a console warning —
      // so with that tab switched off in the side card settings, this action
      // would be a button that silently does nothing. The column's own
      // `openResource` is not gated that way, so it is tried when the panel's
      // opener is switched off, and only if that too is unavailable does the
      // body state the reason instead of offering a dead button.
      const opener = props.onOpenFile
      const editorOff = typeof panel.isTabEnabled === 'function' && panel.isTabEnabled('editor') === false
      /** The DSH right column, read lazily: a harness without it must not stall this child. */
      const column = ctx.get('sidebarRight')
      const columnOpen = column === undefined || typeof column.openResource !== 'function'
        ? undefined
        : (path) => {
          try {
            column.openResource(sessionFileAddress(props.scope.sessionId, path))
            return true
          } catch (error) {
            // Nothing to draw into (no seat mounted): the panel's opener is the
            // fallback, and the browser console keeps the reason.
            console.warn('dsh-review: the right column refused the file address', error)
            return false
          }
        }
      const panelOpen = (path) => { panel.openFile(props.scope, path) }
      const open = opener ?? (editorOff
        ? (path) => { if (columnOpen?.(path) !== true) panelOpen(path) }
        : panelOpen)
      return (
        <ReviewPanelBody
          panel={props.store}
          scope={props.scope}
          tab={props.tab}
          face={face}
          store={store}
          t={t}
          openFile={open}
          openBlocked={opener === undefined && columnOpen === undefined && editorOff}
        />
      )
    },
  }), 'dsh-review: panel tab')
}

/**
 * Client plugin body: compose the mount, native, and panel children.
 * @param {object} ctx - Client root context.
 */
export function apply(ctx) {
  ctx.plugin({ name: 'dsh-review/mount', inject: ['remote', 'locale'], apply: mountApply })
  ctx.plugin({
    name: 'dsh-review/ui',
    inject: ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceReview'],
    apply: uiApply,
  })
  ctx.plugin({
    name: 'dsh-review/panel',
    inject: ['locale', 'remote', 'remote.workspaceReview', 'betterSidebar'],
    apply: panelApply,
  })
}
