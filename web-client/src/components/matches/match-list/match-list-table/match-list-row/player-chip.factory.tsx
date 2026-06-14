import type { PlayerChipProps, PlayerChipView } from './player-chip'

/** A present, non-winning opponent named rita.kovac. */
export function buildPlayerChipView(
  overrides: Partial<PlayerChipView> = {},
): PlayerChipView {
  return {
    name: 'rita.kovac',
    isEmpty: false,
    isWinner: false,
    ...overrides,
  }
}

/** Props for `PlayerChip` — a present, non-winning opponent named rita.kovac. */
export function buildPlayerChipProps(
  overrides: Partial<PlayerChipProps> = {},
): PlayerChipProps {
  return {
    chip: buildPlayerChipView(),
    ...overrides,
  }
}
