import { matchDetailRoute, scoringNewRoute } from '@/api/matches'
import type {
  DashboardTournament,
  DashboardTournamentEvent,
  DashboardTournamentFixtureRow,
  DashboardTournamentMatch,
} from '@/api/dashboard'

// Every label the panel prints is decided here, once, rather than in JSX. The
// component below it renders a view and branches only on fields this projection
// already resolved — so a copy change is a change to one pure function with a
// plain `.test.ts` around it, not a hunt through markup.

/** Shown wherever the opposing side of a fixture is still undecided — the
 * server's `opponent_username: null`, which means TBD, never "solo". */
const TBD_OPPONENT = 'TBD'

type MatchRoute =
  | ReturnType<typeof matchDetailRoute>
  | ReturnType<typeof scoringNewRoute>

export interface TournamentGameChipView {
  /** `Game 3` */
  label: string
  /** `11–9`, always the viewer's points first. */
  score: string
  /** Full sentence for assistive tech, since the chip itself is two numbers. */
  description: string
}

export interface TournamentMatchCardView {
  state: 'live' | 'scheduled' | 'completed' | 'voided'
  /** The card's status line: `Live · Table 4 · Game 4`, `Match complete ·
   * Group match 2 · Table 2`, or the round for a match not yet started. */
  statusText: string
  /** `Best of 5`. */
  bestOfText: string
  /** The viewer's own handle — the panel is a first-person surface, so their
   * row is named, not labelled "You". */
  youName: string
  opponentName: string
  yourGames: number
  opponentGames: number
  /** Which row (if any) carries the winner chip. Both false while a match is
   * live — a running score has no winner. */
  youWon: boolean
  opponentWon: boolean
  /** `mightymoose shown first · vs slim-manatee` — the legend that makes the
   * game chips readable. `null` when there are no chips to explain. */
  gamesLegend: string | null
  games: TournamentGameChipView[]
  /** The card's primary action, or `null` when there is nothing to do yet (an
   * uncalled match cannot be scored, a finished one has nothing to enter). */
  action: { label: string; route: MatchRoute } | null
  /** Where "Match details" goes. `null` for a fixture with no match behind it
   * yet — there is no page to open. */
  detailsRoute: MatchRoute | null
  /** `6:00 PM CDT · Table 3` for a match not yet started; `null` otherwise. */
  scheduleText: string | null
}

export interface TournamentPathRowView {
  key: string
  /** `M2` — the row's ordinal in the viewer's own schedule. */
  label: string
  opponentName: string
  state: DashboardTournamentFixtureRow['state']
  /** Right-hand text: a result, `In progress`, or a time and table. */
  detail: string
  /** Drives the row's tone. `null` for anything not yet decided. */
  youWon: boolean | null
}

export interface TournamentStatsView {
  wins: number
  losses: number
  /** `Group position` — what the middle tile counts. */
  positionLabel: string
  /** `1st`, or `null` when the event has no standings to stand in yet. */
  positionValue: string | null
  /** `of 4`, or `null` alongside a null position. */
  positionSuffix: string | null
  /** `Group play` / `Group complete`. */
  stageValue: string
}

export interface TournamentTabView {
  eventId: string
  name: string
  /** Puts the pulsing "Live" marker on the tab. */
  live: boolean
  stats: TournamentStatsView
  match: TournamentMatchCardView | null
  /** `Your matches` — the path list's heading, in the draw type's vocabulary. */
  pathHeading: string
  path: TournamentPathRowView[]
  /** Names the pool the path belongs to, e.g. `Pool A · 4 players`. `null` for
   * an un-pooled draw or before the viewer has been drawn into one. */
  pathSubheading: string | null
}

export interface TournamentPanelView {
  tournamentId: string
  /** Rendered in the display face, so it is upper-cased at the source rather
   * than by a CSS transform a screen reader would read letter by letter. */
  name: string
  subtitle: string
  /** `1 live now`, or `null` when nothing of the viewer's is being played. */
  liveLabel: string | null
  /** `View group & standings` / `View draw` — where the header link goes, in
   * the draw type's own words. */
  destinationLabel: string
  tabs: TournamentTabView[]
}

