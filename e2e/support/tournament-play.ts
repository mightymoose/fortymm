import { acceptResult, type Guest, type ResultGame } from './match-api'

// Composed-stack API helper for **playing a live tournament out** — every fixture the
// draw has materialized, decided over the real API, until there is nothing left to play.
//
// It exists because some claims about a *draw* only become visible once its matches are
// finished. An `rr-then-ko` event does not seat a single qualifier until a pool is
// decided (ADR "rr-then-ko cuts both stages upfront and seeds qualifiers rematch-free"),
// so a spec whose subject is the seating has to get fourteen matches played before it can
// look at anything — and fourteen trips through the score-entry UI would be a test of the
// score-entry UI. `tournament-lifecycle.spec.ts` already drives that surface in the
// browser, once, deliberately; this is the seam for every spec whose subject is on the
// other side of the play.
//
// Writes ride the double-submit CSRF defense the same way `match-api.ts` does, and the
// acceptance leg is `match-api`'s own `acceptResult` rather than a second spelling of it.

const API = '/api/v1'
const CSRF_HEADER = 'x-csrf-token'

/** How many passes over the draw this helper will make before giving up.
 *
 * A pass plays every fixture that is currently materialized and undecided; the
 * completions advance the draw, which materializes the next round, which the next pass
 * plays. A bracket seeded from three pools settles in three or four passes, so ten is
 * generous — its job is to turn "the draw stopped advancing" into a **named error**
 * instead of a test that hangs until Playwright's timeout and reports nothing about why. */
const MAX_PASSES = 10

/** The event slice this helper reads: who is entered, what has materialized, and the
 * match settings the board it composes has to satisfy. Only these fields are named; the
 * rest of the payload rides along untyped, as elsewhere in `support/`. */
interface PlayableEvent {
  readonly id: string
  readonly match_settings: { readonly rated: boolean; readonly length_games: number }
  readonly entrants: ReadonlyArray<{
    readonly id: string
    readonly username: string
  }>
  readonly fixtures: ReadonlyArray<{
    readonly id: string
    readonly pool_id: string | null
    /** Which round of the draw the fixture belongs to — what `playSwissRound` scopes
     * itself by. A swiss draw is cut whole, so every round's rows exist from the start
     * and "the fixtures that are playable" is never the same set as "this round's". */
    readonly round: number
    readonly entry_a_id: string | null
    readonly entry_b_id: string | null
    readonly match_id: string | null
    readonly match_status: string | null
  }>
}

/** Which fixtures a call to `playEvent` is willing to decide.
 *
 * `'pools'` stops at the pool stage, which is the whole point of having the option: an
 * `rr-then-ko` spec needs a moment *between* the stages — pools decided, bracket seated,
 * nothing knocked out yet — and that moment does not exist if the helper plays on. */
export type PlayStage = 'pools' | 'all'

/**
 * Play `eventId`'s draw out over the API, **the earlier-registered entrant always
 * winning**, until no materialized fixture is left undecided. Returns how many matches
 * were decided.
 *
 * ## The winner rule is the seed's, and it is deliberately boring
 *
 * `entrants` is the field **in registration order** — what `seedEntrants` returns — and
 * the entrant nearer its front wins. That makes every outcome in the tournament a
 * function of the seeded field alone: a pool's finishing order is its members' order in
 * this list, the qualifiers are the first `K` of them, and the champion is
 * `entrants[0]`. A spec can therefore write down who *should* be in the bracket before a
 * ball is hit, which is the only way an assertion about the seating can be more than "six
 * names appeared".
 *
 * It also keeps the play free of ties: in a three-player pool the rule gives 2–0, 1–1 and
 * 0–2, so the finishing order needs no tiebreak and the qualifier set is not a coin flip.
 *
 * ## Passes, not a queue
 *
 * A completion advances the draw inside the completion transaction (ADR-0788) and
 * materializes whatever it just made ready, so the set of playable fixtures **grows while
 * this runs**. Rather than predict that, each pass re-reads the event and plays what it
 * finds; when a pass finds nothing, the draw is settled. `MAX_PASSES` bounds it.
 *
 * Sequential on purpose, and not merely for tidiness: every completion takes the
 * tournament row lock (`on_match_completed`), so concurrent finishes would serialize
 * anyway — and a burst of them would make which fixture materialized first a race, which
 * is exactly the determinism the winner rule above is buying.
 *
 * ## Rated or not, one path
 *
 * The result is proposed by the winner; if the response leaves a **standing result** —
 * which only a rated two-human match does — the loser accepts it. The helper reads that
 * off the response rather than off `match_settings.rated`, so it plays an event however
 * the director configured it, including one configured through the editor's defaults.
 *
 * The board is `target` straight games at 11–5, where `target` is the wins a
 * `length_games` best-of needs: exactly decisive, with nothing after the decider (which
 * `validate_finalize_games` refuses).
 */
