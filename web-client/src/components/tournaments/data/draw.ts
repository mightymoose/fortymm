// What an event's **draw** looks like to a reader (ADR-0786) — the pure derivation
// behind the Events tab's draw panel, and the copy behind its refusals.
//
// The wire gives us a flat list of `Fixture`s (parsed at the boundary by `./fixtures`)
// and, separately, the event's `groups` and `entrants`. A director reads a draw as
// **group → round → fixture**, with *names* on it. Nothing on the wire is shaped that
// way, and deliberately so:
//
// - **Names are not on a fixture.** It carries entry *ids*; the usernames behind them
//   are already on the event (`entrants` is keyed by that id), so the join happens here,
//   once. Copying the username onto the fixture would be carrying a field and its own
//   derivation, and the two copies would drift the moment a player is renamed.
// - **Group membership is not stored.** ADR-0786: it is derived from the fixtures
//   themselves, exactly as `entered` is derived from the entries (ADR-0016).
// - **A bye is the ABSENCE of a fixture**, never a row. An odd group simply has fewer
//   fixtures in some rounds. Nothing here invents a fixture to stand for one, and nothing
//   asks the server for a "byed entrant" field — a stored one would be a second,
//   drift-prone copy of the planner's rotation. For a **swiss** round, whose whole field
//   is one table, the absence is read back off the data already here (`SwissByes`): the
//   event's entrants minus the entry ids the round's fixtures name. A group's bye is not
//   derived, because "in no fixture of this group" also describes every entrant in the
//   other groups.
// - **A group carries no name.** It is server-owned (ticket #1369) — only its
//   `position` is a fact about it — so everywhere this module once printed a
//   director-typed name it now prints `Group ${groupLetter(position)}` (`./draw-structure`).
//
// All of it is a pure function of one event, so it is unit-tested (`./draw.test.ts`)
// rather than asserted through a DOM.

import { ApiError } from '@/api/client'
import type { MatchStatus } from '@/api/matches'

import { groupLetter } from './draw-structure'
import { inPositionOrder } from './helpers'
import { fallbackNotice, type Notice } from './notice'
import { labelFor } from './options'
import type {
  DrawType,
  DrawTypeOption,
  Entrant,
  Fixture,
  Group,
  Reservation,
  Stage,
  StageDrawType,
  TournamentEvent,
} from './types'

/**
 * Resolve one fixture's **group and reservation** via the two-hop lookup ticket #1369
 * introduced: fixture → `groupId` → that group's `reservationId` → the reservation in
 * the event's `reservations`.
 *
 * Both hops tolerate an unresolved id rather than throwing: a fixture whose `groupId`
 * names no entry of `event.groups` is a domain-legal state (a knockout fixture simply
 * has none, and it is shown in the ungrouped block, never dropped — `drawState` below).
 * A group's `reservationId` is guaranteed to resolve by the API's own NOT NULL
 * constraint (`GroupRead`, `schema.d.ts`) — parsed and rejected at the boundary if it
 * ever didn't (`./api`) — but this lookup stays tolerant of both hops for one reason:
 * it is a plain JS `Map`/`find` over already-parsed data, and the one thing worth
 * asserting once is the wire's own guarantee, at the boundary where it is checked.
 */
export function fixtureReservation(
  event: TournamentEvent,
  fixture: Pick<Fixture, 'groupId'>,
): { group: Group | null; reservation: Reservation | null } {
  const group =
    fixture.groupId !== null
      ? (event.groups.find((g) => g.id === fixture.groupId) ?? null)
      : null
  const reservation =
    group !== null
      ? (event.reservations.find((r) => r.id === group.reservationId) ?? null)
      : null
  return { group, reservation }
}

/** `Group A`, `Group B`, … — the one label a group ever renders as (ticket #1369: a
 * group is server-owned and carries no name of its own). */
export function groupLabel(group: Pick<Group, 'position'>): string {
  return `Group ${groupLetter(group.position)}`
}

/** A fixture side whose occupant is not decided yet (`entryAId`/`entryBId` is
 * `null` — ADR-0786: "**TBD**, never a bye"). Round-robin never produces one. A knockout
 * round does, because the fixture that feeds it is undecided — and **swiss produces the
 * most of them**, for a different reason: every round past the first is cut up front with
 * *both* sides `null` and stays that way until `advance()` pairs it from the standings.
 * Either way it is the state the panel must render as a word rather than as a blank
 * half-line. */
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