function ordinal(n: number): string {
  // 11th/12th/13th are the exceptions every naive implementation gets wrong.
  const teen = n % 100
  if (teen >= 11 && teen <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

/** Join the parts of a status line, dropping the ones the server had no value for. */
function joinParts(...parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' · ')
}

function statusTextOf(match: DashboardTournamentMatch): string {
  const table = match.table_label
  switch (match.state) {
    case 'live':
      // `next_game_number` is the game about to be played. It is `null` when the
      // board already DECIDES the match but the result has not been posted — and
      // there the card must name no game at all. Falling back to
      // `games.length + 1` would print "Game 3" for a match that is over,
      // reintroducing on the card the exact phantom game number the server
      // refuses to emit (`current_game_number`), and contradicting the action
      // button beside it, which correctly offers nothing to enter.
      return joinParts(
        'Live',
        table,
        match.next_game_number === null
          ? null
          : `Game ${match.next_game_number}`,
      )
    case 'completed':
      return joinParts('Match complete', match.round_label, table)
    case 'voided':
      // A voided match contributes nothing (ADR-0013) — the card names the fact
      // and shows no outcome. It deliberately does NOT read as a completed
      // match, which would derive a loss from the empty board beneath it.
      return joinParts('Match voided', match.round_label)
    case 'scheduled':
      return match.round_label
  }
}

function actionOf(
  match: DashboardTournamentMatch,
): { label: string; route: MatchRoute } | null {
  // A scheduled (uncalled) match is not scorable and a finished one has nothing
  // left, so both answer `null` rather than a button that 409s or lies.
  if (match.state !== 'live' || match.match_id === null) return null
  switch (match.owed_action) {
    case 'score':
      // Mid-board: enter the next game. With no next game the board is decided
      // and unposted — what is left is to post the result, which match detail
      // holds. (Answering `null` there dead-ended the card at the one moment the
      // player most needs a way forward.)
      return match.next_game_number === null
        ? { label: 'Post the result', route: matchDetailRoute(match.match_id) }
        : {
            label: `Enter Game ${match.next_game_number} result`,
            route: scoringNewRoute(match.match_id, match.next_game_number),
          }
    case 'review':
      // The OPPONENT posted a result; this player owes it a look. Labelling this
      // "Post the result" told them to do a thing that was already done, and by
      // the wrong person — `Review result` is the copy the attention panel has
      // always used for this exact state.
      return { label: 'Review result', route: matchDetailRoute(match.match_id) }
    // `waiting_opponent` (we posted, they owe the accept), `waiting_others` and
    // `null` all mean the move is not ours: no button. The card still links to
    // match details, which is where the standing result can be watched.
    default:
      return null
  }
}

function scheduleTextOf(match: DashboardTournamentMatch): string | null {
  if (match.state !== 'scheduled') return null
  return joinParts(match.start_label, match.table_label) || 'Not scheduled yet'
}

function projectMatch(
  match: DashboardTournamentMatch,
  youName: string,
): TournamentMatchCardView {
  const opponentName = match.opponent_username ?? TBD_OPPONENT
  const games = match.games.map((game) => ({
    label: `Game ${game.number}`,
    score: `${game.your_points}–${game.opponent_points}`,
    description: `Game ${game.number}: ${youName} ${game.your_points}, ${opponentName} ${game.opponent_points}`,
  }))
  return {
    state: match.state,
    statusText: statusTextOf(match),
    // A best-of-1 is a single game, so it drops the "Best of N" race framing that
    // only means something for a multi-game set — the copy #908 settled for every
    // surface that states a match length.
    bestOfText:
      match.best_of === 1 ? 'Single game' : `Best of ${match.best_of}`,
    youName,
    opponentName,
    yourGames: match.your_games,
    opponentGames: match.opponent_games,
    // `you_won` is null until the match is decided, so neither row is crowned
    // mid-match — a `false` there would put the chip on the opponent.
    youWon: match.you_won === true,
    opponentWon: match.you_won === false,
    gamesLegend: games.length
      ? `${youName} shown first · vs ${opponentName}`
      : null,
    games,
    action: actionOf(match),
    detailsRoute:
      match.match_id === null ? null : matchDetailRoute(match.match_id),
    scheduleText: scheduleTextOf(match),
  }
}

function projectStats(event: DashboardTournamentEvent): TournamentStatsView {
  return {
    wins: event.wins,
    losses: event.losses,
    positionLabel:
      event.draw_type === 'round-robin' ? 'Group position' : 'Position',
    positionValue: event.position === null ? null : ordinal(event.position),
    positionSuffix:
      event.position === null ? null : `of ${event.field_size}`,
    stageValue: event.stage_label,
  }
}

function pathHeadingOf(drawType: DashboardTournamentEvent['draw_type']): string {
  return drawType === 'round-robin' ? 'Your matches' : 'Your path'
}

function destinationLabelOf(tabs: DashboardTournamentEvent[]): string {
  // A round-robin's destination is its standings table; anything else is a
  // bracket. Keyed off the first tab because the header link is per-tournament
  // and every event of one today shares a draw type in practice — and "View
  // draw" reads correctly for a mixed tournament either way.
  return tabs.every((event) => event.draw_type === 'round-robin')
    ? 'View group & standings'
    : 'View draw'
}

function projectTab(
  event: DashboardTournamentEvent,
  youName: string,
): TournamentTabView {
  return {
    eventId: event.id,
    name: event.name,
    live: event.is_live,
    stats: projectStats(event),
    match: event.match === null ? null : projectMatch(event.match, youName),
    pathHeading: pathHeadingOf(event.draw_type),
    path: event.fixtures.map((fixture, index) => ({
      // The fixture's own match id is null before it materializes, so the row's
      // ordinal — which is stable within one payload — is the key.
      key: `${event.id}-${index}`,
      label: fixture.label,
      opponentName: fixture.opponent_username ?? TBD_OPPONENT,
      state: fixture.state,
      detail: fixture.detail,
      youWon: fixture.you_won,
    })),
    pathSubheading:
      event.pool_label === null
        ? null
        : event.field_size > 0
          ? `${event.pool_label} · ${event.field_size} players`
          : event.pool_label,
  }
}

/**
 * Project one live tournament from the dashboard payload into the panel's view
 * model — labels, ordinals, routes and the tab strip.
 *
 * `youName` is the viewer's own handle, which the payload deliberately does not
 * repeat: every score on it is already stated from the caller's side, so the
 * only thing missing is what to *call* them, and the dashboard already knows
 * that from the session.
 */
export function projectTournamentPanelView(
  tournament: DashboardTournament,
  youName: string,
): TournamentPanelView {
  return {
    tournamentId: tournament.id,
    name: tournament.name,
    subtitle: tournament.subtitle,
    liveLabel:
      tournament.live_count > 0 ? `${tournament.live_count} live now` : null,
    destinationLabel: destinationLabelOf(tournament.events),
    tabs: tournament.events.map((event) => projectTab(event, youName)),
  }
}

/**
 * Every live tournament the viewer is playing in, as panels — `[]` when they
 * are in none, which is almost always, and the dashboard then renders nothing.
 *
 * An event-less tournament is dropped rather than rendered as an empty panel:
 * the panel is entirely made of its tabs, so one with no tabs is a heading over
 * nothing. (The server cannot emit one today — a panel exists because the
 * viewer holds an entry in one of its events — but the panel must not depend on
 * that to avoid rendering a husk.)
 */
export function projectTournamentPanelViews(
  tournaments: DashboardTournament[],
  youName: string | undefined,
): TournamentPanelView[] {
  if (!youName) return []
  return tournaments
    .filter((tournament) => tournament.events.length > 0)
    .map((tournament) => projectTournamentPanelView(tournament, youName))
}
