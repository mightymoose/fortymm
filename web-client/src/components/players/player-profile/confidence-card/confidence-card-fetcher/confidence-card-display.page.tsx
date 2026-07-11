import { render, screen, type Container } from '@/test/utilities'

import {
  ConfidenceCardDisplay,
  type ConfidenceCardDisplayProps,
} from './confidence-card-display'
import { buildConfidenceCardDisplayProps } from './confidence-card-display.factory'

/** Match any element carrying `className`, whatever its text — the level word and
 * the copy both vary. */
const byClass = (className: string) => (_: string, el: Element | null) =>
  el?.classList.contains(className) ?? false

const scoped = (container: Container) => ({
  /** The card itself, named by its "Rating confidence" heading. Absent entirely
   * for a player with no rating — `queryConfidenceCard()` is how you prove that. */
  getConfidenceCard() {
    return container.getByRole('region', { name: 'Rating confidence' })
  },
  queryConfidenceCard() {
    return container.queryByRole('region', { name: 'Rating confidence' })
  },
  findConfidenceCard() {
    return container.findByRole('region', { name: 'Rating confidence' })
  },
  /** The level, in words: "Provisional" / "Firming up" / "Settled". */
  getConfidenceLevel() {
    return container.getByText(byClass('confidence-card__level'))
  },
  /** The one-line explanation — the viewer-aware sentence. Second person on your
   * own profile, third on anyone else's. */
  getConfidenceExplanation() {
    return container.getByText(byClass('confidence-card__explanation'))
  },
  findConfidenceExplanation() {
    return container.findByText(byClass('confidence-card__explanation'))
  },
  /** The 95% interval, ON THE CARD'S FACE: "We think they're somewhere between
   * 1551 and 1823." */
  getConfidenceInterval() {
    return container.getByText(byClass('confidence-card__interval'))
  },
  /** The collapsed `<details>` drawer holding the Glicko-2 internals. */
  getConfidenceDrawer() {
    return container
      .getByText('The numbers behind it')
      .closest('details') as HTMLDetailsElement
  },
  /** The `<dd>` for one drawer row — `queryConfidenceDetail('Deviation (RD)')`.
   * Returns the *value*; its `closest('details')` proves it is in the drawer and
   * not on the face. */
  queryConfidenceDetail(label: string) {
    const term = container.queryByText(label)
    return term?.parentElement?.querySelector('dd') ?? null
  },
})

/**
 * Test page-object for `ConfidenceCardDisplay` — the pure view-in, DOM-out card.
 *
 * Every accessor is confidence-prefixed so the composed profile page object can
 * spread it alongside the hero's, the rating panel's, the Career card's and the
 * Recent-matches card's without a collision.
 */
export const confidenceCardDisplayPage = {
  render(overrides: Partial<ConfidenceCardDisplayProps> = {}) {
    render(
      <ConfidenceCardDisplay {...buildConfidenceCardDisplayProps(overrides)} />,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