/** The fixtures of one round, in position order. An odd round-robin group has *fewer*
 * of them in some rounds — the player drawn against the phantom seat sits that round
 * out — and that absence is the whole representation of a bye. */
export interface DrawRound {
  round: number
  fixtures: FixtureLine[]
}

/**
 * Who **sits out** each round of a swiss draw, keyed by round number — derived, never
 * sent.
 *
 * A bye is still the ABSENCE of a fixture (the file header above, ADR-0786): nothing here
 * invents a fixture row, and nothing asks the server for a new field. It is set
 * subtraction over data already on the page — the event's entrants, minus the entry ids
 * that round's fixtures name.
 *
 * A round that is **not in the map** byes nobody, and there are three ways to be absent:
 * the draw type is not swiss, the field is even (an even field seats everybody), or the
 * round is **not paired yet**. That last one is the load-bearing case: a swiss draw cuts
 * every round up front with both sides null, so in a forthcoming round *every* entrant is
 * "in no fixture" — and a renderer that subtracted anyway would list the whole field under
 * every round the event has not reached.
 *
 * The value is a **list**, not one entrant, because a stale draw (entries taken since the
 * cut — CONTEXT.md's "current" draw) genuinely leaves more than one player unseated. It
 * names whoever is not in the round, honestly, rather than guessing which of them the
 * planner would have byed.
 */
export type SwissByes = ReadonlyMap<number, Entrant[]>

/** One group of a cut draw: the group's position-derived label (`groupLabel` — a group
 * carries no stored name of its own, ticket #1369), the entrants the draw dealt into it
 * (derived from its fixtures), and those fixtures grouped by round. */
export interface GroupDraw {
  id: string
  label: string
  /** The group's members, in **draw order** (see `drawOrder`). Derived from the
   * fixtures, never stored (ADR-0786). */
  entrants: Entrant[]
  rounds: DrawRound[]
}

/**
 * How an event's **un-grouped fixtures read** — the one decision that says which view the
 * draw panel gives them.
 *
 * It is a fact about the fixtures' own **stage's draw type** (`shapeForStage` below),
 * never about `groupId` being null: `group_id IS NULL` only ever said "this fixture has no
 * group", and reading it as "this is a bracket" once conflated a null-grouped swiss round
 * with a null-grouped knockout one and rendered the swiss draw through
 * single-elimination's successor arithmetic — the one thing the ADR says swiss does not
 * have. `stageId` (ADR 20260815) removed the guesswork: it names the stage outright.
 *
 * A third answer exists because the first two are both *claims about a format*, and one case
 * can make neither: a round-robin fixture naming a group the event does not list (or, more
 * generally, an un-grouped fixture whose own stage runs round-robin, or one naming a stage
 * this event does not have). It is shown — nothing is ever dropped — as `'orphaned'`, which
 * says only that.
 */
export type UngroupedShape =
  /** Rounds-as-columns, named back from the final (`Bracket`). */
  | 'bracket'
  /** A flat list of rounds, the unpaired ones announced as forthcoming (`SwissRounds`). */
  | 'swiss-rounds'
  /** Nothing this event's format can place: a plain list of the fixtures, under a neutral
   * heading (`RoundList`). The honest shape for a fixture the format view has no home for —
   * shown, because a fixture is never dropped, and named nothing it is not. */
  | 'orphaned'

/**
 * Which view a **stage's own** un-grouped fixtures get — **exhaustive over
 * `StageDrawType`, with no catch-all**, so a fifth single-stage draw type is a compile
 * error here until somebody says how its draw reads. `StageDrawType` excludes
 * `rr-then-ko` by construction (ADR 20260815 decision 4 — that member names a template,
 * never a runnable stage's own type), so there is no arm for it to reach: the routing
 * this replaced needed one (`ungroupedShape(DrawType)`'s old `'rr-then-ko'` case), and a
 * fifth arm is precisely the class of thing that let a stray value check drift.
 *
 * A `round-robin` stage answers `'orphaned'`, never `'bracket'`: a round-robin draw has
 * no un-grouped fixtures the server can legitimately send (every fixture is dealt into a
 * group), so one reaching here names a group the event does not list — a payload that
 * cannot legitimately arise, and `drawState` deliberately does not DROP it (see below).
 * `Bracket` names its rounds backwards from the last round present, so a single stray
 * fixture rendered inside a section headed "Bracket" would read its round as a "Final" —
 * a knockout this event does not have, a final nobody played.
 */
