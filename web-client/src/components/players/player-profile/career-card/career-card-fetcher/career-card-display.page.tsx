import { render, screen, type Container } from '@/test/utilities'

import {
  CareerCardDisplay,
  type CareerCardDisplayProps,
} from './career-card-display'
import { buildCareerCardDisplayProps } from './career-card-display.factory'
import { careerTilePage } from './career-card-display/career-tile.page'
import { winRateRingPage } from './career-card-display/win-rate-ring.page'

/** Match any element carrying `className`, whatever its text — the streak pill
 * reads "On a 2-win streak" or "No current streak". */
const byClass = (className: string) => (_: string, el: Element | null) =>
  el?.classList.contains(className) ?? false

const scoped = (container: Container) => ({
  /** The card itself, named by its "Career" heading. */
  getCareerCard() {
    return container.getByRole('region', { name: 'Career' })
  },
  /**
   * The card's total — "35 decided · 2 leagues".
   *
   * Deliberately NOT the same number as the Recent-matches card's "View all N
   * matches" link: that one counts the all-inclusive history (ADR-0915). A test
   * that asserts on this must be reading the *decided* count.
   */
  getCareerTotal() {
    return container.getByText(byClass('career-card__total'))
  },
  /** The lifetime record, "24 W · 11 L". */
  getCareerRecord() {
    return container.getByText(byClass('career-card__record'))
  },
  /** The current-streak pill. Reads "No current streak" — never a zero — for a
   * player with no run going. */
  getCareerStreak() {
    return container.getByText(byClass('career-card__streak'))
  },
  /** The ring (`getRing`, `getRingFigure`, `queryRingArc`) and the tiles
   * (`queryCareerTile(label)`) from their own page objects. */
  ...winRateRingPage.within(container),
  ...careerTilePage.within(container),
})

/**
 * Test page-object for `CareerCardDisplay` — the pure view-in, DOM-out card.
 * Every accessor is career-prefixed so the composed profile page object can
 * spread it alongside the hero's, the rating panel's and the Recent-matches
 * card's without a collision.
 */
export const careerCardDisplayPage = {
  render(overrides: Partial<CareerCardDisplayProps> = {}) {
    render(<CareerCardDisplay {...buildCareerCardDisplayProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
