import { render, screen, within, type Container } from '@/test/utilities'

import { DrawPreview, type DrawPreviewProps } from './draw-preview'
import { buildDrawPreviewProps } from './draw-preview.factory'
import { poolCardPage } from './draw-preview/pool-card.page'

const scoped = (container: Container) => {
  const getPoolList = () =>
    container.getByRole('list', { name: 'Projected pools' })
  const getPoolCards = () =>
    within(getPoolList()).queryAllByTestId('draw-preview-pool-card')

  return {
    /** The preview panel. */
    getPreview() {
      return container.getByTestId('draw-preview')
    },
    /** Every preview panel in scope. There is exactly one verdict on the tab, so a
     * caller asserting "one" is asserting the design rule, not counting markup. */
    queryAllPreviews() {
      return container.queryAllByTestId('draw-preview')
    },
    /** The one-line verdict — `Ready to save`, `Your numbers disagree`,
     * `This draw can’t work yet`. */
    getVerdict() {
      return container.getByTestId('draw-preview-verdict')
    },
    /** The badge beside it — `Sound`, `Your call`, `Impossible`. Read as TEXT: the tint
     * is the second signal, never the only one. */
    getBadge() {
      return container.getByTestId('draw-preview-badge')
    },
    /** `{field} players ÷ {count} pools = {size} per pool`. */
    getEquation() {
      return container.getByTestId('draw-preview-equation')
    },
    /** The pool-card group. Named, so a screen reader can introduce it before reading
     * eight identically-shaped cards. */
    getPoolList,
    /** Every pool card, **in the order it renders** — the claim that the cards read
     * A, B, C, …, which no letter-addressed accessor can state. */
    getPoolCards,
    /** Every card's pool name, **in the order it renders** — `Pool A`, `Pool B`, …
     * The one claim a letter-addressed accessor cannot make. */
    getPoolNames(): string[] {
      return getPoolCards().map(
        (card) => (card.textContent ?? '').match(/Pool [A-Z]+/)?.[0] ?? '',
      )
    },
    /** One pool's card, addressed by its letter. Returns the card's own accessors
     * (`poolCardPage`), scoped to it — with `getCard` re-bound to the card itself,
     * since `within` searches a node's descendants and not the node. */
    pool(letter: string) {
      const card = getPoolCards().find((node) =>
        (node.textContent ?? '').includes(`Pool ${letter}`),
      )
      if (!card) throw new Error(`No preview card for Pool ${letter}`)
      return { ...poolCardPage.within(within(card)), getCard: () => card }
    },
    /** The knockout card: bracket size, byes and the pool-match total. */
    getKnockout() {
      return container.getByTestId('draw-preview-knockout')
    },
    /** One of the three facts under the picture, addressed by its term. Returns the
     * value beside it. */
    getFact(term: string) {
      const dt = container.getByText(term, { selector: 'dt' })
      const value = dt.nextElementSibling
      if (!(value instanceof HTMLElement)) {
        throw new Error(`No value beside the "${term}" fact`)
      }
      return value
    },
    /** The closing line about when entrants are placed. */
    getFoot() {
      return container.getByTestId('draw-preview-foot')
    },
    /** The polite live region the derived numbers sit in, so a recompute is announced
     * rather than silently swapped. */
    getLiveRegion() {
      return container.getByRole('status')
    },
    /** Any link out of the preview. The reference's `Preview cut-time assignment →`
     * belongs to #1324, so there must be none. */
    queryAllLinks() {
      return container.queryAllByRole('link')
    },
  }
}

/** Test page-object for `DrawPreview`, the Draw structure tab's live preview. Build a
 * state with `buildDrawPreviewPropsFor` (the eight derivation inputs) and pass it to
 * `render`, rather than hand-writing a `DrawStructure` the arithmetic never produces. */
export const drawPreviewPage = {
  render(overrides: Partial<DrawPreviewProps> = {}) {
    render(<DrawPreview {...buildDrawPreviewProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
