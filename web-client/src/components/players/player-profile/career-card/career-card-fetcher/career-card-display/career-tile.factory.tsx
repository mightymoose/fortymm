import type { CareerTileView } from '../career-card-query'
import type { CareerTileProps } from './career-tile'

/** The best streak a player has put together. */
export function buildCareerTileView(
  overrides: Partial<CareerTileView> = {},
): CareerTileView {
  return { label: 'Best streak', value: '7 wins', ...overrides }
}

/** The share of individual games taken across the decided matches — already
 * formatted as a percentage by the projection. */
export function buildGamesWonTileView(
  overrides: Partial<CareerTileView> = {},
): CareerTileView {
  return buildCareerTileView({
    label: 'Games won',
    value: '58.2%',
    ...overrides,
  })
}

export function buildCareerTileProps(
  overrides: Partial<CareerTileProps> = {},
): CareerTileProps {
  return { tile: buildCareerTileView(), ...overrides }
}