export async function playEvent(
  director: Guest,
  tournamentId: string,
  eventId: string,
  entrants: ReadonlyArray<Guest>,
  stage: PlayStage = 'all',
): Promise<number> {
  const byUsername = new Map(entrants.map((guest) => [guest.username, guest]))
  const rank = new Map(entrants.map((guest, index) => [guest.username, index]))
  let played = 0

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const event = await readPlayableEvent(director, tournamentId, eventId)
    const seats = new Map(
      event.entrants.map((entrant) => [entrant.id, entrant.username]),
    )
    const playable = event.fixtures.filter(
      (fixture): fixture is typeof fixture & { match_id: string } =>
        fixture.match_id !== null &&
        fixture.match_status !== 'completed' &&
        (stage === 'all' || fixture.pool_id !== null),
    )
    if (playable.length === 0) return played

    for (const fixture of playable) {
      const [a, b] = [fixture.entry_a_id, fixture.entry_b_id].map((entryId) =>
        guestFor(byUsername, seats, entryId, fixture.id),
      )
      // Side 1 IS `entry_a` and side 2 IS `entry_b` — the fixed materialization
      // convention (#788) — so the winner's seat decides which column of the board wins.
      const winnerIsA = rank.get(a.username)! < rank.get(b.username)!
      await decide(
        winnerIsA ? a : b,
        winnerIsA ? b : a,
        fixture.match_id,
        board(winnerIsA ? 1 : 2, gamesToWin(event.match_settings.length_games)),
      )
      played += 1
    }
  }

  throw new Error(
    `event ${eventId} still had playable fixtures after ${MAX_PASSES} passes ` +
      `(${played} matches decided) — is the draw advancing?`,
  )
}

/** Who wins one fixture, given the two guests seated in it (side `a` first).
 *
 * A parameter rather than a rule, because in swiss **the winners decide the standings and
 * the standings decide the next pairing** — so a spec proving that a round is paired from
 * the standings has to be able to choose winners whose order is *not* the draw order. With
 * `playEvent`'s "the earlier-registered entrant wins" the two orders coincide exactly
 * (round 1 seeds the top half against the bottom half, so the first half of the draw order
 * wins every fixture), and a pairing that ignored the standings altogether would produce
 * the same fixtures as one that honours them. The assertion would pass against the bug. */
export type PickWinner = (a: Guest, b: Guest) => Guest

/** The winner rule `playEvent` bakes in, as a picker `playSwissRound` can be handed: **the
 * earlier-registered entrant wins**, `entrants` being the field in registration order.
 *
 * Boring on purpose, and the right default for a round whose outcomes are scaffolding
 * rather than subject — every result is then a function of the seeded field alone, and no
 * pairing is left to a coin flip. It is the wrong rule for a round whose outcomes ARE the
 * subject: see `PickWinner`. */
export function earlierRegisteredWins(entrants: ReadonlyArray<Guest>): PickWinner {
  const rank = new Map(entrants.map((guest, index) => [guest.username, index]))
  const rankOf = (guest: Guest): number => {
    const index = rank.get(guest.username)
    if (index === undefined) {
      throw new Error(`${guest.username} is not one of the entrants this spec minted`)
    }
    return index
  }
  return (a, b) => (rankOf(a) < rankOf(b) ? a : b)
}

/**
 * Play **one round** of a swiss draw out over the API, `pickWinner` deciding each fixture,
 * and return how many matches were decided.
 *
 * One round, not the whole draw, because a swiss round's completion is the event under
 * test: finishing the last match of round `r` is what pairs round `r + 1` from the
 * standings and materializes it, in the same transaction. `playEvent` would sail straight
 * through that moment and hand back a finished tournament, with nothing left to look at.
 *
 * A single pass suffices and the loop `playEvent` needs is deliberately absent: a round's
 * fixtures all materialize together (at go-live for round 1, at the previous round's last
 * completion for every other), so they are all playable before this is called. A fixture
 * of this round that has **not** materialized is therefore a named error rather than a
 * skip — a silent one would leave the round undecided, the next round unpaired, and the
 * failure somewhere else entirely.
 */
