import { playerByIdQueryOptions, type PlayerDetail, type RatingRange } from '@/api/players'
import type { components } from '@/api/schema'
import { isOwnProfile } from '@/components/players/player-profile/profile-order'

type HeadToHeadRecord = components['schemas']['HeadToHeadRecord']
type ViewerHeadToHead = components['schemas']['ViewerHeadToHead']

/** One row of the frequent-opponents list — the **profiled player's** record
 * against somebody they meet often. Whose side it is read from is the whole
 * question with a head-to-head (`CONTEXT.md`), and this one is *theirs*, not the
 * viewer's. */
export type FrequentOpponentView = {
  id: string
  username: string
  /** e.g. "6–2" — the player's wins first. */
  record: string
  /** e.g. "8 meetings" / "1 meeting". */
  meetings: string
  /** The share of those meetings the player won, in [0, 1] — the bar's length.
   * Not a percentage string: the bar is geometry, not copy. */
  winShare: number
}

/**
 * The **viewer's own** record against the profiled player — the thing the card
 * leads with, and the reason the page is viewer-aware at all (ADR-0915).
 *
 * `neverMet` is not an error state and not a missing one: it is zero meetings,
 * which is what a guest — anyone who lands on a profile link — always has. The
 * card renders an invitation off it, so it keeps `opponent`, which is what the
 * Start-a-match CTA prefills the match with.
 */
export type ViewerRecordView = {
  /** The player this profile is about, read as the *viewer's* opponent. */
  opponent: { id: string; username: string }
  /** True when the pair have never played — `meetings === 0`. */
  neverMet: boolean
  /** e.g. "1–4" — **the viewer's** wins first, never the player's. */
  record: string
  /** e.g. "5 meetings". `null` when they have never met — a "0 meetings" line
   * under an invitation would be noise. */
  meetings: string | null
  /** e.g. "Last met Mar 14, 2025". `null` when they have never met, or when the
   * timestamp is unreadable — the card omits the line rather than printing
   * "Invalid Date". */
  lastMeeting: string | null
}

export type HeadToHeadView = {
  /** The player the page is about — names the frequent-opponents list on somebody
   * else's profile ("rita.kovac's frequent opponents"). */
  playerName: string
  /**
   * The viewer's record against them — or `null`, which means **this is your own
   * profile**.
   *
   * That `null` is the card's structural switch, and it comes from the *payload*,
   * not from the session: the API omits the block exactly when the caller is the
   * player (ADR-0915). Deriving it client-side from `useIsViewer` instead would be
   * wrong in a way tests would catch late — `useIsViewer` is deliberately false
   * while the session is in flight, so a self-profile would spend its first frames
   * rendering a "you vs them" block against a record that does not exist.
   */
  versusViewer: ViewerRecordView | null
  /** The player's most-met opponents, top three, longest rivalry first. */
  frequentOpponents: FrequentOpponentView[]
}

/** "Mar 14, 2025". UTC, so the day can't slip either way depending on where the
 * reader sits — the same choice the hero's "Member since" makes. */
const meetingDay = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

/** An **en dash** between the two numbers, not a hyphen: "1–4" is a range, and
 * this is the one place on the page where getting the two numbers the right way
 * round is the entire point. */
const formatRecord = (wins: number, losses: number): string =>
  `${wins}–${losses}`

const formatMeetings = (meetings: number): string =>
  `${meetings} ${meetings === 1 ? 'meeting' : 'meetings'}`

const formatLastMeeting = (iso: string | null | undefined): string | null => {
  if (iso == null) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return `Last met ${meetingDay.format(at)}`
}

const selectViewerRecord = (
  versus: ViewerHeadToHead | null | undefined,
): ViewerRecordView | null => {
  // Optional *and* nullable on the wire, so both spellings of "absent" have to
  // mean the same thing: this is your own profile.
  if (versus == null) return null

  const neverMet = versus.meetings === 0
  return {
    opponent: versus.opponent,
    neverMet,
    // Read from the VIEWER's side — `versus.wins` are the caller's wins. Flipping
    // these two is the bug this whole module exists to not have.
    record: formatRecord(versus.wins, versus.losses),
    meetings: neverMet ? null : formatMeetings(versus.meetings),
    lastMeeting: neverMet ? null : formatLastMeeting(versus.last_meeting),
  }
}

const selectFrequentOpponent = (
  record: HeadToHeadRecord,
): FrequentOpponentView => ({
  id: record.opponent.id,
  username: record.opponent.username,
  // The PLAYER's wins first here — this list is their record, not the viewer's.
  record: formatRecord(record.wins, record.losses),
  meetings: formatMeetings(record.meetings),
  // Guarded, though the API only ever sends rows with at least one meeting: a
  // 0/0 row would otherwise be a NaN-wide bar.
  winShare: record.meetings === 0 ? 0 : record.wins / record.meetings,
})

/**
 * The head-to-head view, projected off the profile bundle.
 *
 * The card is **two different cards** depending on who is looking, and this is
 * where that is decided — off `versus_viewer`, which the API omits exactly when
 * the caller *is* the player (ADR-0915):
 *
 * - **someone else's profile** — the viewer's own record against them leads, and
 *   the player's frequent opponents sit underneath as secondary context;
 * - **your own** — no record (you cannot play yourself), so the card is just the
 *   frequent-opponents list.
 *
 * Nothing here is keyed on the *league*: a meeting is a decided match in any
 * league (`CONTEXT.md` § *Meeting*), so this block comes back identical whichever
 * ladder was asked for — exactly like `career`. The league still rides in the
 * query key below, because the key is the *bundle's*, not this card's.
 */
export const selectHeadToHead = (player: PlayerDetail): HeadToHeadView => ({
  playerName: player.username,
  // Through the *shared* predicate: the page's card ORDER now turns on the same
  // bit (Head-to-head leads on somebody else's profile, Career on your own —
  // ADR-0915), and a card whose shape disagreed with the slot it was ordered into
  // would be a page that says "Frequent opponents" in the "You vs them" position.
  versusViewer: isOwnProfile(player)
    ? null
    : selectViewerRecord(player.head_to_head.versus_viewer),
  frequentOpponents: player.head_to_head.frequent_opponents.map(
    selectFrequentOpponent,
  ),
})

/**
 * Spreads `playerByIdQueryOptions` and adds a `select` — **same key, same fetch**,
 * a different view model — so the card costs no second request: it reads the
 * head-to-head block the bundle already carries, off the very cache entry the
 * hero, the Career card, the confidence card and the rest read.
 *
 * `leagueId` is threaded through even though nothing in this view varies with it,
 * for the same reason the Career card threads it: the league is part of the
 * *bundle's* key, so a card that dropped it would fork the page into two requests
 * — one for `?league=<x>` and one for the default ladder — and the profile's
 * one-request test would catch it.
 */
export const headToHeadCardQuery = (
  playerId: string,
  leagueId?: string,
  range?: RatingRange,
) => ({
  ...playerByIdQueryOptions(playerId, leagueId, range),
  select: selectHeadToHead,
})