export function shapeForStage(stageDrawType: StageDrawType): UngroupedShape {
  switch (stageDrawType) {
    case 'single-elim':
      return 'bracket'
    case 'round-robin':
      return 'orphaned'
    case 'swiss':
      // Group-less by design, and NOT a bracket: nobody is eliminated, `position` is a
      // pairing rank rather than a topology, and rounds past the first are cut with both
      // sides unknown until `advance()` pairs them.
      return 'swiss-rounds'
    default: {
      const exhaustive: never = stageDrawType
      return exhaustive
    }
  }
}

/**
 * Which view an event's **un-grouped block** gets — the shape `drawState` actually reads
 * off, resolved from the stage(s) the un-grouped fixtures name.
 *
 * Only one draw type is multi-stage (ADR 20260815, "Only one draw type is multi-stage"),
 * so an event has **at most one** stage whose own draw type calls for an un-grouped view
 * of its own (single-elim or swiss) — `rr-then-ko`'s group stage always deals every
 * fixture into a group, so nothing of its round-robin stage should legitimately land
 * here. That is why this scans for, and returns, the first fixture's stage that is NOT
 * `round-robin`: it is the real block (the knockout stage of an `rr-then-ko` draw, or
 * the sole stage of a single-elim/swiss event), and it wins over an orphaned round-robin
 * anomaly sharing the same un-grouped list. Nothing but `round-robin` stages (or a
 * fixture naming a stage this event does not have) leaves every fixture `'orphaned'`.
 */
function ungroupedShapeOf(event: TournamentEvent, ungrouped: readonly Fixture[]): UngroupedShape {
  const stagesById = new Map(event.stages.map((s): [string, Stage] => [s.id, s]))
  for (const fixture of ungrouped) {
    const stage = stagesById.get(fixture.stageId)
    if (stage && stage.drawType !== 'round-robin') return shapeForStage(stage.drawType)
  }
  // Every un-grouped fixture (if any) belongs to a round-robin stage, or names a stage
  // this event does not have — an anomaly either way, shown honestly as itself.
  return 'orphaned'
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
      /** The groups the draw actually used, in the event's own group order. */
      groups: GroupDraw[]
      /** Fixtures belonging to **no group** — a group-less draw (single-elim, swiss), or the
       * knockout stage of an `rr-then-ko` draw (ADR 20260815: `group_id` is `null` for all
       * of them). A fixture that has no group must not be *dropped*: it is rendered,
       * honestly, outside the groups.
       *
       * **Which view it gets is `ungroupedShape` below, not this list.** */
      ungrouped: DrawRound[]
      /** How `ungrouped` reads — decided from the fixtures' own **stage**'s draw type
       * (`ungroupedShapeOf`), once, here, so no renderer has to infer a format from a null
       * group id, or from the event's overall (possibly composite) draw type. */
      ungroupedShape: UngroupedShape
      /** Who sits out each **paired swiss round**, by round number (`SwissByes`). Empty
       * for every other draw type — an entrant missing from a bracket round is
       * eliminated, not byed. */
      swissByes: SwissByes
    }

/**
 * The order the draw dealt a group's entrants in: **seed ascending where one is set,
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
 * It **sorts**, rather than trusting the payload's order (the server sends group → round
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

/**
 * The entrants a **swiss** round leaves out — the byes (`SwissByes`), computed once from
 * the event's entrants and its un-grouped fixtures.
 *
 * Three gates, and each one is a different fact:
 *
 * 1. **The un-grouped block's shape is swiss.** A bracket's un-grouped rounds are the same
 *    shape, and an entrant missing from one of those is *eliminated*, not byed — naming
 *    them "Bye" would be the same class of lie as rendering a swiss draw as a knockout
 *    (`ungroupedShapeOf`). Asked of the resolved `shape` rather than re-resolved here, so
 *    the caller's one derivation is the only one — a second call could disagree with the
 *    first on which stage's fixtures these are.
 * 2. **The field is odd.** An even field seats everybody, so "nobody sits out" is not news
 *    — it is a line on every round of every event, saying nothing.
 * 3. **The round is paired.** Asked of the fixtures' entry ids, exactly as the renderer
 *    asks it of the sides: a cut-but-unpaired round names nobody at all, so subtracting
 *    would report the entire field as sitting out a round that has not been drawn yet.
 *
 * A withdrawn entry counts as seated — its id is on the fixture, and it is that presence
 * that makes the draw *stale* (`WITHDRAWN_LABEL`). It is not in `entrants`, so it never
 * appears as a bye either way.
 */
