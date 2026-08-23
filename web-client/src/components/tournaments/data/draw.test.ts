import { ApiError } from '@/api/client'

import {
  buildDrawIndex,
  drawRefusalNotice,
  drawRefusalScope,
  drawState,
  drawTypeFreeze,
  drawVerbFreeze,
  fixtureReservation,
  groupSetFreeze,
  seatsBothSidesAtCut,
  shapeForStage,
  undrawnLead,
  type DrawState,
  type FixtureSide,
} from './draw'
import { DRAW_TYPES, STAGE_DRAW_TYPES } from './draw-types'
import {
  buildBracketDrawnEvent,
  buildDrawnEvent,
  buildDrawTypes,
  buildEntrant,
  buildEntrants,
  buildEvent,
  buildFixture,
  buildMaterializedDrawnEvent,
  buildPlayedDrawnEvent,
  buildReservation,
  buildStage,
  buildSwissDrawnEvent,
  buildSwissOddDrawnEvent,
  buildSwissOddMidEvent,
  buildTwoStageDrawnEvent,
  groupIdFor,
} from './seed.factory'
import type { TournamentEvent } from './types'

/** The drawn arm, or a failed assertion — so the tests below can read `.groups`
 * without a cast, and an accidental `undrawn` fails loudly instead of quietly
 * skipping every assertion after it. */
function drawn(state: DrawState) {
  if (state.kind !== 'drawn') {
    throw new Error(`expected a drawn state, got "${state.kind}"`)
  }
  return state
}

/** A group's fixtures as the panel reads them: "player.1 vs player.4", round by round. */
function vsLines(rounds: { round: number; fixtures: { a: FixtureSide; b: FixtureSide }[] }[]) {
  return rounds.map((r) => ({
    round: r.round,
    lines: r.fixtures.map((f) => `${label(f.a)} vs ${label(f.b)}`),
  }))
}

function label(side: FixtureSide): string {
  switch (side.kind) {
    case 'entrant':
      return side.name
    case 'tbd':
      return 'TBD'
    case 'withdrawn':
      return 'Withdrawn'
  }
}

/**
 * **Which view a stage's own ungrouped fixtures get** — a fact about the STAGE'S draw
 * type, and the one this module exists to keep away from `groupId === null`.
 *
 * Two single-stage draw types put fixtures in `ungrouped`, and nothing about the fixtures
 * themselves tells them apart: single-elim's whole bracket and every fixture of a swiss
 * draw carry a null group id. Routing on that null rendered a swiss draw as a knockout
 * bracket, through the successor arithmetic the ADR says swiss does not have — silently,
 * because a value check is not something a type checker can read. `stageId` (ADR
 * 20260815) removed the guesswork: `shapeForStage` reads the stage's own `drawType`.
 */
describe('shapeForStage', () => {
  it('sends swiss to the ROUNDS view — never the bracket', () => {
    expect(shapeForStage('swiss')).toBe('swiss-rounds')
  })

  it('keeps single-elim on the bracket', () => {
    expect(shapeForStage('single-elim')).toBe('bracket')
  })

  /** A round-robin STAGE has no ungrouped fixtures the server can legitimately send —
   * every fixture is dealt into a group. One reaching here names a group the event does
   * not list, which is a payload that cannot legitimately arise — and `drawState` deliberately
   * does not DROP it (see below). It is shown, as itself: `'orphaned'`, a plain list under
   * a neutral heading.
   *
   * It answered `'bracket'` before this module existed, and that was the same lie the
   * swiss routing fix exists to stop: `Bracket` names its rounds backwards from the last
   * round present, so one stray round-robin fixture read as the "Final" of a knockout the
   * event never had. */
  it('gives a round-robin stage’s orphaned fixtures their OWN shape, not the bracket', () => {
    expect(shapeForStage('round-robin')).toBe('orphaned')
  })

  /** Every single-stage draw type this client knows has an answer, and the `switch` has no
   * catch-all — so a fourth member of `STAGE_DRAW_TYPES` is a compile error in `./draw`
   * until somebody says how its draw reads. This asserts the runtime half: nothing falls
   * through to `undefined`. Driven off `STAGE_DRAW_TYPES` rather than a re-typed list, so
   * adding a slug reaches this test without anybody remembering to. `rr-then-ko` cannot
   * even be passed here — `StageDrawType` excludes it (ADR 20260815 decision 4), so there
   * is no case for it to fall through in the first place. */
  it('answers for every stage draw type in the vocabulary', () => {
    for (const drawType of STAGE_DRAW_TYPES) {
      expect(['bracket', 'swiss-rounds', 'orphaned']).toContain(
        shapeForStage(drawType),
      )
    }
  })
})

/**
 * **Bucketing is the stage's decision, never the group id's** (ticket #1483).
 *
 * The server deals a single-elim or swiss stage's fixtures into that stage's one group,
 * so the scheduler can reach their reservation through it. Every one of those fixtures
 * therefore *resolves* a group — and none of them belongs in a group panel. The
 * discriminating part of these fixtures is exactly that: `buildBracketDrawnEvent` and
 * `buildSwissDrawnEvent` name a real group of their event, so a `drawState` that
 * bucketed by `groupId` would put a whole bracket under a heading reading "Group A" and
 * hand `swissByesOf` an empty list.
 */
