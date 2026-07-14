import { describe, expect, it } from 'vitest'

import type { components } from '@/api/schema'
import {
  buildTournamentDetailRead,
  buildTournamentEntrantRead,
  buildTournamentEntrantReads,
  buildTournamentEventRead,
  buildTournamentFixtureRead,
} from '@/mocks/factories/tournaments/tournament.factory'
import {
  apiToEntrant,
  apiToEntryState,
  apiToEvent,
  apiToTournament,
  draftToCreateBody,
  eventToCreateBody,
  eventToUpdateBody,
  tournamentToUpdateBody,
} from './api'
import type { Tournament, TournamentEvent } from './types'

type TournamentFixtureRead = components['schemas']['TournamentFixtureRead']

/** A payload the generated types say cannot exist — which is exactly what the runtime
 * parse is for. The cast is the *point* of these cases, not a shortcut around them:
 * `schema.d.ts` is a compile-time claim about a server we do not control, and a test
 * that could only feed `apiToEvent` well-typed fixtures could never prove the boundary
 * rejects a bad one. */
function malformedFixture(broken: Record<string, unknown>): TournamentFixtureRead {
  return broken as unknown as TournamentFixtureRead
}

describe('apiToEntryState', () => {
  // The tags cross the boundary UNCHANGED, and that is the contract: they are the
  // entry refusal codes (ADR-0968), so the reason the page load gives and the
  // reason a 409 gives read out of one copy table. Renaming them here would fork it.
  it.each(['open', 'event_full'] as const)('carries %s across unchanged', (state) => {
    expect(apiToEntryState({ state })).toEqual({ state })
  })

  it('camelCases the refusing rule and keeps the rating it judged you on', () => {
    expect(
      apiToEntryState({
        state: 'rating_ineligible',
        predicate_id: 'pr-2',
        rating: 1650,
      }),
    ).toEqual({ state: 'rating_ineligible', predicateId: 'pr-2', rating: 1650 })
  })

  // The wire is untrusted: a `state` from a schema that is not ours must not reach
  // a component whose `switch` would fall through it and render an unnameable card.
  // It degrades to `open` — the server refuses the click with a coded 409 anyway,
  // and that path already has words.
  it('degrades a state it does not know to open, rather than passing it inward', () => {
    const alien = { state: 'invitation_only' } as unknown as Parameters<
      typeof apiToEntryState
    >[0]

    expect(apiToEntryState(alien)).toEqual({ state: 'open' })
  })
})

describe('apiToEvent', () => {
  it('maps snake_case event fields to the prototype camelCase shape', () => {
    const event = apiToEvent(
      buildTournamentEventRead({
        draw_type: 'single-elim',
        max_players: 32,
        entry_fee: 35,
        entrants: buildTournamentEntrantReads(22),
        match_settings: { rated: false, length_games: 3 },
      }),
    )

    expect(event.drawType).toBe('single-elim')
    expect(event.maxPlayers).toBe(32)
    expect(event.entryFee).toBe(35)
    // The count is the server's derived `entered` — and it agrees with the list
    // it counts, because they are the same fact (ADR-0016).
    expect(event.entered).toBe(22)
    expect(event.entrants).toHaveLength(22)
    expect(event.match).toEqual({ rated: false, lengthGames: 3 })
  })

  it('maps each entrant, keeping the ENTRY id a withdrawal is addressed to', () => {
    const event = apiToEvent(
      buildTournamentEventRead({
        entrants: [
          buildTournamentEntrantRead({
            id: 'entry-9',
            user_id: 'u-7',
            username: 'rita.kovac',
            seed: 3,
            rating: 1450,
          }),
        ],
      }),
    )

    expect(event.entrants).toEqual([
      { id: 'entry-9', userId: 'u-7', username: 'rita.kovac', seed: 3, rating: 1450 },
    ])
  })

  it('maps an event nobody has entered to an empty list and a zero count', () => {
    const event = apiToEvent(buildTournamentEventRead({ entrants: [] }))

    expect(event.entrants).toEqual([])
    expect(event.entered).toBe(0)
  })

  it('maps a pool, renaming table_ids to tableIds', () => {
    const event = apiToEvent(
      buildTournamentEventRead({
        pools: [
          {
            id: 'p-1',
            name: 'Pool A',
            slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
            table_ids: ['t1', 't2'],
          },
        ],
      }),
    )

    expect(event.pools).toEqual([
      {
        id: 'p-1',
        name: 'Pool A',
        slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
        tableIds: ['t1', 't2'],
      },
    ])
  })

  it('passes a scalar predicate value through unchanged', () => {
    const event = apiToEvent(
      buildTournamentEventRead({
        predicates: [{ id: 'pr-1', field: 'rating', op: '<', value: 1500 }],
      }),
    )

    expect(event.predicates).toEqual([
      { id: 'pr-1', field: 'rating', op: '<', value: 1500 },
    ])
  })

  it('narrows a between-predicate array value to a [min, max] tuple', () => {
    const event = apiToEvent(
      buildTournamentEventRead({
        predicates: [
          { id: 'pr-2', field: 'rating', op: 'between', value: [1200, 1600] },
        ],
      }),
    )

    expect(event.predicates[0].value).toEqual([1200, 1600])
  })
})

