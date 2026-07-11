import { playerByIdQueryOptions, type PlayerDetail, type RatingRange } from '@/api/players'

/** The identity half of the profile hero: who this is, and since when.
 *
 * Everything the display needs is already a string here — the `select` owns all
 * label and format logic, so the component is view-in, DOM-out. */
export type ProfileHeroView = {
  username: string
  /** e.g. "Member since Mar 2024". `null` if the timestamp is unreadable —
   * the hero simply omits the line rather than printing "Invalid Date". */
  memberSince: string | null
}

/** "Mar 2024". Formatted in UTC so the month can't slip a day either way
 * depending on where the reader sits. */
const monthAndYear = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

const selectMemberSince = (memberSince: string): string | null => {
  const at = new Date(memberSince)
  if (Number.isNaN(at.getTime())) return null
  return `Member since ${monthAndYear.format(at)}`
}

export const selectProfileHero = (player: PlayerDetail): ProfileHeroView => ({
  username: player.username,
  memberSince: selectMemberSince(player.member_since),
})

/**
 * The hero's identity card, projected off the profile bundle.
 *
 * Spreads `playerByIdQueryOptions` and adds a `select` — same key, same fetch,
 * its own view model — so the whole profile paints from **one** cache entry and
 * one request (the match-details projection pattern). `throwOnError` rides along
 * from the base: a failure has nothing to draw, so it throws to the route's
 * error boundary rather than to a per-card one.
 */
export const profileHeroQuery = (
  playerId: string,
  leagueId?: string,
  range?: RatingRange,
) => ({
  ...playerByIdQueryOptions(playerId, leagueId, range),
  select: selectProfileHero,
})