describe('bucketing by stage, not by group id', () => {
  it('keeps a single-elim event’s whole bracket out of the groups, though every fixture names one', () => {
    const event = buildBracketDrawnEvent()
    // The premise: these fixtures really do resolve a group of this event. Without it
    // the assertions below would pass against the pre-#1483 payload too.
    const groupIds = new Set(event.groups.map((g) => g.id))
    expect(event.fixtures.length).toBeGreaterThan(0)
    for (const fixture of event.fixtures) {
      expect(fixture.groupId).not.toBeNull()
      expect(groupIds.has(fixture.groupId as string)).toBe(true)
    }

    const state = drawn(drawState(event))

    expect(state.groups).toEqual([])
    expect(state.ungroupedShape).toBe('bracket')
    expect(state.ungrouped.flatMap((r) => r.fixtures)).toHaveLength(
      event.fixtures.length,
    )
  })

  it('keeps a swiss event’s rounds out of the groups, and leaves swissByes readable', () => {
    // The ODD-field cut, whose round 1 really byes somebody — that list is one
    // `swissByesOf` can only build from a populated `ungrouped`. Bucketed by group id
    // these fixtures would leave for the group panel, and the round would report no
    // bye at all rather than reporting a wrong one.
    const event = buildSwissOddDrawnEvent()
    expect(event.fixtures.every((f) => f.groupId !== null)).toBe(true)

    const state = drawn(drawState(event))

    expect(state.groups).toEqual([])
    expect(state.ungroupedShape).toBe('swiss-rounds')
    expect(state.swissByes.get(1)?.map((e) => e.username)).toEqual(['player.7'])
  })

  it('still buckets an rr-then-ko group stage into its groups, and its bracket out of them', () => {
    const state = drawn(drawState(buildTwoStageDrawnEvent()))

    expect(state.groups.length).toBeGreaterThan(0)
    expect(state.ungroupedShape).toBe('bracket')
    expect(state.ungrouped.length).toBeGreaterThan(0)
  })
})

/** Exhaustive over the vocabulary, the runtime half of the `never` default — the same
 * discipline `shapeForStage` above is held to. Only a round-robin stage seats both
 * sides at the cut today; the other two pair as the event runs. */
describe('seatsBothSidesAtCut', () => {
  it('answers true for round-robin alone', () => {
    expect(STAGE_DRAW_TYPES.filter(seatsBothSidesAtCut)).toEqual(['round-robin'])
  })

  it('answers for every stage draw type in the vocabulary', () => {
    for (const drawType of STAGE_DRAW_TYPES) {
      expect(typeof seatsBothSidesAtCut(drawType)).toBe('boolean')
    }
  })
})

/**
 * **The falsification for the whole stage-based derivation.** Every OTHER fixture in
 * this suite builds its stages from its event's own `drawType` (`buildEvent`'s default
 * minting), so the stage-based code and the deleted `ungroupedShape(event.drawType)` code
 * agree on every one of them — a regression that quietly went back to reading the EVENT's
 * draw type would still turn this whole file green.
 *
 * This one disagrees on purpose: a `single-elim` EVENT whose one STAGE is hand-set to
 * `swiss`. If `drawState` ever again reads `event.drawType` instead of the fixtures' own
 * `stageId` → `stages` join, this reds — and only this does.
 */
it('reads the STAGE’s draw type, never the event’s, for the ungrouped shape', () => {
  const event = buildBracketDrawnEvent({
    stages: [buildStage({ id: 's-1', position: 0, drawType: 'swiss' })],
  })

  const state = drawn(drawState(event))

  expect(state.ungroupedShape).toBe('swiss-rounds')
})