function swissByesOf(
  event: TournamentEvent,
  ungrouped: Fixture[],
  shape: UngroupedShape,
): SwissByes {
  const byes = new Map<number, Entrant[]>()
  if (shape !== 'swiss-rounds') return byes
  if (event.entrants.length % 2 === 0) return byes

  const seatedByRound = new Map<number, Set<string>>()
  for (const fixture of ungrouped) {
    const seated = seatedByRound.get(fixture.round) ?? new Set<string>()
    if (fixture.entryAId !== null) seated.add(fixture.entryAId)
    if (fixture.entryBId !== null) seated.add(fixture.entryBId)
    seatedByRound.set(fixture.round, seated)
  }

  const inDrawOrder = drawOrder(event.entrants)
  for (const [round, seated] of seatedByRound) {
    // Nobody seated at all — the round is cut but not yet paired. Gate 3.
    if (seated.size === 0) continue
    // In draw order, the order every other list of entrants on this page is in.
    const sittingOut = inDrawOrder.filter((entrant) => !seated.has(entrant.id))
    // A round that byes nobody is simply absent — never a key holding an empty list,
    // which a renderer would have to ask about twice. (Reachable on a stale draw whose
    // field has SHRUNK: the round seats withdrawn ids, and every current entrant plays.)
    if (sittingOut.length > 0) byes.set(round, sittingOut)
  }
  return byes
}

/** An event has a draw exactly when it has fixtures — the ONE definition of it, guarded
 * on by `drawState` below and asked by the editor's two freezes.
 *
 * It is deliberately *not* spelled `drawState(event).kind === 'drawn'`. That answers the
 * same yes/no by grouping every fixture into its group, sorting each round and building
 * two Maps, then throwing all of it away — and the event editor asks it twice on every
 * keystroke. */
const hasDraw = (event: TournamentEvent): boolean => event.fixtures.length > 0

/**
 * Whether this event's draw shows **evidence of play** — the client's mirror of the
 * server's `draw_has_play` (`api/app/tournament_draws.py`), which is the one thing a
 * cut, a re-cut and an un-cut are refused for (ADR-0786).
 *
 * The two halves are deliberately **not one condition**, because they are two different
 * facts:
 *
 * - a **winner** — the fixture is decided, and a result exists to be thrown away;
 * - a **linked match** — the fixture has materialized into a real match (#788), which may
 *   already carry games on its scratchpad or a proposed result. A merely-linked match is
 *   enough on its own: replacing the draw wholesale would orphan that match along with
 *   whatever has been entered on it, and a draw must never silently eat a score.
 *
 * ⚠️ Read straight off the **parsed fixture**, never through `matchOf` / `FixtureLine`.
 * That helper wants an id *and* a status before it will render a link, and being stricter
 * about what is renderable is right for a renderer — but the server refuses on the id
 * alone. Routing this question through it would make the client **laxer** than the guard
 * it is restating, and a fixture with an id and no status would show a live verb that can
 * only 409.
 *
 * Not gated on `hasDraw`: an undrawn event has no fixtures, so this is already false, and
 * a gate would say the condition is *drawn-ness* when it is *evidence*.
 */
const drawIsUnderWay = (event: TournamentEvent): boolean =>
  event.fixtures.some((f) => f.winnerEntryId !== null || f.matchId !== null)

/**
 * An event's draw, shaped for the reader: groups with their members and rounds, or the
 * designed `undrawn` state.
 *
 * Two things it deliberately does *not* do:
 * - It does not announce a group the draw never used. A group with no fixtures is not
 *   part of the draw, and the group *set* is frozen while a draw exists (ADR-0786), so
 *   this filter cannot hide a group a director added afterwards — there is no such group.
 * - It does not drop a fixture. One whose `groupId` is `null`, or names a group this
 *   event does not have, lands in `ungrouped` — visible, rather than silently gone. This
 *   is the domain's own tolerance (`./types`, `Fixture.groupId`), and it is deliberately
 *   the mirror image of the event parser's rejection (`./api`): a `groups[].reservationId`
 *   naming no reservation is a parse failure (unreachable from a correct server), while a
 *   fixture's `groupId` naming no group is a state the domain genuinely allows.
 */
