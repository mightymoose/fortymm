import { buildPlayer } from '@/mocks/factories/players/player.factory'

import type { OpponentOptionProps } from './opponent-option'

/** Props for `OpponentOption`: an inactive option for the default (registered,
 *  unrated) player, with no-op handlers. */
export function buildOpponentOptionProps(
  overrides: Partial<OpponentOptionProps> = {},
): OpponentOptionProps {
  return {
    id: 'opt-0',
    player: buildPlayer(),
    active: false,
    onPick: () => {},
    onHover: () => {},
    ...overrides,
  }
}
