import { render, screen, type Container } from '@/test/utilities'

import {
  RatingPanelDisplay,
  type RatingPanelDisplayProps,
} from './rating-panel-display'
import { buildRatingPanelDisplayProps } from './rating-panel-display.factory'
import { formChipsPage } from './rating-panel-display/form-chips.page'

/** Match any element carrying `className`, whatever its text — the rating chip
 * reads "1687" or "Unrated", and the Δ chip "+12" or "-8". */
const byClass = (className: string) => (_: string, el: Element | null) =>
  el?.classList.contains(className) ?? false

const scoped = (container: Container) => ({
  /** The standing card's `<section>`, named by its "FortyMM Rating" heading. */
  getCard() {
    return container.getByRole('region', { name: 'FortyMM Rating' })
  },
  /** The big rating figure — or the word "Unrated" for a player who has never
   * finished a rated match. */
  getRating() {
    return container.getByText(byClass('player-profile__hero-rating-chip'))
  },
  /** The Δ chip. Absent — never "+0" — when the player has no rated match to
   * have moved their rating. */
  queryDelta() {
    return container.queryByText(byClass('player-profile__delta'))
  },
  /** A standing line by its label ("Rank" / "Peak" / "Percentile"); `null` when
   * the player has no such line. */
  queryStat(label: string): HTMLElement | null {
    const key = container.queryByText(label, {
      selector: '.player-profile__stat-k',
    })
    const value = key
      ?.closest('.player-profile__stat')
      ?.querySelector('.player-profile__stat-v')
    return (value as HTMLElement | undefined) ?? null
  },
  /** The run of form chips (`getChips()`, `getForm()`) from its own page
   * object. */
  ...formChipsPage.within(container),
})

/**
 * Test page-object for `RatingPanelDisplay` — the pure view-in, DOM-out standing
 * card. Stats are told apart by their label, the way a reader does.
 */
export const ratingPanelDisplayPage = {
  render(overrides: Partial<RatingPanelDisplayProps> = {}) {
    const props = buildRatingPanelDisplayProps(overrides)
    render(<RatingPanelDisplay {...props} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
