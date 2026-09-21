/**
 * What the `review` tab type IS.
 *
 * A page, not a viewer: it claims no `dsh-resource://` pattern, so the guide
 * offers it as an entry and it is opened by kind. It contributes no `guide`
 * entry of its own — the shipped composition seeds the default page from the
 * guide entries the registered types contribute, and a second entry would turn
 * the sidebar's default page from Files into the guide.
 */

/** The tab kind this package owns. */
export const REVIEW_KIND = 'review'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const REVIEW_ID = 'dsh-review'

/**
 * The review type's registry definition.
 * @param {object} t - Namespace-bound translate, read fresh on every label call.
 * @returns {object} The definition to register.
 */
export function reviewDefinition(t) {
  return {
    id: REVIEW_ID,
    kind: REVIEW_KIND,
    priority: 'extension',
    title: () => t('type.label'),
  }
}
