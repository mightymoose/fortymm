// What an event's **draw** looks like to a reader (ADR-0786) — the pure derivation
// behind the Events tab's draw panel, and the copy behind its refusals.
//
// The wire gives us a flat list of `Fixture`s (parsed at the boundary by `./fixtures`)
// and, separately, the event's `pools` and `entrants`. A director reads a draw as
// **pool → round → fixture**, with *names* on it. Nothing on the wire is shaped that
// way, and deliberately so:
//
// - **Names are not on a fixture.** It carries entry *ids*; the usernames behind them
//   are already on the event (`entrants` is keyed by that id), so the join happens here,
//   once. Copying the username onto the fixture would be carrying a field and its own
//   derivation, and the two copies would drift the moment a player is renamed.
// - **Pool membership is not stored.** ADR-0786: it is derived from the fixtures
//   themselves, exactly as `entered` is derived from the entries (ADR-0016).
// - **A bye is the ABSENCE of a fixture**, never a row. An odd pool simply has fewer
//   fixtures in some rounds. Nothing here invents a "bye" line, because nothing on the
//   wire says one is missing — and a derived one would be a second, drift-prone copy of
//   the planner's rotation.
//
// All of it is a pure function of one event, so it is unit-tested (`./draw.test.ts`)
// rather than asserted through a DOM.

import { ApiError } from '@/api/client'

import type { Entrant, Fixture, TournamentEvent } from './types'

/** A fixture side whose feeding fixture is not decided yet (`entryAId`/`entryBId` is
 * `null` — ADR-0786: "**TBD**, never a bye"). Round-robin never produces one; a
 * knockout round does, and it is the state the panel must render as a word rather than
 * as a blank half-line. */
export const TBD_LABEL = 'TBD'

/** A fixture side naming an entry the event **no longer lists**.
 *
 * Reachable, and it means something: a withdrawal removes the entry from `entrants`
 * (ADR-0016 — withdrawn entries are not entrants) while the cut draw goes on naming it,
 * which is precisely what makes a draw **stale** (CONTEXT.md: a draw is *current* when
 * its fixtures cover exactly the event's active entrants, and go-live refuses a stale
 * one). So the side is neither blank nor a raw uuid: it says what happened, and the
 * director reading it learns their draw needs re-cutting. */
export const WITHDRAWN_LABEL = 'Withdrawn'

/**
 * One side of a fixture, as a sum type — because the three things a side can be are
 * three *different facts*, and a renderer that collapsed them into `string | null`
 * would have to guess which one an empty string meant.
 */
export type FixtureSide =
  /** An active entrant, joined from the event's `entrants` by entry id. */
  | { kind: 'entrant'; name: string }
  /** Not decided yet — the feeding fixture has not been played (`TBD_LABEL`). */
  | { kind: 'tbd' }
  /** An entry id the event no longer lists: they withdrew, and the draw is now stale
   * (`WITHDRAWN_LABEL`). */
  | { kind: 'withdrawn' }

/** One fixture, ready to render as a named "A vs B" line. */
export interface FixtureLine {
  id: string
  position: number
  a: FixtureSide
  b: FixtureSide
}

/** The fixtures of one round, in position order. An odd round-robin pool has *fewer*
 * of them in some rounds — the player drawn against the phantom seat sits that round
 * out — and that absence is the whole representation of a bye. */
export interface DrawRound {
  round: number
  fixtures: FixtureLine[]
}

/** One pool of a cut draw: the pool as the event names it, the entrants the draw dealt
 * into it (derived from its fixtures), and those fixtures grouped by round. */
export interface PoolDraw {
  id: string
  name: string
  /** The pool's members, in **draw order** (see `drawOrder`). Derived from the
   * fixtures, never stored (ADR-0786). */
  entrants: Entrant[]
  rounds: DrawRound[]
}

/**
 * What an event's draw *is*, as a sum type — `undrawn` is a designed data state, not an
 * empty list to be rendered as a gap (`DEFINITION_OF_COMPLETE`: "Empty is a designed
 * data state, never a thrown one").
 */
