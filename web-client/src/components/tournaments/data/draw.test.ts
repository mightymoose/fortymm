import { ApiError } from '@/api/client'

import {
  drawRefusalNotice,
  drawState,
  drawTypeFreeze,
  poolSetFreeze,
  unpooledShape,
  type DrawState,
  type FixtureSide,
} from './draw'
import { DRAW_TYPES } from './draw-types'
import {
  buildBracketDrawnEvent,
  buildDrawnEvent,
  buildDrawTypes,
  buildEntrant,
  buildEntrants,
  buildEvent,
  buildFixture,
  buildPool,
  buildSwissDrawnEvent,
  buildTwoStageDrawnEvent,
} from './seed.factory'

/** The drawn arm, or a failed assertion — so the tests below can read `.pools`
 * without a cast, and an accidental `undrawn` fails loudly instead of quietly
 * skipping every assertion after it. */
function drawn(state: DrawState) {
  if (state.kind !== 'drawn') {
    throw new Error(`expected a drawn state, got "${state.kind}"`)
  }
  return state
}

/** A pool's fixtures as the panel reads them: "player.1 vs player.4", round by round. */
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
 * **Which view an event's un-pooled fixtures get** — a fact about the DRAW TYPE, and the
 * one this module exists to keep away from `poolId === null`.
 *
 * Three draw types put fixtures in `unpooled`, and nothing about the fixtures themselves
 * tells them apart: single-elim's whole bracket, `rr-then-ko`'s knockout stage, and every
 * fixture of a swiss draw all carry a null pool id. Routing on that null rendered a swiss
 * draw as a knockout bracket, through the successor arithmetic the ADR says swiss does not
 * have — silently, because a value check is not something a type checker can read.
 */
describe('unpooledShape', () => {
  it('sends swiss to the ROUNDS view — never the bracket', () => {
    expect(unpooledShape('swiss')).toBe('swiss-rounds')
  })

  // The regression pin, at the decision rather than at the DOM. `pool_id IS NULL` keeps
  // meaning "the knockout stage" for `rr-then-ko`, and a single-elim draw is a bracket
  // whole — neither may move because swiss now shares the null.
  it.each(['single-elim', 'rr-then-ko'] as const)(
    'keeps %s on the bracket',
    (drawType) => {
      expect(unpooledShape(drawType)).toBe('bracket')
    },
  )

  /** A round-robin fixture with no pool is a payload the server cannot send — it names a
   * pool the event does not list. `drawState` deliberately does not DROP it, and the
   * bracket is the existing "show it anyway" fallback. Pinned so the arm is a decision
   * somebody made rather than a default nobody noticed. */
  it('keeps a round-robin’s orphaned fixtures on the same fallback they had', () => {
    expect(unpooledShape('round-robin')).toBe('bracket')
  })

  /** Every draw type this client knows has an answer, and the `switch` has no catch-all —
   * so a fifth member of the vocabulary is a compile error in `./draw` until somebody says
   * how its draw reads. This asserts the runtime half: nothing falls through to
   * `undefined`. Driven off `DRAW_TYPES` rather than a re-typed list, so adding a slug
   * reaches this test without anybody remembering to. */
  it('answers for every draw type in the vocabulary', () => {
    for (const drawType of DRAW_TYPES) {
      expect(['bracket', 'swiss-rounds']).toContain(unpooledShape(drawType))
    }
  })
})