export function drawState(event: TournamentEvent): DrawState {
  if (!hasDraw(event)) return { kind: 'undrawn' }

  const byId = new Map(event.entrants.map((e) => [e.id, e]))
  const groupIds = new Set(event.groups.map((g) => g.id))
  const byGroup = new Map<string, Fixture[]>()
  const ungrouped: Fixture[] = []
  for (const fixture of event.fixtures) {
    const groupId = fixture.groupId
    if (groupId === null || !groupIds.has(groupId)) {
      ungrouped.push(fixture)
      continue
    }
    const bucket = byGroup.get(groupId)
    if (bucket) bucket.push(fixture)
    else byGroup.set(groupId, [fixture])
  }

  // **In POSITION order** (`inPositionOrder`), which is the order the director arranged
  // them in and the order the event editor shows them in — not the order they arrived
  // in, and emphatically not by id: reservation-derived ids sort by nothing meaningful,
  // which is exactly the bug `inPositionOrder`'s own history documents (`./helpers`).
  const groups: GroupDraw[] = inPositionOrder(event.groups).flatMap((group) => {
    const fixtures = byGroup.get(group.id)
    if (!fixtures) return []
    // Membership is the entry ids the group's own fixtures name — the derivation
    // ADR-0786 chose over an entrant↔group table. A withdrawn entry is named by the
    // fixtures and listed by nobody, so it is not a member: it is not an entrant at all
    // (ADR-0016). Its fixtures still say `Withdrawn`, which is how the staleness shows.
    const memberIds = new Set<string>()
    for (const f of fixtures) {
      if (f.entryAId !== null) memberIds.add(f.entryAId)
      if (f.entryBId !== null) memberIds.add(f.entryBId)
    }
    return [
      {
        id: group.id,
        label: groupLabel(group),
        entrants: drawOrder(event.entrants.filter((e) => memberIds.has(e.id))),
        rounds: roundsOf(fixtures, byId),
      },
    ]
  })

  // Read off the un-grouped fixtures' own STAGE, never off the null group id they were
  // bucketed by above — see `ungroupedShapeOf`. Resolved once, here, so `swissByes`
  // reads the same answer rather than re-deriving it.
  const shape = ungroupedShapeOf(event, ungrouped)

  return {
    kind: 'drawn',
    groups,
    ungrouped: roundsOf(ungrouped, byId),
    ungroupedShape: shape,
    // Computed from the entry IDS, here, where they are — the same join `roundsOf` makes
    // for the names, and the reason this is not the renderer's job: a `FixtureLine` has
    // usernames on it and no ids at all.
    swissByes: swissByesOf(event, ungrouped, shape),
  }
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
      /** Why this control is unavailable — and, **when there is one**, the way out of it:
       * delete the draw, edit, cut it again. Reads standalone in whichever surface shows
       * it (a `Field` hint, an `Alert` beneath the section header).
       *
       * The way out is the load-bearing half of the two config freezes, and it is the
       * thing `drawVerbFreeze` must NOT invent: a draw that is under way stays that way,
       * so a sentence ending "delete the draw, then cut it again" would name an escape
       * that is itself refused. A refusal with no exit says so, plainly, and stops. */
      reason: string
    }


/**
 * May the director change **which groups** this event has?
 *
 * Frozen the moment a draw exists, because every fixture names its group by a string id
 * into that very list: remove a group (or re-`id` one, which is a removal with an
 * addition standing where it was) and its fixtures point at nothing; add one and it
 * arrives with no fixtures, since the draw was dealt across the groups the event had at
 * the cut. Since a group is minted 1:1 with a reservation (ticket #1369), what a director
 * actually edits is `reservations` — adding, removing or reordering a reservation adds,
 * removes or reorders its mapped group the same way. The server refuses it with a 409
 * (`_enforce_group_set_frozen`) — this is the client declining to *build* the change the
 * server would refuse.
 *
 * **Only the identity set is frozen**, and the reason says so out loud: a reservation's
 * tables, its window and its name stay editable with a draw standing, on purpose. Venues
 * move under a running tournament — a table breaks and is pulled, one frees up early —
 * and a director who could not record that would have to destroy a *correct* draw to
 * move a table. Over-freezing the section would break the very case the freeze exists to
 * preserve.
 */