// The DRAW (ADR-0786), where it crosses into the app. Every fixture is PARSED here
// (`./fixtures`), not cast — `apiToEvent` is called from the queries' `queryFn`, so a
// draw that is not a draw fails the fetch instead of reaching a renderer.
describe('apiToEvent — the draw', () => {
  it('maps a cut draw to camelCase fixtures, in the order the wire sent them', () => {
    const event = apiToEvent(
      buildTournamentEventRead({
        fixtures: [
          buildTournamentFixtureRead({
            id: 'fx-1',
            pool_id: 'p-1',
            round: 1,
            position: 1,
            entry_a_id: 'entry-1',
            entry_b_id: 'entry-2',
          }),
          buildTournamentFixtureRead({
            id: 'fx-2',
            pool_id: 'p-1',
            round: 1,
            position: 2,
            entry_a_id: 'entry-3',
            entry_b_id: 'entry-4',
          }),
        ],
      }),
    )

    expect(event.fixtures).toEqual([
      {
        id: 'fx-1',
        poolId: 'p-1',
        round: 1,
        position: 1,
        entryAId: 'entry-1',
        entryBId: 'entry-2',
        winnerEntryId: null,
        matchId: null,
        matchStatus: null,
        tableId: null,
        scheduledStart: null,
      },
      {
        id: 'fx-2',
        poolId: 'p-1',
        round: 1,
        position: 2,
        entryAId: 'entry-3',
        entryBId: 'entry-4',
        winnerEntryId: null,
        matchId: null,
        matchStatus: null,
        tableId: null,
        scheduledStart: null,
      },
    ])
  })

  // Every null on a fixture is a FACT (ADR-0786), and a mapper that coalesced any of
  // them would erase the thing the draw exists to say: a null side is TBD, a null
  // winner is undecided, a null match (and null status) is un-materialized, a null pool
  // is un-pooled.
  it('carries every null through — TBD sides, undecided, un-materialized, un-pooled', () => {
    const event = apiToEvent(
      buildTournamentEventRead({
        fixtures: [
          buildTournamentFixtureRead({
            id: 'fx-final',
            pool_id: null,
            round: 3,
            position: 1,
            entry_a_id: null,
            entry_b_id: null,
          }),
        ],
      }),
    )

    expect(event.fixtures[0]).toEqual({
      id: 'fx-final',
      poolId: null,
      round: 3,
      position: 1,
      entryAId: null,
      entryBId: null,
      winnerEntryId: null,
      matchId: null,
      matchStatus: null,
      tableId: null,
      scheduledStart: null,
    })
  })

  it('maps a decided, materialized fixture — the winner and its match id survive', () => {
    const event = apiToEvent(
      buildTournamentEventRead({
        fixtures: [
          buildTournamentFixtureRead({
            winner_entry_id: 'entry-2',
            match_id: 'm-7',
          }),
        ],
      }),
    )

    expect(event.fixtures[0].winnerEntryId).toBe('entry-2')
    expect(event.fixtures[0].matchId).toBe('m-7')
  })

  // THE empty state. An event nobody has cut a draw for is not an error and not a null —
  // it has an empty draw, which is a thing a page renders ("no draw yet, cut one").
  it('maps an event with NO DRAW CUT to an empty fixture list — not null, not an error', () => {
    const event = apiToEvent(buildTournamentEventRead({ fixtures: [] }))

    expect(event.fixtures).toEqual([])
  })

  // …and the boundary. A malformed fixture must fail HERE, loudly, rather than travel
  // inward as an `undefined` that surfaces as a blank bracket cell three components away
  // (`.claude/rules/parse-at-boundaries.md`). The generated types promise these payloads
  // cannot arrive; the parse is what makes that promise enforceable at runtime.
  it.each([
    {
      what: 'a fixture missing its round',
      fixture: malformedFixture({
        id: 'fx-1',
        pool_id: 'p-1',
        position: 1,
        entry_a_id: 'entry-1',
        entry_b_id: 'entry-2',
        winner_entry_id: null,
        match_id: null,
      }),
    },
    {
      what: 'a pool_id of the wrong type',
      fixture: malformedFixture({
        ...buildTournamentFixtureRead(),
        pool_id: 7,
      }),
    },
    {
      what: 'a round that is not a number',
      fixture: malformedFixture({
        ...buildTournamentFixtureRead(),
        round: '1',
      }),
    },
    {
      // `.nullable()`, not `.optional()`: an ABSENT side is not the same as a null one.
      // Null means TBD — a fact. Absent means the server sent us something we cannot
      // read, and reading it as TBD would invent a fixture that is waiting for a player
      // who will never arrive.
      what: 'an absent side (absent is not the same as TBD)',
      fixture: malformedFixture({
        id: 'fx-1',
        pool_id: null,
        round: 1,
        position: 1,
        entry_b_id: 'entry-2',
        winner_entry_id: null,
        match_id: null,
      }),
    },
  ])('rejects $what at the boundary', ({ fixture }) => {
    expect(() =>
      apiToEvent(buildTournamentEventRead({ fixtures: [fixture] })),
    ).toThrow()
  })

  it('rejects a draw that is not a list at all — null is not an empty draw', () => {
    expect(() =>
      apiToEvent(
        buildTournamentEventRead({
          fixtures: null as unknown as TournamentFixtureRead[],
        }),
      ),
    ).toThrow()
  })
})

