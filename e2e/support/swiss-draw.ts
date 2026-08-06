import type { Guest } from './match-api'

// Composed-stack API reader for a **swiss** event's draw and standings — the two facts a
// swiss spec asserts that a browser cannot name on its own.
//
// A fixture line on screen reads "alice vs bob", which is enough to say a round is paired
// and nothing like enough to say *who sat out*: a bye is the ABSENCE of a fixture row
// (CONTEXT.md, "Bye"), so the byed entrant is defined by not appearing anywhere, and
// "nobody rendered them" is exactly what a locator cannot assert about a name it does not
// know. The same goes for the standings ORDER the next round is paired down: the rendered
// table shows it, but a spec has to hold that order as a value before it can compare a
// pairing against it.
//
// So this reads the same `GET /v1/tournaments/{id}` the page reads, joins each fixture's
// entry refs to the usernames the spec minted, and hands back the draw round by round.
// Read-only — nothing here writes, and every load-bearing assertion still lands on the
// page. This is the seam that says WHICH names to look for.

const API = '/api/v1'

/** One fixture of a swiss round, with its sides joined to usernames.
 *
 * A side is `null` for a round that is cut but not yet paired — the `TBD` the draw panel
 * renders (ADR-0786: never a bye, which has no row at all). */
export interface SwissFixture {
  /** The fixture's position within its round, which for swiss **is its pairing rank**
   * (ADR "swiss pre-cuts every round and pairs each one on advance"). Fixtures come back
   * in this order. */
  readonly position: number
  readonly a: string | null
  readonly b: string | null
}

/** One round of a swiss draw as the server holds it. */
export interface SwissRound {
  readonly round: number
  /** The round's fixtures in `position` — that is, pairing-rank — order. */
  readonly fixtures: ReadonlyArray<SwissFixture>
  /** Whether anybody at all is seated in this round. The same question the draw panel
   * asks of the sides rather than of the round number, so a paired round 2 reads as
   * paired here and there. */
  readonly paired: boolean
  /** The entrants this round seats in **no** fixture — its byes, derived exactly as the
   * server derives them (`app.draws.swiss_byes`): by asking who is missing from a round
   * that was paired.
   *
   * **Empty for an unpaired round**, which is not a round everybody was byed in but a
   * round nobody has been paired into yet — the ordinary state of every later round of a
   * freshly cut draw. */
  readonly satOut: ReadonlyArray<string>
}

/** One row of a swiss event's standings, joined to the entrant's username.
 *
 * The **server's** row and the server's rank, not a re-derivation: this is the table the
 * director reads and the order the next round is paired down, so a spec comparing a
 * pairing against it has to take it from the same place both of those do. */
export interface SwissStanding {
  readonly entryId: string
  readonly username: string
  readonly rank: number
  readonly wins: number
  readonly gamesWon: number
}

/** The slice of the tournament detail this module parses: the event's field, its
 * fixtures' rounds and sides, and its results. */
interface SwissEventPayload {
  readonly id: string
  readonly entrants: ReadonlyArray<{ readonly id: string; readonly username: string }>
  readonly fixtures: ReadonlyArray<{
    readonly round: number
    readonly position: number
    readonly entry_a_id: string | null
    readonly entry_b_id: string | null
  }>
  readonly results: SwissResultsPayload | null
}

/** The `swiss_standings` arm of the results union — the only arm a swiss event may read
 * out (ADR "swiss pre-cuts every round and pairs each one on advance"). */
interface SwissResultsPayload {
  readonly kind: string
  readonly rows?: ReadonlyArray<{
    readonly entry_id: string
    readonly rank: number
    readonly wins: number
    readonly games_won: number
  }>
}