export function groupSetFreeze(event: TournamentEvent): EditFreeze {
  if (!hasDraw(event)) return { kind: 'open' }
  return {
    kind: 'frozen',
    reason:
      'Every fixture names the group it was dealt into, so a reservation can’t be ' +
      'added or removed while the draw stands. Delete the draw to change them, then ' +
      'cut it again. A reservation’s name, its tables and its time window can still ' +
      'be edited right now — a table that breaks mid-event costs you nothing.',
  }
}

/**
 * May the director change this event's **draw type**?
 *
 * Frozen once a draw exists, for the sibling reason (`_enforce_draw_type_frozen`, a 409):
 * the draw type is not a label on an event, it is the strategy that dealt these fixtures.
 * Re-label it under a standing draw and the event claims a shape its draw does not have —
 * a `single-elim` event holding grouped round-robin fixtures, which no bracket can render
 * and no strategy would ever have produced.
 *
 * The reason names the type the fixtures were actually dealt as, in the words the select
 * shows ("Round robin", never `round-robin`) — which is why it takes the **served**
 * catalogue (`drawTypes`, ADR 20260726) rather than reading a list of its own: the
 * sentence quotes the option the director is looking at, and there is now exactly one
 * source for that copy.
 *
 * If the catalogue has no row for the stored type — a build that does not know the slug,
 * or a surface handed an empty catalogue — the clause naming it is **dropped**, not
 * filled with the raw key. "…dealt as a “round-robin” draw" would be the very leak
 * `labelFor` exists to prevent, and the freeze reads perfectly well without it: what a
 * stuck director needs is the way out, and that half never depended on the label.
 */
export function drawTypeFreeze(
  event: TournamentEvent,
  drawTypes: DrawTypeOption[],
): EditFreeze {
  if (!hasDraw(event)) return { kind: 'open' }
  const label = labelFor(drawTypes, event.drawType, null)
  const dealtAs = label === null ? '' : ` — its fixtures were dealt as a “${label}” draw`
  return {
    kind: 'frozen',
    reason:
      `This event’s draw is cut, so its draw type is frozen${dealtAs}. ` +
      `Delete the draw to change the type, then cut it again.`,
  }
}

/**
 * May the director **re-cut or remove** this event's draw?
 *
 * The third freeze, and the one whose refusal has **no way out**. Its two siblings are
 * about an event's *configuration* — change the draw type, change the group set — and both
 * end by telling the director how to get unstuck, because deleting the draw really does
 * unstick them. This one is about the draw *itself*, and once it shows evidence of play
 * (`drawIsUnderWay`) neither verb is available again: deleting the draw is the very act
 * being refused, so there is no exit to name and this reason does not invent one.
 *
 * Frozen on the **evidence**, never on the tournament's status. That is ADR-0786's choice
 * and the panel must not tighten it: a director may cut and re-cut right up to the moment
 * the first fixture becomes real, which is the day-of re-cut the ADR deliberately
 * preserves. (Going live is what usually produces the evidence — `materialize_live_draw`
 * gives every ready fixture a `match_id` — but it is the `match_id` that seals the draw,
 * not the status.)
 *
 * **The reason must be true of a match nobody has played**, and that is the whole reason
 * it is worded the way it is. Go-live stamps a `match_id` on *every* ready fixture in one
 * transaction, so the ordinary frozen draw has real matches and **zero results** — a
 * sentence claiming a re-cut would discard a result somebody played for would be false in
 * the commonest case this freeze meets. The server's own guard is careful about exactly
 * this: a linked match "**may** already carry games" (`_enforce_unplayed`). So the result
 * is named as one of two alternatives, never as a fact.
 *
 * The server remains the enforcement: `_enforce_unplayed` answers **409**, and
 * `drawRefusalNotice`'s 409 arm is still there for the director who loses the race
 * between a page load and the first score. What this buys is a better refusal — a verb
 * that says why it cannot be used, instead of a click that can only fail (#1060).
 */