describe('apiToEntrant', () => {
  it('renames user_id and passes an unseeded entrant through', () => {
    expect(
      apiToEntrant({
        id: 'entry-1',
        user_id: 'u-1',
        username: 'player.1',
        seed: null,
        rating: 1450,
      }),
    ).toEqual({
      id: 'entry-1',
      userId: 'u-1',
      username: 'player.1',
      seed: null,
      rating: 1450,
    })
  })

  it("carries an UNRATED entrant's null rating through, rather than coalescing it", () => {
    // The null IS the fact (ADR-0783 §3): this player holds no rating on the
    // tournament's ladder, which is why they passed every rating rule to get in —
    // and why the roster marks them. A mapper that defaulted it to 0, or to 1500,
    // would erase the one thing the field is carried for, and the director would
    // never see the opt-out.
    const entrant = apiToEntrant(
      buildTournamentEntrantRead({ username: 'sam.oduya', rating: null }),
    )

    expect(entrant.rating).toBeNull()
  })
})

describe('apiToTournament', () => {
  it('maps top-level fields and derives tableIds from the catalogue', () => {
    const tournament = apiToTournament(
      buildTournamentDetailRead({
        start_date: '2026-06-13',
        end_date: '2026-06-14',
      }),
    )

    expect(tournament.startDate).toBe('2026-06-13')
    expect(tournament.endDate).toBe('2026-06-14')
    expect(tournament.tableIds).toEqual(['t1', 't2', 't3', 't4'])
  })

  it('coalesces a null description to an empty string', () => {
    const tournament = apiToTournament(
      buildTournamentDetailRead({ description: null }),
    )

    expect(tournament.description).toBe('')
  })

  it('maps can_edit to canEdit when the user may edit', () => {
    const tournament = apiToTournament(
      buildTournamentDetailRead({ can_edit: true }),
    )

    expect(tournament.canEdit).toBe(true)
  })

  it('maps can_edit to canEdit when the user may not edit', () => {
    const tournament = apiToTournament(
      buildTournamentDetailRead({ can_edit: false }),
    )

    expect(tournament.canEdit).toBe(false)
  })

  it('maps each embedded event through apiToEvent', () => {
    const tournament = apiToTournament(
      buildTournamentDetailRead({
        events: [
          buildTournamentEventRead({ id: 'ev-1', max_players: 16 }),
          buildTournamentEventRead({ id: 'ev-2', max_players: 48 }),
        ],
      }),
    )

    expect(tournament.events.map((e) => e.id)).toEqual(['ev-1', 'ev-2'])
    expect(tournament.events[0].maxPlayers).toBe(16)
    expect(tournament.events[1].maxPlayers).toBe(48)
  })

  // The draw arrives INSIDE the detail payload — there is no `GET …/draw` (ADR-0786) —
  // so this is the mapping every drawn page actually goes through.
  it('carries each event’s draw through, drawn and undrawn side by side', () => {
    const tournament = apiToTournament(
      buildTournamentDetailRead({
        events: [
          buildTournamentEventRead({
            id: 'ev-drawn',
            fixtures: [buildTournamentFixtureRead({ id: 'fx-1', pool_id: 'p-1' })],
          }),
          buildTournamentEventRead({ id: 'ev-undrawn', fixtures: [] }),
        ],
      }),
    )

    expect(tournament.events[0].fixtures.map((f) => f.id)).toEqual(['fx-1'])
    expect(tournament.events[0].fixtures[0].poolId).toBe('p-1')
    // The undrawn event is not a lesser drawn one: it is empty, and that is a state.
    expect(tournament.events[1].fixtures).toEqual([])
  })

  // The whole point of parsing at the boundary rather than validating in a component:
  // ONE bad fixture on ONE event fails the whole payload, at the edge, before any of it
  // is trusted. `apiToTournament` runs inside both queries' `queryFn`, so this throw is
  // a failed fetch — the cache is never primed with the bad draw.
  it('rejects the whole payload when any event carries a malformed fixture', () => {
    expect(() =>
      apiToTournament(
        buildTournamentDetailRead({
          events: [
            buildTournamentEventRead({ id: 'ev-fine' }),
            buildTournamentEventRead({
              id: 'ev-broken',
              fixtures: [
                malformedFixture({ ...buildTournamentFixtureRead(), round: null }),
              ],
            }),
          ],
        }),
      ),
    ).toThrow()
  })
})