describe('drawState', () => {
  it('reads an event with no fixtures as the designed UNDRAWN state', () => {
    expect(drawState(buildEvent({ fixtures: [] }))).toEqual({ kind: 'undrawn' })
  })

  it('groups a cut draw into its groups, in the event’s group order', () => {
    const state = drawn(drawState(buildDrawnEvent()))

    expect(state.groups.map((g) => g.label)).toEqual(['Group A', 'Group B'])
    expect(state.ungrouped).toEqual([])
  })

  /** The shape rides the read model, so the panel reads a tag rather than inferring a
   * format from a null group id. Asserted on all three ungrouped draw types, because the
   * payloads they produce are indistinguishable at the fixture level. */
  it('carries the ungrouped SHAPE, read off the event’s draw type', () => {
    expect(drawn(drawState(buildSwissDrawnEvent())).ungroupedShape).toBe(
      'swiss-rounds',
    )
    expect(drawn(drawState(buildBracketDrawnEvent())).ungroupedShape).toBe('bracket')
    expect(drawn(drawState(buildTwoStageDrawnEvent())).ungroupedShape).toBe('bracket')
  })

  /** A swiss draw's rounds all arrive ungrouped — every one of them, from the cut — so the
   * group list is empty and nothing is dropped. */
  it('reads a swiss draw as ungrouped rounds, with every cut round present', () => {
    const state = drawn(drawState(buildSwissDrawnEvent()))

    expect(state.groups).toEqual([])
    expect(state.ungrouped.map((r) => r.round)).toEqual([1, 2, 3])
    expect(state.ungrouped.map((r) => r.fixtures.length)).toEqual([3, 3, 3])
  })

  /**
   * The **bye**, derived: a bye is the absence of a fixture, so the entrant sitting a round
   * out is the one that round's fixtures never name. Nothing on the wire says who it is,
   * and nothing here invents a fixture for them.
   */
  describe('swissByes', () => {
    /** Round 1 of a seven-entrant cut seats six; `entry-7` is in no fixture, so they are
     * the bye — named, in draw order, as an entrant rather than as a bare id. */
    it('names the entrant an odd field leaves out of a paired round', () => {
      const state = drawn(drawState(buildSwissOddDrawnEvent()))

      expect(state.swissByes.get(1)?.map((e) => e.username)).toEqual(['player.7'])
    })

    /** Asked of each round's OWN fixtures. `advance()` byes whoever the standings leave
     * over, which is a different entrant every round. */
    it('follows the round — a later paired round byes somebody else', () => {
      const state = drawn(drawState(buildSwissOddMidEvent()))

      expect(state.swissByes.get(1)?.map((e) => e.username)).toEqual(['player.7'])
      expect(state.swissByes.get(2)?.map((e) => e.username)).toEqual(['player.1'])
    })

    /** A round cut with both sides null names nobody, so *every* entrant is "in no fixture"
     * of it. It has no bye — it has no pairings yet. */
    it('byes nobody in a round that is not paired yet', () => {
      const state = drawn(drawState(buildSwissOddDrawnEvent()))

      expect(state.swissByes.has(2)).toBe(false)
      expect(state.swissByes.has(3)).toBe(false)
    })

    /** An even field seats everybody. Eight entrants over a six-seat round — a *stale*
     * draw, two entries taken since the cut — so there really are entrants in no fixture,
     * and it is the parity that decides there is no bye rather than an empty subtraction. */
    it('byes nobody when the field is even, unseated entrants and all', () => {
      const state = drawn(
        drawState(buildSwissDrawnEvent({ entrants: buildEntrants(8) })),
      )

      expect(state.swissByes.size).toBe(0)
    })

    /**
     * Never for a bracket, whatever the parity. Its rounds are the same ungrouped shape,
     * but an entrant in none of them has been **eliminated** — calling that a bye would be
     * the routing lie again, one layer down.
     *
     * The five-entrant bracket is the case that can fail: `buildBracketDrawnEvent` seats
     * four entrants in its two semifinals, so with an ODD field of five `entry-5` is in no
     * fixture of a **paired** round — the exact input the swiss subtraction answers, on a
     * draw type that must not answer it. The four-entrant default cannot tell the gate from
     * its absence (everybody it lists is seated), so it is here as the ordinary case only.
     */
    it('is empty for every draw type but swiss', () => {
      expect(drawn(drawState(buildBracketDrawnEvent())).swissByes.size).toBe(0)
      expect(
        drawn(
          drawState(buildBracketDrawnEvent({ entrants: buildEntrants(5) })),
        ).swissByes.size,
      ).toBe(0)
      expect(drawn(drawState(buildTwoStageDrawnEvent())).swissByes.size).toBe(0)
    })
  })

  it('lists each group’s entrants — the members its own fixtures name, by NAME', () => {
    const state = drawn(drawState(buildDrawnEvent()))

    // The snake dealt 1/4/5 into Group A and 2/3 into Group B; nothing stores that, so
    // this is derived from the fixtures (ADR-0786).
    expect(state.groups[0].entrants.map((e) => e.username)).toEqual([
      'player.1',
      'player.4',
      'player.5',
    ])
    expect(state.groups[1].entrants.map((e) => e.username)).toEqual([
      'player.2',
      'player.3',
    ])
  })

  it('orders a group’s entrants by SEED first, then registration order', () => {
    // player.5 is seeded 1, so they lead a group they entered last. The unseeded rest
    // keep the order the server listed them in.
    const event = buildDrawnEvent({
      entrants: [
        buildEntrant({ id: 'entry-1', userId: 'u-1', username: 'player.1' }),
        buildEntrant({ id: 'entry-2', userId: 'u-2', username: 'player.2' }),
        buildEntrant({ id: 'entry-3', userId: 'u-3', username: 'player.3' }),
        buildEntrant({ id: 'entry-4', userId: 'u-4', username: 'player.4' }),
        buildEntrant({
          id: 'entry-5',
          userId: 'u-5',
          username: 'player.5',
          seed: 1,
        }),
      ],
    })

    const state = drawn(drawState(event))

    expect(state.groups[0].entrants.map((e) => e.username)).toEqual([
      'player.5',
      'player.1',
      'player.4',
    ])
  })

  it('groups each group’s fixtures by round, in round then position order — with names on them', () => {
    const state = drawn(drawState(buildDrawnEvent()))

    expect(vsLines(state.groups[0].rounds)).toEqual([
      { round: 1, lines: ['player.1 vs player.4'] },
      { round: 2, lines: ['player.1 vs player.5'] },
      { round: 3, lines: ['player.4 vs player.5'] },
    ])
    expect(vsLines(state.groups[1].rounds)).toEqual([
      { round: 1, lines: ['player.2 vs player.3'] },
    ])
  })

  // The ODD group: three players, three rounds, ONE fixture each — the third player sits
  // out. A bye is the ABSENCE of a fixture (ADR-0786), so nothing here emits a row for
  // it, and no round is short of the fixtures it really has.
  it('leaves an odd group’s rounds short a fixture rather than inventing a bye row', () => {
    const state = drawn(drawState(buildDrawnEvent()))

    expect(state.groups[0].rounds.map((r) => r.fixtures.length)).toEqual([1, 1, 1])
    expect(state.groups[0].rounds).toHaveLength(3)
    // Three entrants, three rounds, three fixtures — never four, and never a null side
    // standing in for the player sitting out.
    const sides = state.groups[0].rounds.flatMap((r) =>
      r.fixtures.flatMap((f) => [f.a.kind, f.b.kind]),
    )
    expect(sides).toEqual(Array(6).fill('entrant'))
  })

  it('sorts rounds and positions rather than trusting the payload’s order', () => {
    const shuffled = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-a-r2',
          groupId: groupIdFor('res-a'),
          round: 2,
          position: 2,
          entryAId: 'entry-4',
          entryBId: 'entry-5',
        }),
        buildFixture({
          id: 'fx-a-r1',
          groupId: groupIdFor('res-a'),
          round: 1,
          position: 1,
          entryAId: 'entry-1',
          entryBId: 'entry-2',
        }),
        buildFixture({
          id: 'fx-a-r2-p1',
          groupId: groupIdFor('res-a'),
          round: 2,
          position: 1,
          entryAId: 'entry-1',
          entryBId: 'entry-3',
        }),
      ],
    })

    const state = drawn(drawState(shuffled))

    expect(vsLines(state.groups[0].rounds)).toEqual([
      { round: 1, lines: ['player.1 vs player.2'] },
      {
        round: 2,
        lines: ['player.1 vs player.3', 'player.4 vs player.5'],
      },
    ])
  })

  it('renders a null side as TBD, never as a blank', () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-ko',
          groupId: groupIdFor('res-a'),
          round: 1,
          position: 1,
          entryAId: 'entry-1',
          entryBId: null,
        }),
      ],
    })

    const state = drawn(drawState(event))

    expect(state.groups[0].rounds[0].fixtures[0].a).toEqual({
      kind: 'entrant',
      name: 'player.1',
    })
    expect(state.groups[0].rounds[0].fixtures[0].b).toEqual({ kind: 'tbd' })
  })

  // A withdrawal removes the entry from `entrants` and leaves the cut draw naming it —
  // which is exactly what a STALE draw is. The side says so; it never goes blank, and it
  // never falls back to the raw entry id.
  it('names a side whose entry the event no longer lists as withdrawn — never as a uuid', () => {
    const event = buildDrawnEvent({
      // player.4 withdrew; their fixtures survive the withdrawal.
      entrants: buildEntrants(5).filter((e) => e.id !== 'entry-4'),
    })

    const state = drawn(drawState(event))

    expect(vsLines(state.groups[0].rounds)).toEqual([
      { round: 1, lines: ['player.1 vs Withdrawn'] },
      { round: 2, lines: ['player.1 vs player.5'] },
      { round: 3, lines: ['Withdrawn vs player.5'] },
    ])
    // …and they are not a member of the group, because they are not an entrant at all
    // (ADR-0016).
    expect(state.groups[0].entrants.map((e) => e.username)).toEqual([
      'player.1',
      'player.5',
    ])
  })

  it('does not announce a group the draw never used', () => {
    const event = buildDrawnEvent({
      // A third reservation added (position 2), keeping the first two ids the default
      // fixtures already name — a group's own fixtures are what decide whether the draw
      // "used" it, not whether the event carries a reservation for it.
      reservations: [
        buildReservation({ id: 'res-a', name: 'Reservation A' }),
        buildReservation({
          id: 'res-b',
          name: 'Reservation B',
          slot: { date: '2026-06-13', start: '13:30', end: '17:00' },
          position: 1,
        }),
        buildReservation({
          id: 'res-c',
          name: 'Reservation C',
          slot: { date: '2026-06-13', start: '17:30', end: '19:00' },
          position: 2,
        }),
      ],
    })

    const state = drawn(drawState(event))

    expect(state.groups.map((g) => g.label)).toEqual(['Group A', 'Group B'])
  })

  // A fixture with no group — an ungrouped (knockout) draw. Nothing can cut one today, but
  // dropping it silently is the one thing this must not do.
  it('keeps a fixture that belongs to no group, outside the groups', () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-a-1',
          groupId: groupIdFor('res-a'),
          round: 1,
          position: 1,
          entryAId: 'entry-1',
          entryBId: 'entry-2',
        }),
        buildFixture({
          id: 'fx-ko-1',
          groupId: null,
          round: 1,
          position: 1,
          entryAId: 'entry-3',
          entryBId: null,
        }),
      ],
    })

    const state = drawn(drawState(event))

    expect(state.groups.map((g) => g.label)).toEqual(['Group A'])
    expect(vsLines(state.ungrouped)).toEqual([
      { round: 1, lines: ['player.3 vs TBD'] },
    ])
  })

  it('keeps a fixture naming a group the event does not have, rather than dropping it', () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-ghost',
          groupId: 'grp-gone',
          round: 1,
          position: 1,
          entryAId: 'entry-1',
          entryBId: 'entry-2',
        }),
      ],
    })

    const state = drawn(drawState(event))

    expect(state.groups).toEqual([])
    expect(vsLines(state.ungrouped)).toEqual([
      { round: 1, lines: ['player.1 vs player.2'] },
    ])
  })
})

