import { buildFormChipsView } from './rating-panel-display/form-chips.factory'
import type { RatingPanelDisplayProps } from './rating-panel-display'
import type {
  RatingDeltaView,
  RatingPanelView,
  StandingStatView,
} from './rating-panel-query'

/** A gain from the player's most recent rated match. */
export function buildRatingDeltaView(
  overrides: Partial<RatingDeltaView> = {},
): RatingDeltaView {
  return {
    label: '+12',
    ariaLabel: 'Gained 12 rating',
    tone: 'win',
    ...overrides,
  }
}

export function buildStandingStatView(
  overrides: Partial<StandingStatView> = {},
): StandingStatView {
  return { label: 'Rank', value: '#3 of 42', ...overrides }
}

/** The standing of a rated player: a rating, a recent gain, a rank on a
 * 42-strong ladder, a peak, and ten results of form. */
export function buildRatingPanelView(
  overrides: Partial<RatingPanelView> = {},
): RatingPanelView {
  return {
    rating: 1687,
    delta: buildRatingDeltaView(),
    stats: [
      buildStandingStatView(),
      buildStandingStatView({ label: 'Peak', value: '1712' }),
    ],
    form: buildFormChipsView(),
    ...overrides,
  }
}

/**
 * The standing of a player who has never finished a rated match: no rating, and
 * therefore no rank, no peak and no delta. They may still have form — that
 * counts decided matches, rated or not.
 */
export function buildUnratedRatingPanelView(
  overrides: Partial<RatingPanelView> = {},
): RatingPanelView {
  return buildRatingPanelView({
    rating: null,
    delta: null,
    stats: [],
    ...overrides,
  })
}

/** Props for `RatingPanelDisplay`. */
export function buildRatingPanelDisplayProps(
  overrides: Partial<RatingPanelDisplayProps> = {},
): RatingPanelDisplayProps {
  return { standing: buildRatingPanelView(), ...overrides }
}