export function drawVerbFreeze(event: TournamentEvent): EditFreeze {
  if (!drawIsUnderWay(event)) return { kind: 'open' }
  return {
    kind: 'frozen',
    reason:
      'This event’s draw is under way: one of its fixtures is a real match now, or ' +
      'carries a result somebody played for. Re-cutting or removing the draw would ' +
      'take that back from the players.',
  }
}

/** A refusal, in the panel's own voice: a title this client owns, and a sentence
 * beneath it that — for the two refusals that matter — is the **server's**.
 *
 * The shape (and the `Couldn't <verb>` fallback below) is shared with the header's
 * lifecycle refusals, which report the same way for the same reason — see `./notice`. */
export type DrawNotice = Notice

/**
 * The facts a draw refusal is **about**, as one string — what `useScopedNotice` pins the
 * panel's notice to, so a refusal clears itself once the director fixes what it named
 * (#1049, #1123).
 *
 * Every refusal behind the 422 is a statement about the event **as it stands**, and the
 * scope has to carry each thing one of those sentences tells the director to change:
 *
 * - the **format**, for "a doubles event cannot be given a draw — draws are singles-only";
 * - the **draw type and its settings** (`drawConfig`), for "a single-elim draw cannot be
 *   cut yet", "take fewer qualifiers from each group", "play fewer rounds";
 * - the **groups**, for "a round-robin draw needs at least one group";
 * - the **seating** (`drawSeating`), for "5 entrants across 3 groups would leave a
 *   group with fewer than 2", and for the 409's evidence of play.
 *
 * That list is the whole design, and getting it short is how the mechanism fails: a
 * refusal naming something the scope does not read survives the director doing exactly
 * what it asked, which is #1123 again wearing a different sentence. The settings half goes
 * through `drawConfig` rather than being listed here so that a fifth draw type cannot
 * acquire a setting without acquiring a compile error.
 *
 * Narrow, still. The event's name, slot, entry fee, predicates and match settings are all
 * absent: no draw refusal asserts anything about them, and this page polls, so a wider
 * scope would drop the sentence a director is mid-way through acting on. Group **ids**
 * rather than group contents, because a group with the same id refuses exactly as it did
 * before — its own reservation's name is not part of this scope at all.
 */
export function drawRefusalScope(event: TournamentEvent): string {
  return [
    event.format,
    drawConfig(event),
    drawSeating(event),
    event.groups.map((group) => group.id).join(','),
  ].join('|')
}

/**
 * The draw type **and the settings that type actually has** — the configuration half of
 * `drawRefusalScope`.
 *
 * A `switch` with a `never` default, so a fifth draw type is a compile error here until
 * somebody says which settings its refusals turn on. That is the entire reason this is a
 * function and not two more fields inlined above: the cut refuses an `rr-then-ko` event
 * whose K exceeds its smallest group ("take fewer qualifiers from each group") and a `swiss`
 * event whose R exceeds a rematch-free field ("play fewer rounds"), and a scope blind to
 * those two numbers would leave both sentences on screen after the director lowered them.
 *
 * It mirrors `drawSettingsToApi` (`./api`) deliberately rather than importing it: that one
 * builds a request body and lives in the mutation layer, and pulling `./api` in here would
 * drag react-query, the router and the toaster into a module that is pure derivation.
 */
function drawConfig(
  event: Pick<TournamentEvent, 'drawType' | 'qualifiersPerGroup' | 'rounds'>,
): string {
  switch (event.drawType) {
    case 'rr-then-ko':
      return `rr-then-ko:${event.qualifiersPerGroup}`
    case 'swiss':
      return `swiss:${event.rounds}`
    case 'round-robin':
    case 'single-elim':
      // No setting of their own: the refusals these two produce are about the groups and
      // the field, both of which the scope reads separately.
      return event.drawType
    default: {
      const exhaustive: never = event.drawType
      return exhaustive
    }
  }
}