describe('drawRefusalScope', () => {
  // #1123 exactly: the refusal says "change the event's draw type to one that can", so
  // changing it is what must retire the sentence.
  it('moves when the draw type changes', () => {
    expect(drawRefusalScope(buildEvent({ drawType: 'single-elim' }))).not.toBe(
      drawRefusalScope(buildEvent({ drawType: 'round-robin' })),
    )
  })

  it('moves when a reservation is added — the fix for "needs at least one group"', () => {
    expect(drawRefusalScope(buildEvent({ reservations: [] }))).not.toBe(
      drawRefusalScope(buildEvent({ reservations: [buildReservation({ id: 'res-a' })] })),
    )
  })

  it('moves when somebody enters — the fix for "N entrants across M groups"', () => {
    // The scope reads entrant *ids*, not the count — so a test moves the list.
    expect(drawRefusalScope(buildEvent({ entrants: [] }))).not.toBe(
      drawRefusalScope(buildEvent({ entrants: buildEntrants(1) })),
    )
  })

  /**
   * The three settings a 422 names but a counts-and-groups scope never read. Each of these
   * is #1123 wearing a different sentence: the server tells the director to change a
   * value, they change it, and a scope blind to that value leaves the refusal on screen
   * as though the fix had not worked.
   *
   * The sentences, from `api/app/draws.py` and `api/app/tournament_draws.py`:
   * - "take fewer qualifiers from each group, or add entrants" (`rr-then-ko`)
   * - "play fewer rounds, or add entrants" (`swiss`)
   * - "a doubles event cannot be given a draw — draws are singles-only"
   */
  it('moves when the qualifier count changes — "take fewer qualifiers from each group"', () => {
    const before = buildEvent({ drawType: 'rr-then-ko', qualifiersPerGroup: 4 })

    expect(drawRefusalScope(before)).not.toBe(
      drawRefusalScope({ ...before, qualifiersPerGroup: 2 }),
    )
  })

  it('moves when the swiss round count changes — "play fewer rounds"', () => {
    const before = buildEvent({ drawType: 'swiss', rounds: 7 })

    expect(drawRefusalScope(before)).not.toBe(
      drawRefusalScope({ ...before, rounds: 4 }),
    )
  })

  it('moves when the format changes — "draws are singles-only"', () => {
    const before = buildEvent({ format: 'doubles' })

    expect(drawRefusalScope(before)).not.toBe(
      drawRefusalScope({ ...before, format: 'singles' }),
    )
  })

  /** The settings belong to the draw type that has them. A round-robin event carries a
   * `null` qualifier count and a `null` round count, and neither is a fact about it — so
   * neither can move its scope. (`drawConfig` is the switch that enforces this.) */
  it('ignores settings that belong to a different draw type', () => {
    const rr = buildEvent({ drawType: 'round-robin' })

    expect(drawRefusalScope({ ...rr, qualifiersPerGroup: 2 })).toBe(
      drawRefusalScope({ ...rr, qualifiersPerGroup: 8 }),
    )
    expect(drawRefusalScope({ ...rr, rounds: 3 })).toBe(
      drawRefusalScope({ ...rr, rounds: 9 }),
    )
  })

  it('moves when a draw is cut, which is what the 409 arm is about', () => {
    expect(drawRefusalScope(buildEvent({ id: 'ev-1' }))).not.toBe(
      drawRefusalScope(buildDrawnEvent({ id: 'ev-1' })),
    )
  })

  /** The discriminating half — see `lifecycleRefusalScope`'s twin. A refusal names
   * numbers a director has to go and change; it must not vanish because the page polled
   * or because somebody renamed a reservation. */
  it('does NOT move for state no draw refusal is about', () => {
    const base = buildEvent({
      reservations: [buildReservation({ id: 'res-a', name: 'Reservation A' })],
    })
    const scope = drawRefusalScope(base)

    expect(drawRefusalScope({ ...base, name: 'Renamed Singles' })).toBe(scope)
    expect(drawRefusalScope({ ...base, entryFee: 45 })).toBe(scope)
    expect(
      drawRefusalScope({
        ...base,
        reservations: [buildReservation({ id: 'res-a', name: 'Reservation One' })],
      }),
    ).toBe(scope)
  })

  it('is stable across a refetch that changed nothing', () => {
    expect(drawRefusalScope(buildEvent())).toBe(drawRefusalScope(buildEvent()))
  })
})