const draft: Omit<Tournament, 'id'> = {
  name: 'Autumn Cup',
  status: 'draft',
  canEdit: true,
  startDate: '2026-09-01',
  endDate: '2026-09-02',
  description: 'A new draft.',
  address: {
    venue: 'Oakland Arena',
    street: '7000 Coliseum Way',
    city: 'Oakland',
    region: 'CA',
    postal: '94621',
    country: 'USA',
  },
  tableIds: [],
  events: [],
}

describe('draftToCreateBody', () => {
  it('maps the draft to a TournamentCreate with snake_case dates', () => {
    const body = draftToCreateBody(draft)

    expect(body).toEqual({
      name: 'Autumn Cup',
      description: 'A new draft.',
      start_date: '2026-09-01',
      end_date: '2026-09-02',
      address: draft.address,
      table_catalogue: [],
    })
  })

  // ADR-0017: a tournament is born `draft` because the SERVER says so. The
  // create body carries no status at all — not even the right one — so there is
  // no status for a client to forge (the API 422s an extra key).
  it('sends NO status — the server decides a new tournament is a draft', () => {
    const body = draftToCreateBody({ ...draft, status: 'live' })

    expect('status' in body).toBe(false)
  })
})

describe('tournamentToUpdateBody', () => {
  it('maps tournament-level fields and omits events', () => {
    const tournament: Tournament = { ...draft, id: 't-1', name: 'Renamed' }
    const body = tournamentToUpdateBody(tournament, [])

    expect(body.name).toBe('Renamed')
    expect(body.start_date).toBe('2026-09-01')
    expect(body.end_date).toBe('2026-09-02')
    expect('events' in body).toBe(false)
  })

  // ADR-0017: editing a tournament cannot move its lifecycle. The status the
  // read model carries stays on the read model — it is never echoed back into
  // the patch, so renaming a `live` tournament can't rewind it to `draft`, and
  // a patch can't sneak it forward either. Transitions are their own endpoint.
  it('sends NO status — an edit cannot move the lifecycle', () => {
    const tournament: Tournament = { ...draft, id: 't-1', status: 'live' }
    const body = tournamentToUpdateBody(tournament, [])

    expect('status' in body).toBe(false)
  })

  it('sends the catalogue verbatim (it IS the editable table set)', () => {
    const tournament: Tournament = {
      ...draft,
      id: 't-1',
      tableIds: ['t1', 't2'],
    }
    const catalogue = [
      { id: 't1', label: 'Table 1', court: 'North' },
      { id: 't2', label: 'Table 2', court: 'South' },
    ]
    const body = tournamentToUpdateBody(tournament, catalogue)

    expect(body.table_catalogue).toEqual(catalogue)
  })
})