describe('drawState', () => {
  it('reads an event with no fixtures as the designed UNDRAWN state', () => {
    expect(drawState(buildEvent({ fixtures: [] }))).toEqual({ kind: 'undrawn' })
  })

  it('groups a cut draw into its pools, in the event’s pool order', () => {
    const state = drawn(drawState(buildDrawnEvent()))

    expect(state.pools.map((p) => p.name)).toEqual(['Pool A', 'Pool B'])
    expect(state.unpooled).toEqual([])
  })

  /** The shape rides the read model, so the panel reads a tag rather than inferring a
   * format from a null pool id. Asserted on all three un-pooled draw types, because the
   * payloads they produce are indistinguishable at the fixture level. */
  it('carries the un-pooled SHAPE, read off the event’s draw type', () => {
    expect(drawn(drawState(buildSwissDrawnEvent())).unpooledShape).toBe(
      'swiss-rounds',
    )
    expect(drawn(drawState(buildBracketDrawnEvent())).unpooledShape).toBe('bracket')
    expect(drawn(drawState(buildTwoStageDrawnEvent())).unpooledShape).toBe('bracket')
  })

  /** A swiss draw's rounds all arrive un-pooled — every one of them, from the cut — so the
   * pool list is empty and nothing is dropped. */
  it('reads a swiss draw as un-pooled rounds, with every cut round present', () => {
    const state = drawn(drawState(buildSwissDrawnEvent()))

    expect(state.pools).toEqual([])
    expect(state.unpooled.map((r) => r.round)).toEqual([1, 2, 3])
    expect(state.unpooled.map((r) => r.fixtures.length)).toEqual([3, 3, 3])
  })

  it('lists each pool’s entrants — the members its own fixtures name, by NAME', () => {
    const state = drawn(drawState(buildDrawnEvent()))

    // The snake dealt 1/4/5 into Pool A and 2/3 into Pool B; nothing stores that, so
    // this is derived from the fixtures (ADR-0786).
    expect(state.pools[0].entrants.map((e) => e.username)).toEqual([
      'player.1',
      'player.4',
      'player.5',
    ])
    expect(state.pools[1].entrants.map((e) => e.username)).toEqual([
      'player.2',
      'player.3',
    ])
  })

  it('orders a pool’s entrants by SEED first, then registration order', () => {
    // player.5 is seeded 1, so they lead a pool they entered last. The unseeded rest
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

    expect(state.pools[0].entrants.map((e) => e.username)).toEqual([
      'player.5',
      'player.1',
      'player.4',
    ])
  })

  it('groups each pool’s fixtures by round, in round then position order — with names on them', () => {
    const state = drawn(drawState(buildDrawnEvent()))

    expect(vsLines(state.pools[0].rounds)).toEqual([
      { round: 1, lines: ['player.1 vs player.4'] },
      { round: 2, lines: ['player.1 vs player.5'] },
      { round: 3, lines: ['player.4 vs player.5'] },
    ])
    expect(vsLines(state.pools[1].rounds)).toEqual([
      { round: 1, lines: ['player.2 vs player.3'] },
    ])
  })

  // The ODD pool: three players, three rounds, ONE fixture each — the third player sits
  // out. A bye is the ABSENCE of a fixture (ADR-0786), so nothing here emits a row for
  // it, and no round is short of the fixtures it really has.
  it('leaves an odd pool’s rounds short a fixture rather than inventing a bye row', () => {
    const state = drawn(drawState(buildDrawnEvent()))

    expect(state.pools[0].rounds.map((r) => r.fixtures.length)).toEqual([1, 1, 1])
    expect(state.pools[0].rounds).toHaveLength(3)
    // Three entrants, three rounds, three fixtures — never four, and never a null side
    // standing in for the player sitting out.
    const sides = state.pools[0].rounds.flatMap((r) =>
      r.fixtures.flatMap((f) => [f.a.kind, f.b.kind]),
    )
    expect(sides).toEqual(Array(6).fill('entrant'))
  })

  it('sorts rounds and positions rather than trusting the payload’s order', () => {
    const shuffled = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-a-r2',
          poolId: 'p-a',
          round: 2,
          position: 2,
          entryAId: 'entry-4',
          entryBId: 'entry-5',
        }),
        buildFixture({
          id: 'fx-a-r1',
          poolId: 'p-a',
          round: 1,
          position: 1,
          entryAId: 'entry-1',
          entryBId: 'entry-2',
        }),
        buildFixture({
          id: 'fx-a-r2-p1',
          poolId: 'p-a',
          round: 2,
          position: 1,
          entryAId: 'entry-1',
          entryBId: 'entry-3',
        }),
      ],
    })

    const state = drawn(drawState(shuffled))

    expect(vsLines(state.pools[0].rounds)).toEqual([
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
          poolId: 'p-a',
          round: 1,
          position: 1,
          entryAId: 'entry-1',
          entryBId: null,
        }),
      ],
    })

    const state = drawn(drawState(event))

    expect(state.pools[0].rounds[0].fixtures[0].a).toEqual({
      kind: 'entrant',
      name: 'player.1',
    })
    expect(state.pools[0].rounds[0].fixtures[0].b).toEqual({ kind: 'tbd' })
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

    expect(vsLines(state.pools[0].rounds)).toEqual([
      { round: 1, lines: ['player.1 vs Withdrawn'] },
      { round: 2, lines: ['player.1 vs player.5'] },
      { round: 3, lines: ['Withdrawn vs player.5'] },
    ])
    // …and they are not a member of the pool, because they are not an entrant at all
    // (ADR-0016).
    expect(state.pools[0].entrants.map((e) => e.username)).toEqual([
      'player.1',
      'player.5',
    ])
  })

  it('does not announce a pool the draw never used', () => {
    const event = buildDrawnEvent({
      pools: [
        buildPool({ id: 'p-a', name: 'Pool A' }),
        buildPool({ id: 'p-b', name: 'Pool B' }),
        buildPool({ id: 'p-c', name: 'Pool C' }),
      ],
    })

    const state = drawn(drawState(event))

    expect(state.pools.map((p) => p.name)).toEqual(['Pool A', 'Pool B'])
  })

  // A fixture with no pool — an un-pooled (knockout) draw. Nothing can cut one today, but
  // dropping it silently is the one thing this must not do.
  it('keeps a fixture that belongs to no pool, outside the pools', () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-a-1',
          poolId: 'p-a',
          round: 1,
          position: 1,
          entryAId: 'entry-1',
          entryBId: 'entry-2',
        }),
        buildFixture({
          id: 'fx-ko-1',
          poolId: null,
          round: 1,
          position: 1,
          entryAId: 'entry-3',
          entryBId: null,
        }),
      ],
    })

    const state = drawn(drawState(event))

    expect(state.pools.map((p) => p.name)).toEqual(['Pool A'])
    expect(vsLines(state.unpooled)).toEqual([
      { round: 1, lines: ['player.3 vs TBD'] },
    ])
  })

  it('keeps a fixture naming a pool the event does not have, rather than dropping it', () => {
    const event = buildDrawnEvent({
      fixtures: [
        buildFixture({
          id: 'fx-ghost',
          poolId: 'p-gone',
          round: 1,
          position: 1,
          entryAId: 'entry-1',
          entryBId: 'entry-2',
        }),
      ],
    })

    const state = drawn(drawState(event))

    expect(state.pools).toEqual([])
    expect(vsLines(state.unpooled)).toEqual([
      { round: 1, lines: ['player.1 vs player.2'] },
    ])
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
      '5 entrants across 3 pool(s) would leave a pool with fewer than 2 entrants, ' +
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
      new ApiError(500, "psycopg.errors.NotNullViolation: null value in column 'pool_id'", 'remove the draw'),
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
describe('poolSetFreeze', () => {
  it('is open while no draw is cut', () => {
    expect(poolSetFreeze(buildEvent()).kind).toBe('open')
  })

  it('freezes the moment ONE fixture exists', () => {
    // The freeze turns on the draw EXISTING, not on it being big, complete, or played:
    // a single fixture is already a fixture that names its pool.
    const freeze = poolSetFreeze(
      buildEvent({ pools: [buildPool()], fixtures: [buildFixture({ poolId: 'p-1' })] }),
    )

    expect(freeze.kind).toBe('frozen')
  })

  it('names the way out, and says what is still allowed', () => {
    const freeze = poolSetFreeze(buildDrawnEvent())
    if (freeze.kind !== 'frozen') throw new Error('expected a frozen pool set')

    // A refusal that only says "no" leaves a director with a broken table nowhere to go.
    expect(freeze.reason).toContain('Delete the draw')
    expect(freeze.reason).toContain('cut it again')
    // …and the half that matters most: the venue attributes were never frozen.
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