describe('undrawnLead', () => {
  // #1220: the sentence was round-robin's, hard-coded, and rendered on every event —
  // so a bracket was told to deal its entrants into groups it cannot have.
  it('does not promise groups to a draw type that has none', () => {
    expect(undrawnLead('single-elim')).not.toContain('group')
    expect(undrawnLead('swiss')).not.toContain('group')
  })

  it('names a bracket for single-elim and rounds for swiss', () => {
    expect(undrawnLead('single-elim')).toContain('bracket')
    expect(undrawnLead('swiss')).toContain('rounds')
    // Swiss eliminates nobody — the bracket's vocabulary would be a lie here.
    expect(undrawnLead('swiss')).not.toContain('bracket')
  })

  it('names groups for the two draw types that deal into them', () => {
    expect(undrawnLead('round-robin')).toContain('groups')
    expect(undrawnLead('rr-then-ko')).toContain('groups')
  })

  // `rr-then-ko` is the one with two stages, and describing only the first would
  // undersell the draw the director is about to cut.
  it('names both stages of an rr-then-ko draw', () => {
    expect(undrawnLead('rr-then-ko')).toContain('groups')
    expect(undrawnLead('rr-then-ko')).toContain('bracket')
  })

  it('gives every draw type a sentence, and a distinct one', () => {
    const leads = DRAW_TYPES.map(undrawnLead)

    expect(leads.every((lead) => lead.length > 0)).toBe(true)
    expect(new Set(leads).size).toBe(DRAW_TYPES.length)
  })
})