const event: TournamentEvent = {
  id: 'ev-1',
  name: 'U1500 Singles',
  format: 'singles',
  drawType: 'rr-then-ko',
  maxPlayers: 48,
  entryFee: 30,
  // Two active entrants, so the derived count is 2 — the count and the list are
  // the same fact, and a fixture that disagreed with itself would be a lie the
  // server cannot tell.
  entered: 2,
  // One rated, one UNRATED (`rating: null` — they hold no rating on the
  // tournament's ladder, ADR-0783 §3). The round-trip below therefore proves the
  // null survives the mapping, which is the whole reason the field is on the wire.
  entrants: [
    { id: 'entry-1', userId: 'u-1', username: 'player.1', seed: 1, rating: 1720 },
    { id: 'entry-2', userId: 'u-2', username: 'player.2', seed: null, rating: null },
  ],
  // The server's judgement about the caller (ADR-0783) — 2 of 48 places taken and
  // no rule against them, so: nothing in the way.
  entryState: { state: 'open' },
  slot: { date: '2026-06-14', start: '09:00', end: '16:00' },
  predicates: [{ id: 'pr-2', field: 'rating', op: '<', value: 1500 }],
  match: { rated: true, lengthGames: 3 },
  pools: [
    {
      id: 'p-1',
      name: 'Pool A',
      slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
      tableIds: ['t1', 't2'],
    },
  ],
  // No draw cut (ADR-0786). The write bodies below must not carry one either — a draw
  // is written by the two draw verbs and by nothing else.
  fixtures: [],
  // No results (ADR-0788): no draw, nothing to stand.
  results: null,
}

