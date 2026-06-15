import type { Player } from '@/api/matches'

/**
 * Fallback display name for a degenerate username (empty or whitespace-only),
 * so a player row is never nameless to a screen reader (#101). Emoji-only names
 * render as-is — the avatar that would otherwise mangle them into "?" is marked
 * decorative, so the readable text carries the identity.
 */
export const UNNAMED_PLAYER = 'Unnamed player'

/** Generic role label for a player with no known rating. */
export const REGISTERED_PLAYER_LABEL = 'REGISTERED PLAYER'

/** The username, or a stable fallback when it is empty / whitespace-only. */
export function displayPlayerName(username: string): string {
  return username.trim() === '' ? UNNAMED_PLAYER : username
}

/**
 * Secondary line for a player row: the rounded rating when known, else the
 * generic "registered player" label.
 */
export function playerRoleLabel(player: Pick<Player, 'rating'>): string {
  return player.rating != null
    ? `RATING ${Math.round(player.rating)}`
    : REGISTERED_PLAYER_LABEL
}

/**
 * Accessible name for a clickable player row — the readable name plus the role
 * label, with no decorative avatar initials mixed in (#99).
 */
export function playerAccessibleName(
  player: Pick<Player, 'username' | 'rating'>,
): string {
  return `${displayPlayerName(player.username)}, ${playerRoleLabel(player)}`
}