describe('drawRefusalNotice', () => {
  // The 409 and the 422 keep the SERVER's sentence, because it is the half that says
  // what the director must change. A generic string of ours would throw it away.
  it('shows the server’s sentence under a 409 (the draw is under way)', () => {
    const detail =
      "This event's draw is already under way — at least one fixture has a match " +
      'or a recorded winner — so it can no longer be cut or removed.'

    const notice = drawRefusalNotice(
      new ApiError(409, detail, 'cut the draw'),
      'cut the draw',
    )

    expect(notice.title).toBe('This draw is already under way')
    expect(notice.description).toBe(detail)
  })

  it('shows the server’s sentence under a 422 — the numbers it names are the point', () => {
    const detail =
      '5 entrants across 3 groups would leave a group with fewer than 2 entrants, ' +
      'who would have nobody to play.'

    const notice = drawRefusalNotice(
      new ApiError(422, detail, 'cut the draw'),
      'cut the draw',
    )

    expect(notice.title).toBe("This event can't be drawn yet")
    expect(notice.description).toBe(detail)
  })

  /** The sample was "A single-elim draw cannot be cut yet." until the enum shrank to
   * the types that run (ADR 20260726). **The CUT route can no longer say it** —
   * `strategy_for` is total, so no draw type a director can pick lacks a generator.
   * (The sentence itself is not dead: `schedule_preview` still raises
   * `UnsupportedDrawType` for single-elim, because the CP-SAT scheduler is
   * round-robin-only. Grep it and you will find it alive, on that path.) The claim
   * under test never depended on the sample: the panel prints whatever refusal came
   * back. So the sample is now one the CUT route really emits (`draws.py`,
   * `SingleElimStrategy.plan_initial`). */
  it('shows the server’s sentence for a bracket with nobody to play', () => {
    const detail =
      'A single-elimination draw needs at least 2 entrants — a bracket of ' +
      'one has nobody to play.'

    const notice = drawRefusalNotice(
      new ApiError(422, detail, 'cut the draw'),
      'cut the draw',
    )

    expect(notice.description).toBe(detail)
  })

  it('has words for a 403, though the panel never offers a non-owner the verb', () => {
    const notice = drawRefusalNotice(
      new ApiError(403, 'Only the creator can cut this draw.', 'cut the draw'),
      'cut the draw',
    )

    expect(notice.title).toBe("You can't change this draw")
    expect(notice.description).toContain('Nothing was changed.')
  })

  it('has words for an expired session', () => {
    const notice = drawRefusalNotice(
      new ApiError(401, null, 'cut the draw'),
      'cut the draw',
    )

    expect(notice.title).toBe('You are signed out')
  })

  // No silent failures: the panel surfaces its errors inline and carries no toast, so
  // every failure — a 5xx, a dead network — must still say something.
  //
  // But a 5xx says it in OUR words. Its detail is machinery, not copy, and it must never
  // reach the UI (`DEFINITION_OF_COMPLETE`) — the guarantee lives in `fallbackNotice`'s
  // floor, so this asserts the leak is closed rather than that this function has an arm.
  it('names the verb on a 5xx, and never echoes the server’s detail', () => {
    const notice = drawRefusalNotice(
      new ApiError(500, "psycopg.errors.NotNullViolation: null value in column 'group_id'", 'remove the draw'),
      'remove the draw',
    )

    expect(notice.title).toBe("Couldn't remove the draw")
    expect(notice.description).not.toContain('psycopg')
    expect(notice.description).toBe('Something went wrong on our end. Try again in a moment.')
  })

  it('says the request never landed when the network is down', () => {
    const notice = drawRefusalNotice(new TypeError('Failed to fetch'), 'cut the draw')

    expect(notice.title).toBe("Couldn't cut the draw")
    expect(notice.description).toContain('Check your connection')
  })
})

