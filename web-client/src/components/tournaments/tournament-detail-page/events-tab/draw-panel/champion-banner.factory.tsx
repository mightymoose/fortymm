import type { ChampionBannerProps } from './champion-banner'

/** Props for `ChampionBanner`: a named champion with a panel-supplied test id. */
export function buildChampionBannerProps(
  overrides: Partial<ChampionBannerProps> = {},
): ChampionBannerProps {
  return { name: 'player.1', testId: 'champion-callout', ...overrides }
}