export async function playSwissRound(
  director: Guest,
  tournamentId: string,
  eventId: string,
  entrants: ReadonlyArray<Guest>,
  round: number,
  pickWinner: PickWinner,
): Promise<number> {
  const byUsername = new Map(entrants.map((guest) => [guest.username, guest]))
  const event = await readPlayableEvent(director, tournamentId, eventId)
  const seats = new Map(event.entrants.map((entrant) => [entrant.id, entrant.username]))
  const fixtures = event.fixtures.filter((fixture) => fixture.round === round)
  if (fixtures.length === 0) {
    throw new Error(`event ${eventId} has no round-${round} fixtures — was the draw cut?`)
  }

  let played = 0
  for (const fixture of fixtures) {
    if (fixture.match_status === 'completed') continue
    if (fixture.match_id === null) {
      throw new Error(
        `round-${round} fixture ${fixture.id} has not materialized into a match — is ` +
          `the tournament live, and is round ${round - 1} decided?`,
      )
    }
    const [a, b] = [fixture.entry_a_id, fixture.entry_b_id].map((entryId) =>
      guestFor(byUsername, seats, entryId, fixture.id),
    )
    const winner = pickWinner(a, b)
    // Side 1 IS `entry_a` and side 2 IS `entry_b` — the fixed materialization convention
    // (#788) — so the winner's seat decides which column of the board wins.
    const winnerIsA = winner.username === a.username
    await decide(
      winnerIsA ? a : b,
      winnerIsA ? b : a,
      fixture.match_id,
      board(winnerIsA ? 1 : 2, gamesToWin(event.match_settings.length_games)),
    )
    played += 1
  }
  return played
}

/** The wins a best-of-`lengthGames` needs — the same `(n + 1) // 2` the server's
 * `validate_finalize_games` computes, because a board short of it is refused ("No side
 * reached N game wins") and a board past it is refused too ("games extend past the
 * deciding game"). */
function gamesToWin(lengthGames: number): number {
  return Math.floor(lengthGames / 2) + 1
}

/** A straight-games board: `wins` games at 11–5 to `winnerSide`, numbered from 1. */
function board(winnerSide: 1 | 2, wins: number): ResultGame[] {
  return Array.from({ length: wins }, (_, index) => ({
    game_number: index + 1,
    side_1_points: winnerSide === 1 ? 11 : 5,
    side_2_points: winnerSide === 2 ? 11 : 5,
  }))
}

/** Resolve a fixture's entry ref to the guest sitting in it.
 *
 * Throws on every way it can miss — an unseated side, an entry the event does not list,
 * an entrant this caller did not mint — because each of those means the helper is about
 * to play the wrong match or none, and a silent skip would leave the draw un-advanced and
 * the failure three passes away in `MAX_PASSES`. */
function guestFor(
  byUsername: ReadonlyMap<string, Guest>,
  seats: ReadonlyMap<string, string>,
  entryId: string | null,
  fixtureId: string,
): Guest {
  if (entryId === null) {
    throw new Error(`fixture ${fixtureId} materialized with an unseated side`)
  }
  const username = seats.get(entryId)
  const guest = username === undefined ? undefined : byUsername.get(username)
  if (!guest) {
    throw new Error(
      `fixture ${fixtureId} seats entry ${entryId} (${username ?? 'unknown entry'}), ` +
        'who is not one of the entrants this spec minted',
    )
  }
  return guest
}

/** Decide one match: `winner` proposes the board, and `loser` accepts it if the server
 * left a standing result (the rated two-human path). */
async function decide(
  winner: Guest,
  loser: Guest,
  matchId: string,
  games: ReadonlyArray<ResultGame>,
): Promise<void> {
  const res = await winner.ctx.post(`${API}/matches/${matchId}/results`, {
    headers: { [CSRF_HEADER]: winner.csrf },
    data: { games },
  })
  if (res.status() !== 201) {
    throw new Error(`propose result failed: ${res.status()} ${await res.text()}`)
  }
  const standing = (
    (await res.json()) as {
      negotiation?: { standing_result?: { id?: string } | null }
    }
  ).negotiation?.standing_result?.id
  // No standing result = the proposal self-accepted (an unrated or solo match) and the
  // match is already complete. An acceptance here would be a second verb on a finished
  // match, so the branch is the contract, not defensiveness.
  if (standing != null) await acceptResult(loser, matchId, standing)
}

/** Read the tournament detail and return the one event, typed to the slice above. */
async function readPlayableEvent(
  viewer: Guest,
  tournamentId: string,
  eventId: string,
): Promise<PlayableEvent> {
  const res = await viewer.ctx.get(`${API}/tournaments/${tournamentId}`)
  if (!res.ok()) {
    throw new Error(`load tournament failed: ${res.status()} ${await res.text()}`)
  }
  const detail = (await res.json()) as {
    events: ReadonlyArray<PlayableEvent>
  }
  const event = detail.events.find((candidate) => candidate.id === eventId)
  if (!event) {
    throw new Error(`no event ${eventId} on tournament ${tournamentId}`)
  }
  return event
}