// ADR-0786's two freezes, as the editor asks about them. Pure derivations off the
// event's `fixtures`, so they are unit-tested here rather than through eight DOM
// assertions in three sections.
describe('groupSetFreeze', () => {
  it('is open while no draw is cut', () => {
    expect(groupSetFreeze(buildEvent()).kind).toBe('open')
  })

  it('freezes the moment ONE fixture exists', () => {
    // The freeze turns on the draw EXISTING, not on it being big, complete, or played:
    // a single fixture is already a fixture that names its group.
    const freeze = groupSetFreeze(
      buildEvent({
        reservations: [buildReservation({ id: 'res-1' })],
        fixtures: [buildFixture({ groupId: groupIdFor('res-1') })],
      }),
    )

    expect(freeze.kind).toBe('frozen')
  })

  it('names the way out, and says what is still allowed', () => {
    const freeze = groupSetFreeze(buildDrawnEvent())
    if (freeze.kind !== 'frozen') throw new Error('expected a frozen group set')

    // A refusal that only says "no" leaves a director with a broken table nowhere to go.
    expect(freeze.reason).toContain('Delete the draw')
    expect(freeze.reason).toContain('cut it again')
    // …and the half that matters most: the reservation's own attributes were never frozen.
    expect(freeze.reason).toMatch(/name.*tables.*time window|tables/i)
  })
})

describe('drawTypeFreeze', () => {
  it('is open while no draw is cut', () => {
    expect(drawTypeFreeze(buildEvent(), buildDrawTypes()).kind).toBe('open')
  })

  it('freezes once the draw is cut, naming the type its fixtures were dealt as', () => {
    const freeze = drawTypeFreeze(buildDrawnEvent(), buildDrawTypes())
    if (freeze.kind !== 'frozen') throw new Error('expected a frozen draw type')

    // In the select's own words — never the wire's enum key.
    expect(freeze.reason).toContain('“Round robin”')
    expect(freeze.reason).not.toContain('round-robin')
    expect(freeze.reason).toContain('Delete the draw')
  })

  // The label is the SERVER's (ADR 20260726), so the sentence follows the catalogue —
  // it is not a second copy of the copy. Rename the row and the freeze renames with it.
  it('quotes the served catalogue’s words, not a list of its own', () => {
    const freeze = drawTypeFreeze(buildDrawnEvent(), [
      { value: 'round-robin', label: 'Groups of everyone' },
    ])
    if (freeze.kind !== 'frozen') throw new Error('expected a frozen draw type')

    expect(freeze.reason).toContain('“Groups of everyone”')
    expect(freeze.reason).not.toContain('Round robin')
  })

  /** The catalogue has no row for the event's type — a build that does not know the
   * slug, or a surface that was handed none. The clause naming the type is dropped;
   * the raw key is NEVER printed at a director (that is the leak `labelFor` exists to
   * prevent), and the half that gets them unstuck is still there. */
  it('drops the “dealt as” clause rather than leaking the slug', () => {
    const freeze = drawTypeFreeze(buildDrawnEvent(), [])
    if (freeze.kind !== 'frozen') throw new Error('expected a frozen draw type')

    expect(freeze.reason).not.toContain('round-robin')
    expect(freeze.reason).not.toContain('dealt as')
    expect(freeze.reason).toContain('its draw type is frozen')
    expect(freeze.reason).toContain('Delete the draw to change the type')
  })
})

/**
 * The third freeze — the one on the draw **verbs** themselves (#1060). It restates the
 * server's `draw_has_play` and nothing else, so the cases below are that guard's own two
 * halves, apart, plus the negative.
 */