/**
 * **Who is entered, and who the draw currently seats against whom** — the one fact both
 * the draw panel's refusals and go-live's precondition turn on.
 *
 * The counts alone are not enough, and the case that proves it is the exact one the
 * stale-draw refusal exists for: registration stays open right up to go-live, so
 * "somebody entered, somebody withdrew" leaves `entered` **unchanged** while the standing
 * draw now seats a player who has left. Re-cutting over that field fixes it and leaves
 * the fixture count unchanged too — so a scope built from the two counts is byte-identical
 * before and after the fix, and the refusal telling the director to re-cut would survive
 * their re-cutting. Reading the *identities* is what makes the fix visible.
 *
 * The draw half is read as fixture **ids**, not as the entry ids seated in them, and that
 * is a correction rather than a shortcut. A cut is wholesale — the server deletes every
 * fixture for the event and plans a fresh set (`cut_draw`, `api/app/tournament_draws.py`)
 * — so a re-cut mints new ids and the scope moves, which is the case this function exists
 * for. Reading the seated sides instead *also* moved it for a reason nobody asked about:
 * a knockout side is `null` until the fixture feeding it is decided (`TBD_LABEL`), so
 * every completed match during live play rewrote the string and blinked the director's
 * standing notice off the screen mid-read.
 *
 * Everything else on a fixture is pointedly absent for the same reason: `scheduledStart`,
 * `pinnedAt`, `matchStatus`, `callNotifiedCount` and `completedAt` all move on a poll
 * tick, on a call, and on every score, and none of them is something a draw refusal or a
 * go-live refusal says anything about.
 */
export function drawSeating(event: TournamentEvent): string {
  return [
    event.entrants.map((entrant) => entrant.id).join(','),
    event.fixtures.map((fixture) => fixture.id).join(','),
  ].join(';')
}

/**
 * What cutting this event's draw would actually **do**, in the director's words — the
 * second half of the "No draw yet." empty state on an un-cut event.
 *
 * Exhaustive over `DrawType` with a `never` default, so a fifth draw type is a compile
 * error here until somebody says what its cut produces. It has to be its own table:
 * the sentence was a single hard-coded round-robin one ("deal this event's entrants into
 * its groups"), which rendered on **every** event regardless of type, and told the director
 * of a single-elimination event to deal entrants into groups a bracket does not have
 * (#1220). The copy was written for #786's round-robin and was simply unreachable on a
 * bracket until single-elimination became cuttable through the UI.
 *
 * Deliberately **not** derived from `ungroupedShape`: that function answers a different
 * question — which view already-cut, group-less *fixtures* get — and an un-cut event has no
 * fixtures to ask about. Routing this off it would be the same class of mistake as the
 * `group_id IS NULL` check it replaced: a predicate borrowed from one question to answer
 * another it only coincidentally agrees with. (They already disagree: round-robin answers
 * `'orphaned'` there, which says nothing about what a cut deals into.)
 */
export function undrawnLead(drawType: DrawType): string {
  switch (drawType) {
    case 'round-robin':
      return 'Generate the draw to deal this event’s entrants into its groups and plan their fixtures.'
    case 'rr-then-ko':
      // Both stages, in the order they are played: the group stage is what the cut deals
      // now, and the bracket is what the qualifiers reach — naming only the first would
      // describe half the draw this event is about to get.
      return 'Generate the draw to deal this event’s entrants into its groups, then bracket the qualifiers from each one.'
    case 'single-elim':
      return 'Generate the draw to seed this event’s entrants into a bracket and plan their fixtures.'
    case 'swiss':
      // "Pair into rounds", never "seed into a bracket": swiss eliminates nobody, so a
      // bracket's vocabulary would be a lie in the empty state before it was one in the
      // draw (`ungroupedShape` makes the same distinction for the cut draw).
      return 'Generate the draw to pair this event’s entrants into rounds and plan their fixtures.'
    default: {
      const exhaustive: never = drawType
      return exhaustive
    }
  }
}

/**
 * Turn a failed draw verb into inline copy.
 *
 * `verb` completes "Couldn't <verb>" for the failures that have no designed state of
 * their own ("cut the draw", "remove the draw").
 *
 * **The 409 and the 422 carry the server's own sentence, verbatim.** They are the two
 * refusals a director actually meets, and for both of them the sentence is the *point*:
 * it names the thing they have to change ("5 entrants across 3 groups would leave a
 * group with fewer than 2 entrants…", "A round-robin draw needs at least one group."). It is authored
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
    // The planner refuses this event as it stands: an unsupported draw type, no groups,
    // or a group that would get fewer than two entrants.
    case 422:
      return {
        title: "This event can't be drawn yet",
        description:
          error.detail ??
          'This event cannot be planned as it stands. Check its draw type and its groups.',
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
