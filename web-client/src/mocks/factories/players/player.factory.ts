import type { components } from '@/api/schema'

type PlayerRead = components['schemas']['PlayerRead']

/**
 * A registered player as returned by the recent-opponents and player-search
 * endpoints. Defaults to a named, unrated player.
 */
export function buildPlayer(overrides: Partial<PlayerRead> = {}): PlayerRead {
  return {
    id: 'pl-1',
    username: 'ada.lovelace',
    rating: null,
    ...overrides,
  }
}

export type { PlayerRead }