describe('drawVerbFreeze', () => {
  /** The frozen reason, or a failed assertion — so a test that is about the *words* reads
   * them without a narrowing dance, and an accidentally open freeze fails loudly. */
  const frozenReason = (event: TournamentEvent) => {
    const freeze = drawVerbFreeze(event)
    if (freeze.kind !== 'frozen') throw new Error('expected a frozen draw verb')
    return freeze.reason
  }

  it('is open on a draw that has been cut but not played', () => {
    // The day-of re-cut ADR-0786 preserves: a full draw, no result and no match, and both
    // verbs live. Freezing on the *draw* rather than on the *evidence* would break this.
    expect(drawVerbFreeze(buildDrawnEvent()).kind).toBe('open')
  })

  it('is open on an event with no draw at all', () => {
    // Not a special case in the predicate — no fixtures, nothing to find evidence on —
    // and stated anyway, because it is what keeps Generate (the undrawn verb) unfrozen.
    expect(drawVerbFreeze(buildEvent()).kind).toBe('open')
  })

  // Half one, alone: a decided fixture. A result exists, and a re-cut would discard it.
  it('freezes on a fixture with a recorded WINNER, match or no match', () => {
    const freeze = drawVerbFreeze(
      buildDrawnEvent({
        fixtures: [
          buildFixture({ id: 'fx-a-1', winnerEntryId: 'entry-1', matchId: null }),
          buildFixture({ id: 'fx-a-2', round: 2 }),
        ],
      }),
    )

    expect(freeze.kind).toBe('frozen')
  })

  /**
   * Half two, alone, and the half a laxer client would get wrong: a fixture that has
   * become a real match with **no winner and no status**.
   *
   * The `matchStatus: null` is the load-bearing part. `matchOf` (the renderer's helper in
   * the same module) requires an id *and* a status before it will call a fixture
   * materialized, so a freeze derived from `FixtureLine.match` — or from `drawState` —
   * would read this fixture as un-played and offer a verb the server answers 409 to. The
   * guard is `match_id IS NOT NULL`, and so is this.
   */
  it('freezes on a merely LINKED match, even with no winner and no status', () => {
    const freeze = drawVerbFreeze(
      buildDrawnEvent({
        fixtures: [
          buildFixture({
            id: 'fx-a-1',
            winnerEntryId: null,
            matchId: 'm-1',
            matchStatus: null,
          }),
        ],
      }),
    )

    expect(freeze.kind).toBe('frozen')
  })

  // ANY fixture, not every one: the seeded event materializes one of its four.
  it('freezes on one played fixture among four unplayed ones', () => {
    expect(drawVerbFreeze(buildPlayedDrawnEvent()).kind).toBe('frozen')
  })

  it('says both verbs are gone, and why — and names no way out, because there is none', () => {
    const reason = frozenReason(buildPlayedDrawnEvent())

    // What is true, in the director's terms…
    expect(reason).toContain('under way')
    // …and what it would cost to ignore: the two verbs, named as the acts they are.
    expect(reason).toMatch(/re-cutting or removing the draw/i)
    // The half the sibling freezes' copy register would drag in and that would be a LIE
    // here: deleting the draw is the act being refused, so there is no exit to offer.
    expect(reason).not.toContain('Delete the draw')
    expect(reason).not.toContain('cut it again')
  })

  /**
   * ⚠️ **The reason must be true of a draw nobody has played** — the commonest frozen draw
   * there is, and the one the copy used to contradict.
   *
   * `materialize_live_draw` stamps a `match_id` on every ready fixture inside the go-live
   * transaction, so the ordinary way a draw freezes is: the tournament goes live, every
   * fixture becomes a real match, **zero results**. The sentence said a re-deal "would
   * throw away a result somebody has already played for" — false here, and flatly against
   * its own first clause, which offered the match as an *alternative* to a winner.
   *
   * The assertion is therefore on the **hedge**, not on a replacement fragment: a result
   * may be named only as one of two alternatives, the way the server's own guard hedges it
   * ("a linked match, which **may** already carry games"). Pinning another literal string
   * is what let the false claim through the first time.
   */
  it('claims no result on a draw that has merely materialized', () => {
    const reason = frozenReason(buildMaterializedDrawnEvent())

    // Nothing has been played on this event, so nothing can be thrown away.
    expect(reason).not.toMatch(/throw away/i)
    expect(reason).not.toMatch(/has already been played/i)
    // The match is the fact; the result is the alternative ("… or …").
    expect(reason).toMatch(/real match now, or/i)
    // One sentence covers both halves of the guard — a director cannot be shown a reason
    // that names the half their own draw does not have.
    expect(reason).toBe(frozenReason(buildPlayedDrawnEvent()))
  })
})

describe('fixtureReservation', () => {
  /**
   * A group that plays in no reservation (ticket #1387): its `reservationId` is `null`,
   * and a fixture in it resolves to the group and to NO reservation — the callers
   * (`./schedule`, `./timeline`) then fall back to the event's own window and the whole
   * catalogue, exactly as they do for an ungrouped fixture. Neither dropped nor thrown.
   */
  it('resolves the group and no reservation when the group has none', () => {
    const index = buildDrawIndex({
      groups: [{ id: 'grp-a', position: 0, reservationId: null, stageId: 's-1' }],
      reservations: [],
      stages: [],
    })
    expect(fixtureReservation(index, { groupId: 'grp-a' })).toEqual({
      group: { id: 'grp-a', position: 0, reservationId: null, stageId: 's-1' },
      reservation: null,
    })
  })

  it('resolves both hops when the group has a reservation', () => {
    const reservation = buildReservation({ id: 'res-a' })
    const index = buildDrawIndex({
      groups: [{ id: 'grp-a', position: 0, reservationId: 'res-a', stageId: 's-1' }],
      reservations: [reservation],
      stages: [],
    })
    expect(fixtureReservation(index, { groupId: 'grp-a' })).toEqual({
      group: { id: 'grp-a', position: 0, reservationId: 'res-a', stageId: 's-1' },
      reservation,
    })
  })
})