/** Read one event off the tournament detail, typed to the swiss slice above. */
async function readSwissEvent(
  viewer: Guest,
  tournamentId: string,
  eventId: string,
): Promise<SwissEventPayload> {
  const res = await viewer.ctx.get(`${API}/tournaments/${tournamentId}`)
  if (!res.ok()) {
    throw new Error(`load tournament failed: ${res.status()} ${await res.text()}`)
  }
  const detail = (await res.json()) as {
    events: ReadonlyArray<SwissEventPayload>
  }
  const event = detail.events.find((candidate) => candidate.id === eventId)
  if (!event) {
    throw new Error(`no event ${eventId} on tournament ${tournamentId}`)
  }
  return event
}

/**
 * Read a swiss event's draw **round by round**, with every side joined to a username and
 * each round's byes derived from who it does not seat.
 *
 * Rounds come back in round order and their fixtures in `position` order, which for swiss
 * is pairing-rank order — so a caller compares them against a standings order directly,
 * without sorting anything itself.
 */
export async function readSwissRounds(
  viewer: Guest,
  tournamentId: string,
  eventId: string,
): Promise<SwissRound[]> {
  const event = await readSwissEvent(viewer, tournamentId, eventId)
  const nameOf = new Map(event.entrants.map((entrant) => [entrant.id, entrant.username]))
  const seatOf = (entryId: string | null): string | null => {
    if (entryId === null) return null
    const username = nameOf.get(entryId)
    if (username === undefined) {
      throw new Error(
        `event ${eventId} seats entry ${entryId}, which is on none of its ${nameOf.size} entrants`,
      )
    }
    return username
  }

  const byRound = new Map<number, SwissFixture[]>()
  for (const fixture of event.fixtures) {
    const round = byRound.get(fixture.round) ?? []
    round.push({
      position: fixture.position,
      a: seatOf(fixture.entry_a_id),
      b: seatOf(fixture.entry_b_id),
    })
    byRound.set(fixture.round, round)
  }

  const field = event.entrants.map((entrant) => entrant.username)
  return [...byRound.keys()]
    .sort((left, right) => left - right)
    .map((round) => {
      const fixtures = [...byRound.get(round)!].sort(
        (left, right) => left.position - right.position,
      )
      const seated = new Set(
        fixtures
          .flatMap((fixture) => [fixture.a, fixture.b])
          .filter((side): side is string => side !== null),
      )
      return {
        round,
        fixtures,
        paired: seated.size > 0,
        // A round nobody is paired into byes nobody — the same distinction
        // `swiss_byes` draws, and the reason it takes pairings rather than a round
        // count. Without it every forthcoming round would read as ⌊n/2⌋ byes.
        satOut:
          seated.size === 0 ? [] : field.filter((username) => !seated.has(username)),
      }
    })
}

/**
 * Read a swiss event's **standings** off the same payload the table on screen is rendered
 * from, in the server's finishing order.
 *
 * Throws when the event reads out any other results shape, naming the one it got. That is
 * a real failure and not defensiveness: a swiss event routed through the round-robin arm
 * would come back with its rows grouped under pools that swiss does not have, and the
 * caller would see an empty order rather than a wrong one.
 */
export async function readSwissStandings(
  viewer: Guest,
  tournamentId: string,
  eventId: string,
): Promise<SwissStanding[]> {
  const event = await readSwissEvent(viewer, tournamentId, eventId)
  const results = event.results
  if (results === null) {
    throw new Error(`event ${eventId} has no results yet — was the draw cut?`)
  }
  if (results.kind !== 'swiss_standings' || results.rows === undefined) {
    throw new Error(
      `event ${eventId} reads out "${results.kind}" results — a swiss event reads out ` +
        'one pool-less "swiss_standings" table',
    )
  }
  const nameOf = new Map(event.entrants.map((entrant) => [entrant.id, entrant.username]))
  return results.rows.map((row) => {
    const username = nameOf.get(row.entry_id)
    if (username === undefined) {
      throw new Error(
        `standings row ${row.entry_id} names no entrant of event ${eventId}`,
      )
    }
    return {
      entryId: row.entry_id,
      username,
      rank: row.rank,
      wins: row.wins,
      gamesWon: row.games_won,
    }
  })
}