export type DrawState =
  /** No draw has been cut. Every event is born here and stays here until a director
   * cuts one; `fixtures: []` on the wire. */
  | { kind: 'undrawn' }
  | {
      kind: 'drawn'
      /** The pools the draw actually used, in the event's own pool order. */
      pools: PoolDraw[]
      /** Fixtures belonging to **no pool** — an un-pooled draw (single-elim), or the KO
       * stage of an rr-then-ko (ADR-0786: `pool_id` is `null` for both). Empty today,
       * because round-robin is the only draw type with a generator — but a fixture that
       * has no pool must not be *dropped*, and a bracket renderer (#785) is where these
       * eventually belong. Until then they are shown, honestly, outside the pools. */
      unpooled: DrawRound[]
    }

/**
 * The order the draw dealt a pool's entrants in: **seed ascending where one is set,
 * then registration order** for the unseeded rest — the exact rule `plan_initial`
 * receives its list in (ADR-0786, "Entrants are ordered by seed, then registration
 * order").
 *
 * Registration order is `event.entrants`' own order (the server lists them
 * oldest-entry-first), so the tie-break is just a **stable** sort over the slice we were
 * handed. Nothing sets a seed today, so in practice this is registration order — which
 * is what makes the seeded case worth pinning in a test rather than assuming.
 */
function drawOrder(entrants: Entrant[]): Entrant[] {
  return [...entrants].sort(
    (a, b) =>
      (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER),
  )
}

/** Join one entry id to a side. `null` is TBD; an id the event no longer lists is a
 * withdrawal (see `WITHDRAWN_LABEL`) — never a blank, and never the raw id. */
function sideOf(entryId: string | null, byId: Map<string, Entrant>): FixtureSide {
  if (entryId === null) return { kind: 'tbd' }
  const entrant = byId.get(entryId)
  return entrant ? { kind: 'entrant', name: entrant.username } : { kind: 'withdrawn' }
}

/** Group a flat fixture list into rounds, ascending, each in position order.
 *
 * It **sorts**, rather than trusting the payload's order (the server sends pool → round
 * → position). Order is a claim about untrusted data like any other, and a panel whose
 * rounds only happened to come out right is one bad page of a paginated API away from
 * showing round 3 above round 1. */
function roundsOf(fixtures: Fixture[], byId: Map<string, Entrant>): DrawRound[] {
  const byRound = new Map<number, Fixture[]>()
  for (const fixture of fixtures) {
    const bucket = byRound.get(fixture.round)
    if (bucket) bucket.push(fixture)
    else byRound.set(fixture.round, [fixture])
  }
  return [...byRound.entries()]
    .sort(([a], [b]) => a - b)
    .map(([round, roundFixtures]) => ({
      round,
      fixtures: roundFixtures
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((f) => ({
          id: f.id,
          position: f.position,
          a: sideOf(f.entryAId, byId),
          b: sideOf(f.entryBId, byId),
        })),
    }))
}

/**
 * An event's draw, shaped for the reader: pools with their members and rounds, or the
 * designed `undrawn` state.
 *
 * Two things it deliberately does *not* do:
 * - It does not announce a pool the draw never used. A pool with no fixtures is not part
 *   of the draw, and the pool *set* is frozen while a draw exists (ADR-0786), so this
 *   filter cannot hide a pool a director added afterwards — there is no such pool.
 * - It does not drop a fixture. One whose `poolId` is `null`, or names a pool this event
 *   does not have, lands in `unpooled` — visible, rather than silently gone.
 */