describe('eventToCreateBody', () => {
  it('maps the event to a snake_case create body, excluding server-managed entered', () => {
    const body = eventToCreateBody(event)

    expect(body.draw_type).toBe('rr-then-ko')
    expect(body.max_players).toBe(48)
    expect(body.entry_fee).toBe(30)
    expect(body.match_settings).toEqual({ rated: true, length_games: 3 })
    expect(body.pools).toEqual([
      {
        id: 'p-1',
        name: 'Pool A',
        slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
        table_ids: ['t1', 't2'],
      },
    ])
  })

  // A blank player limit is "no cap" (ADR-0935): it must reach the wire as an
  // explicit `null`, never `0` and never omitted.
  it('carries max_players: null for an uncapped event', () => {
    const body = eventToCreateBody({ ...event, maxPlayers: null })
    expect(body.max_players).toBeNull()
  })

  it('round-trips through apiToEvent back to the prototype shape', () => {
    const wire = eventToCreateBody(event)
    const roundTripped = apiToEvent({
      ...wire,
      // eventToCreateBody always populates these, but they're typed optional on
      // the *create* body — coalesce so the value satisfies the *read* shape.
      predicates: wire.predicates ?? [],
      pools: wire.pools ?? [],
      // `max_players` is optional on the create body (`null`/absent = no cap,
      // ADR-0935); the read shape is `number | null`.
      max_players: wire.max_players ?? null,
      id: event.id,
      tournament_id: 't-1',
      // The registrations are server-owned and absent from the create body;
      // supply the read-shape entrants (the count derives from them) so the
      // round-trip assertion holds.
      entrants: [
        buildTournamentEntrantRead({
          id: 'entry-1',
          user_id: 'u-1',
          username: 'player.1',
          seed: 1,
          rating: 1720,
        }),
        buildTournamentEntrantRead({
          id: 'entry-2',
          user_id: 'u-2',
          username: 'player.2',
          seed: null,
          // Unrated on the wire, and still unrated on the far side of the mapping.
          rating: null,
        }),
      ],
      entered: event.entered,
      // Server-computed, and absent from the create body for the same reason the
      // entrants are: it is the server's judgement about *the caller*, not a field
      // the editor authors (ADR-0783).
      entry_state: { state: 'open' },
      // The DRAW is absent from the create body too, and for a third reason: a brand-new
      // event has no field to cut one from. Cutting is its own verb (ADR-0786).
      fixtures: [],
      // Results are absent from the create body for the same reason the draw is — nothing
      // to stand. Supplied as `null` so the round-trip reproduces the read shape.
      results: null,
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
    })

    expect(roundTripped).toEqual(event)
  })

  it('sends NO fixtures — a draw is cut by POST …/draw, never authored in an event body', () => {
    const body = eventToCreateBody(event)

    expect('fixtures' in body).toBe(false)
  })
})

describe('eventToUpdateBody', () => {
  it('maps the same snake_case fields as create', () => {
    const body = eventToUpdateBody(event)

    expect(body.draw_type).toBe('rr-then-ko')
    expect(body.max_players).toBe(48)
    expect(body.entry_fee).toBe(30)
    expect(body.match_settings).toEqual({ rated: true, length_games: 3 })
    expect(body.pools).toEqual([
      {
        id: 'p-1',
        name: 'Pool A',
        slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
        table_ids: ['t1', 't2'],
      },
    ])
  })

  // Clearing the cap sends an explicit `null` — the PATCH handler distinguishes
  // "clear the cap" (null present) from "leave it alone" (key absent), so this
  // must not be omitted (ADR-0935).
  it('carries max_players: null when the cap is cleared', () => {
    const body = eventToUpdateBody({ ...event, maxPlayers: null })
    expect('max_players' in body).toBe(true)
    expect(body.max_players).toBeNull()
  })

  it('omits the server-owned entered count so a PATCH never clobbers it', () => {
    const body = eventToUpdateBody(event)
    expect('entered' in body).toBe(false)
  })

  it('omits the entrants too — registrations are written through the entries endpoints, never an event PATCH', () => {
    const body = eventToUpdateBody(event)
    expect('entrants' in body).toBe(false)
  })

  // The same lost-update argument as `entered` and `entrants`, and with sharper teeth: a
  // PATCH that echoed the client's last-read `fixtures` back would let a rename throw
  // away a draw the director cut in another tab — or, worse, re-assert a stale one over
  // a re-cut. A draw moves only through `POST …/draw` and `DELETE …/draw` (ADR-0786).
  it('omits the draw — an event PATCH can neither cut, keep, nor clobber fixtures', () => {
    const body = eventToUpdateBody({
      ...event,
      fixtures: [
        {
          id: 'fx-1',
          poolId: 'p-1',
          round: 1,
          position: 1,
          entryAId: 'entry-1',
          entryBId: 'entry-2',
          winnerEntryId: null,
          matchId: null,
          matchStatus: null,
          tableId: null,
          scheduledStart: null,
        },
      ],
    })

    expect('fixtures' in body).toBe(false)
  })
})
