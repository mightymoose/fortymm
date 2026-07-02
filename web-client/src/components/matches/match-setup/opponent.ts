import type { Player } from '@/api/matches'

/** The opponent side of a match-in-setup — a slice of `Player` plus the
 * fields the match-setup form actually reads. */
export interface Opponent {
  id: string
  name: string
  rating?: number | null
}

export function opponentFromPlayer(player: Player): Opponent {
  return { id: player.id, name: player.username, rating: player.rating }
}