export function drawState(event: TournamentEvent): DrawState {
  if (event.fixtures.length === 0) return { kind: 'undrawn' }

  const byId = new Map(event.entrants.map((e) => [e.id, e]))
  const poolIds = new Set(event.pools.map((p) => p.id))
  const byPool = new Map<string, Fixture[]>()
  const unpooled: Fixture[] = []
  for (const fixture of event.fixtures) {
    const poolId = fixture.poolId
    if (poolId === null || !poolIds.has(poolId)) {
      unpooled.push(fixture)
      continue
    }
    const bucket = byPool.get(poolId)
    if (bucket) bucket.push(fixture)
    else byPool.set(poolId, [fixture])
  }

  const pools: PoolDraw[] = event.pools.flatMap((pool) => {
    const fixtures = byPool.get(pool.id)
    if (!fixtures) return []
    // Membership is the entry ids the pool's own fixtures name — the derivation
    // ADR-0786 chose over an entrant↔pool table. A withdrawn entry is named by the
    // fixtures and listed by nobody, so it is not a member: it is not an entrant at all
    // (ADR-0016). Its fixtures still say `Withdrawn`, which is how the staleness shows.
    const memberIds = new Set<string>()
    for (const f of fixtures) {
      if (f.entryAId !== null) memberIds.add(f.entryAId)
      if (f.entryBId !== null) memberIds.add(f.entryBId)
    }
    return [
      {
        id: pool.id,
        name: pool.name,
        entrants: drawOrder(event.entrants.filter((e) => memberIds.has(e.id))),
        rounds: roundsOf(fixtures, byId),
      },
    ]
  })

  return { kind: 'drawn', pools, unpooled: roundsOf(unpooled, byId) }
}

/** A refusal, in the panel's own voice: a title this client owns, and a sentence
 * beneath it that — for the two refusals that matter — is the **server's**. */
export interface DrawNotice {
  title: string
  description: string
}

/**
 * Turn a failed draw verb into inline copy.
 *
 * `verb` completes "Couldn't <verb>" for the failures that have no designed state of
 * their own ("cut the draw", "remove the draw").
 *
 * **The 409 and the 422 carry the server's own sentence, verbatim.** They are the two
 * refusals a director actually meets, and for both of them the sentence is the *point*:
 * it names the thing they have to change ("5 entrants across 3 pool(s) would leave a
 * pool with fewer than 2 entrants…", "A swiss draw cannot be cut yet…"). It is authored
 * for them, on the server, where the numbers are; replacing it with a generic string of
 * ours would throw away the only actionable half of the refusal and leave the director
 * clicking Generate again. The client owns the *title* — the state, in a few words —
 * and nothing more.
 *
 * There is deliberately **no `null` arm**: this panel surfaces its mutation's errors
 * inline, so it must have words for *every* one of them (a 403 the UI does not offer,
 * an expired session, a 5xx, a dead network). A `null` here would be a silent failure —
 * the click that did nothing and said nothing — which is exactly what removing the
 * mutations' global toasts (`web-client/CLAUDE.md`, ## Forms: never both) makes this
 * function responsible for.
 */
export function drawRefusalNotice(error: unknown, verb: string): DrawNotice {
  const fallback: DrawNotice = {
    title: `Couldn't ${verb}`,
    description:
      error instanceof ApiError
        ? (error.detail ?? 'The server rejected the request. Try again in a moment.')
        : 'The request never reached the server. Check your connection and try again.',
  }
  if (!(error instanceof ApiError)) return fallback

  switch (error.status) {
    // Evidence of play: a fixture has a winner, or has become a real match. The draw is
    // under way and can no longer be cut or removed (ADR-0786's play guard).
    case 409:
      return {
        title: 'This draw is already under way',
        description:
          error.detail ??
          'At least one fixture has a match or a recorded winner, so the draw can no longer be cut or removed.',
      }
    // The planner refuses this event as it stands: an unsupported draw type, no pools,
    // or a pool that would get fewer than two entrants.
    case 422:
      return {
        title: "This event can't be drawn yet",
        description:
          error.detail ??
          'This event cannot be planned as it stands. Check its draw type and its pools.',
      }
    // Owner-only. The panel offers no draw action to anyone else, so this can only mean
    // the page is looking at somebody else's tournament — the server is the boundary,
    // and the hidden button never was (ADR-0015).
    case 403:
      return {
        title: "You can't change this draw",
        description:
          'Only the tournament’s creator can cut or remove a draw. Nothing was changed.',
      }
    case 401:
      return {
        title: 'You are signed out',
        description: 'Sign in again, then cut the draw. Nothing was changed.',
      }
    default:
      return fallback
  }
}
