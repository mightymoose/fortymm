import type { Player } from '@/api/matches'

import type { OpponentOptionProps } from './opponent-option'

/** A registered, unrated player — the default option subject. */
export function buildOptionPlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 'pl-1',
    username: 'ada.lovelace',
    rating: null,
    ...overrides,
  }
}

/** Props for `OpponentOption`: an inactive option for the default player, with
 *  no-op handlers. */
export function buildOpponentOptionProps(
  overrides: Partial<OpponentOptionProps> = {},
): OpponentOptionProps {
  return {
    id: 'opt-0',
    player: buildOptionPlayer(),
    active: false,
    onPick: () => {},
    onHover: () => {},
    ...overrides,
  }
}
