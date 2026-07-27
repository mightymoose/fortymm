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
import type { MatchStatus } from '@/api/matches'

import { fallbackNotice, type Notice } from './notice'
import { DRAW_TYPE_OPTIONS, labelFor } from './options'
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

/** The **materialized match** behind a fixture — the real, playable match a fixture
 * became at go-live (#788). Present exactly when the fixture has one; `null` while the
 * slot is still a planned pairing (see `FixtureLine.match`).
 *
 * A single object rather than a loose `matchId`/`matchStatus` pair, because the two are
 * one fact: on the wire they move in lockstep (both `null`, then both set), so pairing
 * them here makes "an id with no status" — the half-materialized slot the renderer would
 * have to guess at — unrepresentable. */
export interface FixtureMatch {
  /** The match this slot links to (`GET /v1/matches/{id}`). */
  id: string
  /** The match's live status, read fresh off the fixture each load. */
  status: MatchStatus
}

/** One fixture, ready to render as a named "A vs B" line. */
export interface FixtureLine {
  id: string
  position: number
  a: FixtureSide
  b: FixtureSide
  /** The real match this slot became at go-live, or `null` while it is still a *planned*
   * pairing. When set, the line links to that match and shows its status; when `null` the
   * line is inert (#788). */
  match: FixtureMatch | null
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
      /** Fixtures belonging to **no pool** — an un-pooled draw (single-elim), or the
       * knockout stage of a combined draw type (#787; ADR-0786: `pool_id` is `null` for
       * both). A fixture that has no pool must not be *dropped*: it is rendered as a
       * bracket (#785), and anything a bracket cannot place is still shown, honestly,
       * outside the pools. */
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

/** The materialized match of a fixture, or `null` while it is un-materialized.
 *
 * `matchId` and `matchStatus` move in lockstep on the wire, so the `&&` is a belt: a
 * fixture carrying an id but no status (a shape the server never sends) is treated as
 * un-materialized rather than rendered as a link to a match whose state we cannot show. */
function matchOf(fixture: Fixture): FixtureMatch | null {
  if (fixture.matchId === null || fixture.matchStatus === null) return null
  return { id: fixture.matchId, status: fixture.matchStatus }
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
          match: matchOf(f),
        })),
    }))
}

/** An event has a draw exactly when it has fixtures — the ONE definition of it, guarded
 * on by `drawState` below and asked by the editor's two freezes.
 *
 * It is deliberately *not* spelled `drawState(event).kind === 'drawn'`. That answers the
 * same yes/no by grouping every fixture into its pool, sorting each round and building
 * two Maps, then throwing all of it away — and the event editor asks it twice on every
 * keystroke. */
const hasDraw = (event: TournamentEvent): boolean => event.fixtures.length > 0

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
  if (!hasDraw(event)) return { kind: 'undrawn' }

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

/**
 * Whether an editor control is **offered**, or **refused with a reason** — the state a
 * cut draw puts two of the event editor's controls in (ADR-0786).
 *
 * A sum type rather than a `disabled: boolean` plus a `reason?: string`, because those
 * two are one decision and the pair makes "disabled with nothing to say" — the
 * unexplained dead end ADR-0015 is about — constructible. Here a frozen control *has*
 * words, by construction; an open one has none to show.
 *
 * The reason is the CLIENT's, not the server's (`DEFINITION_OF_COMPLETE`: raw API detail
 * strings never reach the UI). The server's own sentence still arrives, verbatim, when a
 * director loses the race and the PATCH is refused anyway — that is `save-failure`'s
 * `refused` arm, and it is a different surface for a different moment.
 */
export type EditFreeze =
  | { kind: 'open' }
  | {
      kind: 'frozen'
      /** Why this control is unavailable, and — the load-bearing half — the way out of
       * it: delete the draw, edit, cut it again. Reads standalone in whichever surface
       * shows it (a `Field` hint, an `Alert` beneath the section header). */
      reason: string
    }


/**
 * May the director change **which pools** this event has?
 *
 * Frozen the moment a draw exists, because every fixture names its pool by a string id
 * into that very list: remove a pool (or re-`id` one, which is a removal with an
 * addition standing where it was) and its fixtures point at nothing; add one and it
 * arrives with no fixtures, since the draw was dealt across the pools the event had at
 * the cut. The server refuses it with a 409 (`_enforce_pool_set_frozen`) — this is the
 * client declining to *build* the change the server would refuse.
 *
 * **Only the identity set is frozen**, and the reason says so out loud: a pool's tables,
 * its window and its name stay editable with a draw standing, on purpose. Venues move
 * under a running tournament — a table breaks and is pulled, one frees up early — and a
 * director who could not record that would have to destroy a *correct* draw to move a
 * table. Over-freezing the section would break the very case the freeze exists to
 * preserve.
 */
export function poolSetFreeze(event: TournamentEvent): EditFreeze {
  if (!hasDraw(event)) return { kind: 'open' }
  return {
    kind: 'frozen',
    reason:
      'Every fixture names the pool it was dealt into, so a pool can’t be added or ' +
      'removed while the draw stands. Delete the draw to change them, then cut it ' +
      'again. A pool’s name, its tables and its time window can still be edited right ' +
      'now — a table that breaks mid-event costs you nothing.',
  }
}

/**
 * May the director change this event's **draw type**?
 *
 * Frozen once a draw exists, for the sibling reason (`_enforce_draw_type_frozen`, a 409):
 * the draw type is not a label on an event, it is the strategy that dealt these fixtures.
 * Re-label it under a standing draw and the event claims a shape its draw does not have —
 * a `single-elim` event holding pooled round-robin fixtures, which no bracket can render
 * and no strategy would ever have produced.
 *
 * The reason names the type the fixtures were actually dealt as, in the words the select
 * shows ("Round robin", never `round-robin`).
 */
export function drawTypeFreeze(event: TournamentEvent): EditFreeze {
  if (!hasDraw(event)) return { kind: 'open' }
  const label = labelFor(DRAW_TYPE_OPTIONS, event.drawType, event.drawType)
  return {
    kind: 'frozen',
    reason:
      `This event’s draw is cut, so its draw type is frozen — its fixtures were dealt ` +
      `as a “${label}” draw. Delete the draw to change the type, then cut it again.`,
  }
}

/** A refusal, in the panel's own voice: a title this client owns, and a sentence
 * beneath it that — for the two refusals that matter — is the **server's**.
 *
 * The shape (and the `Couldn't <verb>` fallback below) is shared with the header's
 * lifecycle refusals, which report the same way for the same reason — see `./notice`. */
export type DrawNotice = Notice

/**
 * Turn a failed draw verb into inline copy.
 *
 * `verb` completes "Couldn't <verb>" for the failures that have no designed state of
 * their own ("cut the draw", "remove the draw").
 *
 * **The 409 and the 422 carry the server's own sentence, verbatim.** They are the two
 * refusals a director actually meets, and for both of them the sentence is the *point*:
 * it names the thing they have to change ("5 entrants across 3 pool(s) would leave a
 * pool with fewer than 2 entrants…", "A round-robin draw needs at least one pool."). It is authored
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
  const fallback = fallbackNotice(error, verb)
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
    // A 5xx and any unrecognised status land here. The 5xx is safe *because of the
    // floor*, not because of this arm: `fallbackNotice` will not echo a 5xx detail
    // (see `./notice`), so what renders is "Couldn't cut the draw — something went
    // wrong on our end" and never the server's stack-shaped sentence.
    default:
      return fallback
  }
}
