import { describe, expect, it } from 'vitest'

import type { components } from '@/api/schema'
import {
  EVERY_SETTING_AUTOMATIC,
  buildTournamentDetailRead,
  buildTournamentEntrantRead,
  buildTournamentEntrantReads,
  buildTournamentEventRead,
  buildTournamentFixtureRead,
} from '@/mocks/factories/tournaments/tournament.factory'
import { everySettingAutomatic } from './draw-ownership'
import {
  apiToEntrant,
  apiToEntryState,
  apiToEvent,
  apiToTournament,
  catalogueToUpdateBody,
  draftToCreateBody,
  eventToCreateBody,
  eventToUpdateBody,
  tournamentToUpdateBody,
} from './api'
import { blankAddress } from './helpers'
import { addedPool, keepPools } from './pool-entries'
import { asEditedEvent } from './seed.factory'
import { addTable, keepTables } from './table-catalogue'
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

  it('maps a pool, renaming table_ids to tableIds and carrying its position', () => {
    const event = apiToEvent(
      buildTournamentEventRead({
        pools: [
          {
            id: 'p-1',
            name: 'Pool A',
            slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
            table_ids: ['t1', 't2'],
            // Not 0: the server's number, carried across as sent. A mapper that
            // recomputed it from the array index would look right on a first pool and be
            // wrong on every event whose pools arrived in any other order.
            position: 3,
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
        position: 3,
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
        pinnedAt: null,
        callNotifiedCount: 0,
        completedAt: null,
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
        pinnedAt: null,
        callNotifiedCount: 0,
        completedAt: null,
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
      pinnedAt: null,
      callNotifiedCount: 0,
        completedAt: null,
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

  /** The draw-type catalogue rides in on the detail payload and is what the event
   * editor's picker renders (ADR 20260726). Asserted with the server's own copy, since
   * that is what a director reads — and with the LIST route's `null`, which means
   * "this payload carried none", not "there are none". */
  it('carries the served draw-type catalogue through as the picker’s options', () => {
    const tournament = apiToTournament(
      buildTournamentDetailRead({
        draw_type_catalogue: [
          {
            key: 'single-elim',
            name: 'Single elimination',
            description: 'A knockout bracket.',
            display_order: 2,
          },
          {
            key: 'round-robin',
            name: 'Round robin',
            description: 'Everyone in a pool plays everyone else.',
            display_order: 1,
          },
        ],
      }),
    )

    expect(tournament.drawTypes).toEqual([
      { value: 'round-robin', label: 'Round robin' },
      { value: 'single-elim', label: 'Single elimination' },
    ])
  })

  it('keeps a withheld catalogue (the list route) as null', () => {
    const tournament = apiToTournament(
      buildTournamentDetailRead({ draw_type_catalogue: null }),
    )

    expect(tournament.drawTypes).toBeNull()
  })

  // `address: null` is a tournament with NO VENUE (CONTEXT.md, "Venue") — a
  // first-class state, so it is carried across untouched. Coalescing it to a blank
  // `Address` (the way `description` is coalesced above, one test down) would erase
  // the fact and hand every reader an address at (0, 0).
  it('carries a null address through as null — no venue is a state, not a hole', () => {
    const tournament = apiToTournament(
      buildTournamentDetailRead({ address: null }),
    )

    expect(tournament.address).toBeNull()
  })

  it('carries a present address through with its geocoded coordinates', () => {
    const tournament = apiToTournament(buildTournamentDetailRead())

    expect(tournament.address).toMatchObject({
      venue: 'Berkeley TT Club',
      latitude: 37.8715,
      longitude: -122.273,
    })
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
  // A read `Address` carries the server-geocoded coordinates (NOT NULL). The
  // write builders below must STRIP them — the create/edit wire shape is the
  // coord-free `AddressInput` — so the fixture is coord-carrying on purpose.
  address: {
    venue: 'Oakland Arena',
    street: '7000 Coliseum Way',
    city: 'Oakland',
    region: 'CA',
    postal: '94621',
    country: 'USA',
    latitude: 37.7503,
    longitude: -122.2032,
  },
  tableIds: [],
  events: [],
  latestScheduleSolve: null,
  // A draft that has never been fetched carries no served catalogue (ADR 20260726),
  // and the write builders below drop it either way — it is read-model data.
  drawTypes: null,
}

describe('draftToCreateBody', () => {
  it('maps the draft to a TournamentCreate with snake_case dates', () => {
    const body = draftToCreateBody(draft)

    expect(body).toEqual({
      name: 'Autumn Cup',
      description: 'A new draft.',
      start_date: '2026-09-01',
      end_date: '2026-09-02',
      // The write shape is the coord-free `AddressInput`: the six text fields
      // and NOTHING else. The draft's `address` carries `latitude`/`longitude`
      // (it is a read `Address`), so this asserts the projector STRIPPED them —
      // a client never sends coordinates, and the server 422s the extra keys.
      address: {
        venue: 'Oakland Arena',
        street: '7000 Coliseum Way',
        city: 'Oakland',
        region: 'CA',
        postal: '94621',
        country: 'USA',
      },
      table_catalogue: [],
    })
  })

  // A tournament created with NO VENUE (CONTEXT.md, "Venue") sends `address: null`
  // — the wire's word for it (`SubmittedAddress`), and the only spelling that does
  // not hand the server something to geocode.
  it('sends address: null for a draft with no venue', () => {
    const body = draftToCreateBody({ ...draft, address: null })

    expect(body.address).toBeNull()
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
    const body = tournamentToUpdateBody(tournament)

    expect(body.name).toBe('Renamed')
    expect(body.start_date).toBe('2026-09-01')
    expect(body.end_date).toBe('2026-09-02')
    // The edit wire shape is the coord-free `AddressInput` too: the tournament
    // is a read model carrying `latitude`/`longitude`, and the builder strips
    // them — the server geocodes on its own and 422s a client-sent coordinate.
    expect(body.address).toEqual({
      venue: 'Oakland Arena',
      street: '7000 Coliseum Way',
      city: 'Oakland',
      region: 'CA',
      postal: '94621',
      country: 'USA',
    })
    expect('events' in body).toBe(false)
  })

  // On a PATCH, an explicit `null` is what REMOVES the venue — omitting the field
  // would mean "leave it as it is", which is a different edit. So a tournament the
  // organizer has no venue for patches `address: null`, not an object of blanks.
  it('sends address: null for a tournament with no venue', () => {
    const tournament: Tournament = { ...draft, id: 't-1', address: null }
    const body = tournamentToUpdateBody(tournament)

    expect(body.address).toBeNull()
    // Present-and-null, not absent: "removed" and "unchanged" are different edits.
    expect('address' in body).toBe(true)
  })

  /**
   * THE CLEAR-ALL PATH, pinned. This is the shape the **Details tab** actually hands
   * this builder when the organizer empties all six venue boxes: not `null`, but an
   * all-blank `Address` — because the tab has to keep six boxes on screen to be
   * retyped into, so its draft holds `blankAddress()` (see `updateAddress` there).
   *
   * Both write verbs must put the SAME bytes on the wire for that one intent, and for
   * a while they did not: the create modal sent `null` while this sent six empty
   * strings, and only the server's own normalization made the two mean the same
   * thing. `toAddressInput` applies `hasVenue` for both now, so the spelling is one.
   *
   * The placeholder coordinates are the other half of the claim — `blankAddress()`
   * carries `0`/`0`, and (0, 0) is a real place in the Gulf of Guinea. Sending an
   * address at all here would have been an invitation to geocode it.
   */
  it('sends address: null when the organizer clears all six venue boxes', () => {
    const tournament: Tournament = {
      ...draft,
      id: 't-1',
      address: blankAddress(),
    }
    const body = tournamentToUpdateBody(tournament)

    expect(body.address).toBeNull()
    expect('address' in body).toBe(true)
  })

  /** Whitespace is not a venue either — the blankness test trims, so a box holding
   * only spaces is as empty as one holding nothing. Without this, "clear the box"
   * and "select-all and hit space" would be two different tournaments. */
  it('sends address: null when the only content left is whitespace', () => {
    const tournament: Tournament = {
      ...draft,
      id: 't-1',
      address: blankAddress({ venue: '   ', city: '\t\n' }),
    }

    expect(tournamentToUpdateBody(tournament).address).toBeNull()
  })

  /** The positive control for the three above. One non-blank component is a venue,
   * and it must still travel — otherwise `address: null` would be what this builder
   * always sends, and every assertion above would pass against a broken projector. */
  it('still sends an address when a single component holds something', () => {
    const tournament: Tournament = {
      ...draft,
      id: 't-1',
      address: blankAddress({ city: 'Oakland' }),
    }

    expect(tournamentToUpdateBody(tournament).address).toEqual({
      venue: '',
      street: '',
      city: 'Oakland',
      region: '',
      postal: '',
      country: '',
    })
  })

  // ADR-0017: editing a tournament cannot move its lifecycle. The status the
  // read model carries stays on the read model — it is never echoed back into
  // the patch, so renaming a `live` tournament can't rewind it to `draft`, and
  // a patch can't sneak it forward either. Transitions are their own endpoint.
  it('sends NO status — an edit cannot move the lifecycle', () => {
    const tournament: Tournament = { ...draft, id: 't-1', status: 'live' }
    const body = tournamentToUpdateBody(tournament)

    expect('status' in body).toBe(false)
  })

  // Under the server's id-keyed diff (ADR 20260801) an uncited stored table is a
  // REMOVAL — so a Details-tab save must not cite the catalogue at all: an id
  // list can drift stale, but an ABSENT key cannot. Omitting the key entirely is
  // what the server's own `_reject_explicit_null` treats as "unchanged"
  // (`api/app/schemas/tournament.py`) — the same field sent as `null` is a 422.
  it('sends NO table_catalogue — an absent key can’t drift stale into a removal', () => {
    const tournament: Tournament = { ...draft, id: 't-1', tableIds: ['t1', 't2'] }
    const body = tournamentToUpdateBody(tournament)

    expect('table_catalogue' in body).toBe(false)
  })
})

describe('catalogueToUpdateBody', () => {
  const stored = [
    { id: 't1', label: 'T1', court: 'A' },
    { id: 't2', label: 'T2', court: 'B' },
  ]

  it('cites kept tables by id and sends an added one with NO id key', () => {
    const body = catalogueToUpdateBody(
      [...keepTables(stored), addTable('T3', 'C')],
      { unplaceFixturesOnRemovedTables: false },
    )

    expect(body.table_catalogue).toEqual([
      { id: 't1', label: 'T1', court: 'A' },
      { id: 't2', label: 'T2', court: 'B' },
      { label: 'T3', court: 'C' },
    ])
    // Not `id: null` — the key is absent, so a reader can see at a glance that this
    // row cites nothing and is therefore an insert.
    expect('id' in body.table_catalogue![2]).toBe(false)
  })

  // A removal IS an omission: the diff is keyed by id, so leaving a stored table out
  // is the only way to ask for it to go.
  it('removes a table by leaving it out', () => {
    const body = catalogueToUpdateBody(keepTables([stored[1]]), {
      unplaceFixturesOnRemovedTables: false,
    })

    expect(body.table_catalogue).toEqual([{ id: 't2', label: 'T2', court: 'B' }])
  })

  // A PATCH leaves an absent field unchanged. Re-sending the name/dates/address a
  // table edit never touched would make every add a chance to clobber a rename
  // another tab made in between.
  it('sends the catalogue and NOTHING else', () => {
    const body = catalogueToUpdateBody(keepTables(stored), {
      unplaceFixturesOnRemovedTables: false,
    })

    expect(Object.keys(body)).toEqual(['table_catalogue'])
  })

  // The opt-in has one affirmative spelling and is *said on purpose* — by a director
  // who has read the 409. A body that always carried the key would make that answer
  // look like a default; omitted and `false` mean the same thing to the server.
  it('omits the opt-in unless it is being given', () => {
    const body = catalogueToUpdateBody(keepTables(stored), {
      unplaceFixturesOnRemovedTables: false,
    })

    expect('unplace_fixtures_on_removed_tables' in body).toBe(false)
  })

  it('sends the opt-in as true when the organizer confirmed', () => {
    const body = catalogueToUpdateBody(keepTables(stored), {
      unplaceFixturesOnRemovedTables: true,
    })

    expect(body.unplace_fixtures_on_removed_tables).toBe(true)
    // The rest of the body is byte-identical to the refused one — the confirm
    // re-sends the same edit, it does not recompute it.
    expect(body.table_catalogue).toEqual(stored)
  })
})

const event: TournamentEvent = {
  id: 'ev-1',
  name: 'U1500 Singles',
  format: 'singles',
  drawType: 'round-robin',
  // A round-robin event has no knockout stage to qualify for, so it carries NO qualifier
  // count (ADR 20260727). `null` is the only value its draw settings admit — and the
  // write bodies below must OMIT the key entirely rather than send this `null`, because
  // that arm of the server's draw-settings union is `extra="forbid"`.
  qualifiersPerPool: null,
  // …and its rounds come off the circle method rather than a setting, so it carries NO
  // round count either (the swiss ADR). Same rule as the qualifier count above: the write
  // bodies must OMIT the key, not send this `null`.
  rounds: null,
  // …and it has no pool stage to own the structure of, so it carries no ownership record
  // either (ADR 20260808). `null` again, and the write bodies must OMIT `draw_structure`
  // for the same `extra="forbid"` reason.
  drawOwnership: null,
  maxPlayers: 48,
  entryFee: 30,
  timezone: 'America/Chicago',
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
      // The server's number, held on the read model. The write bodies below must NOT
      // carry it — both write shapes forbid the key — which is what the create/update
      // assertions pin. The `id` above is the server's too, and only a PATCH may cite
      // it: a create body carrying one is a 422 (ADR 20260801).
      position: 0,
    },
  ],
  // No draw cut (ADR-0786). The write bodies below must not carry one either — a draw
  // is written by the two draw verbs and by nothing else.
  fixtures: [],
  // No results (ADR-0788): no draw, nothing to stand.
  results: null,
}

/** The event as the **editor** hands it back with its pools untouched: each one cited by
 * the id the server minted (`asEditedEvent` → `keepPools`). This is what the write
 * mappers take — a read event no longer is one, which is the compile-time half of ADR
 * 20260801. */
const edited = asEditedEvent(event)

describe('eventToCreateBody', () => {
  it('maps the event to a snake_case create body, excluding server-managed entered', () => {
    const body = eventToCreateBody(edited)

    expect(body.draw_type).toBe('round-robin')
    expect(body.max_players).toBe(48)
    expect(body.entry_fee).toBe(30)
    // The IANA timezone anchors the windows (ADR 20260719) — carried on the create
    // body, `NOT NULL` on the server.
    expect(body.timezone).toBe('America/Chicago')
    expect(body.match_settings).toEqual({ rated: true, length_games: 3 })
    // NO `id` — a created event's pools are all new, and a pool's id is the server's to
    // mint (`PoolWrite` has no such field, and `extra="forbid"` makes a supplied one a
    // 422 on `body.pools[0].id`).
    expect(body.pools).toEqual([
      {
        name: 'Pool A',
        slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
        table_ids: ['t1', 't2'],
      },
    ])
  })

  /** ⚠️ The discriminating one. `toEqual` above would pass a body whose pool carried an
   * `id: undefined` key — and JSON.stringify would drop it, so even the bytes would look
   * right — but it would NOT pass one carrying a real id, which is what the editor used
   * to send. Asked as a key question so the claim is about the shape, not about a value
   * that happens to be absent. */
  it('sends each pool with NO id key at all — the server mints it', () => {
    const body = eventToCreateBody(
      asEditedEvent(event, [
        ...keepPools(event.pools),
        addedPool({
          name: 'Pool B',
          slot: { date: '2026-06-14', start: '13:00', end: '16:00' },
          tableIds: ['t3'],
        }),
      ]),
    )

    expect(body.pools).toHaveLength(2)
    for (const pool of body.pools ?? []) {
      expect('id' in pool).toBe(false)
      expect('position' in pool).toBe(false)
    }
  })

  // A blank player limit is "no cap" (ADR-0935): it must reach the wire as an
  // explicit `null`, never `0` and never omitted.
  it('carries max_players: null for an uncapped event', () => {
    const body = eventToCreateBody(asEditedEvent({ ...event, maxPlayers: null }))
    expect(body.max_players).toBeNull()
  })

  it('round-trips through apiToEvent back to the prototype shape', () => {
    const wire = eventToCreateBody(edited)
    const roundTripped = apiToEvent({
      ...wire,
      // eventToCreateBody always populates these, but they're typed optional on
      // the *create* body — coalesce so the value satisfies the *read* shape.
      predicates: wire.predicates ?? [],
      // The create body carries neither an `id` nor a `position` (`PoolWrite` forbids
      // both), and the read shape requires both — so the round trip has to close the gap
      // the way the SERVER closes it: the id is MINTED, and the position is the pool's
      // index in the list that was sent. Carrying either through from the write body
      // instead would make the round trip pass while the app and the API disagreed about
      // who owns a pool's identity — and on the position, about which pool is first.
      pools: (wire.pools ?? []).map((pool, index) => ({
        ...pool,
        id: event.pools[index].id,
        position: index,
      })),
      // `max_players` is optional on the create body (`null`/absent = no cap,
      // ADR-0935); the read shape is `number | null`.
      max_players: wire.max_players ?? null,
      // The create body OMITS the qualifier count for a round-robin event (the server's
      // union forbids the key on that arm), while the read shape carries it as an
      // explicit `null`. Supplying it here is what makes the round trip land back on
      // `event` — and the assertion below is therefore also the proof that the omission
      // and the `null` mean the same thing.
      qualifiers_per_pool: null,
      // …and the round count the same way, for the same reason: omitted on the way out for
      // a round-robin event, an explicit `null` on the way back.
      rounds: null,
      // …and the structural-ownership block the same way once more (ADR 20260808). A
      // round-robin event has no pool count, pool size, qualifier count or membership rule
      // for a director to take, so the read carries `null` — only an `rr-then-ko` event
      // comes back with a structure at all.
      draw_structure: null,
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
    const body = eventToCreateBody(edited)

    expect('fixtures' in body).toBe(false)
  })
})

describe('eventToUpdateBody', () => {
  it('maps the same snake_case fields as create', () => {
    const body = eventToUpdateBody(edited)

    expect(body.draw_type).toBe('round-robin')
    expect(body.max_players).toBe(48)
    expect(body.entry_fee).toBe(30)
    expect(body.timezone).toBe('America/Chicago')
    expect(body.match_settings).toEqual({ rated: true, length_games: 3 })
    // A PATCH is the id-keyed diff (ADR 20260801), so a pool the event already has is
    // CITED — that is what keeps its id, and every fixture drawn into it. Unlike the
    // create body one describe up, which carries no id at all.
    expect(body.pools).toEqual([
      {
        id: 'p-1',
        name: 'Pool A',
        slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
        table_ids: ['t1', 't2'],
      },
    ])
  })

  /**
   * The three statements a pools diff can make, in one body: keep this one, add that one,
   * and — by saying nothing about it — remove the third.
   *
   * The renamed `kept` entry is the load-bearing half: it proves a re-worded pool still
   * cites its id, rather than arriving as an add (which would mint a second pool and
   * delete the one holding the fixtures).
   */
  it('expresses a pools edit as the id-keyed diff: cite, add, and omit', () => {
    const stored = [
      event.pools[0],
      { ...event.pools[0], id: 'p-2', name: 'Pool B', position: 1 },
    ]
    const body = eventToUpdateBody(
      asEditedEvent({ ...event, pools: stored }, [
        // Pool A, renamed — still cited, so it keeps its id.
        { ...keepPools([stored[0]])[0], name: 'Morning Pool' },
        // …a brand-new one, with no id for the server to mint against.
        addedPool({
          name: 'Pool C',
          slot: { date: '2026-06-14', start: '13:00', end: '16:00' },
          tableIds: ['t3'],
        }),
        // …and Pool B is simply not here. An uncited stored pool is a removal.
      ]),
    )

    expect(body.pools).toEqual([
      {
        id: 'p-1',
        name: 'Morning Pool',
        slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
        table_ids: ['t1', 't2'],
      },
      {
        name: 'Pool C',
        slot: { date: '2026-06-14', start: '13:00', end: '16:00' },
        table_ids: ['t3'],
      },
    ])
    // The added entry omits the KEY rather than sending `id: null`: both are accepted,
    // but a payload a reader can eyeball and see "this entry cites nothing, so it is an
    // insert" is the whole readability of a diff.
    expect('id' in (body.pools ?? [])[1]).toBe(false)
  })

  // Clearing the cap sends an explicit `null` — the PATCH handler distinguishes
  // "clear the cap" (null present) from "leave it alone" (key absent), so this
  // must not be omitted (ADR-0935).
  it('carries max_players: null when the cap is cleared', () => {
    const body = eventToUpdateBody(asEditedEvent({ ...event, maxPlayers: null }))
    expect('max_players' in body).toBe(true)
    expect(body.max_players).toBeNull()
  })

  // ⚠️ The claim these make is about **the bytes on the wire**, never about form state:
  // the whole point of the server-side detour (ADR 20260727) is that the count the
  // director configured reaches the API, and a director's `2` that a mapper drops is a
  // bracket cut for a K they never chose — silent, well-formed and wrong.
  describe('the draw configuration on the wire (ADR 20260727)', () => {
    const twoStage: TournamentEvent = {
      ...event,
      drawType: 'rr-then-ko',
      qualifiersPerPool: 2,
    }

    it('SENDS the qualifier count for rr-then-ko, on both verbs', () => {
      expect(eventToCreateBody(asEditedEvent(twoStage)).qualifiers_per_pool).toBe(2)
      expect(eventToUpdateBody(asEditedEvent(twoStage)).qualifiers_per_pool).toBe(2)
    })

    it('sends the DIRECTOR’s count, never a default', () => {
      // `1` is what the planner falls back to when nobody says otherwise, so a fixture
      // of 1 could not tell "threaded through" from "fell back". Three is neither the
      // fallback nor the convention.
      const body = eventToUpdateBody(
        asEditedEvent({ ...twoStage, qualifiersPerPool: 3 }),
      )
      expect(body.qualifiers_per_pool).toBe(3)
    })

    // The two count-less arms of the server's draw-settings union are `extra="forbid"`
    // and declare no `qualifiers_per_pool` field at all, so the key is a **422** there —
    // not a `null` politely ignored. Omission is therefore the only correct spelling, and
    // `toBeNull()` would pass against the payload that gets refused.
    it.each(['round-robin', 'single-elim'] as const)(
      'OMITS the key entirely for %s — where sending it is a 422, not a no-op',
      (drawType) => {
        const create = eventToCreateBody(asEditedEvent({ ...event, drawType }))
        const update = eventToUpdateBody(asEditedEvent({ ...event, drawType }))

        expect('qualifiers_per_pool' in create).toBe(false)
        expect('qualifiers_per_pool' in update).toBe(false)
      },
    )

    // The far half of the round trip the read shape's `qualifiers_per_pool` was added
    // for: what the server stored comes back, and reaches the control.
    it('reads the stored count back off the wire', () => {
      const read = apiToEvent(
        buildTournamentEventRead({ draw_type: 'rr-then-ko', qualifiers_per_pool: 4 }),
      )

      expect(read.qualifiersPerPool).toBe(4)
    })

    it('reads a count-less draw type back as null, never as a number', () => {
      const read = apiToEvent(buildTournamentEventRead({ draw_type: 'round-robin' }))

      expect(read.qualifiersPerPool).toBeNull()
    })

    it('round-trips a two-stage event: configure 2, send 2, read 2 back', () => {
      const sent = eventToUpdateBody(asEditedEvent(twoStage))
      const stored = buildTournamentEventRead({
        draw_type: 'rr-then-ko',
        qualifiers_per_pool: sent.qualifiers_per_pool,
      })

      expect(apiToEvent(stored).qualifiersPerPool).toBe(2)
    })
  })

  /**
   * The **ownership record** on the wire (ADR 20260808) — `draw_structure`, the modes and
   * the two manual pool numbers.
   *
   * The same claim as the qualifier count's, and it fails the same silent way: a director
   * who took the pool count and typed 6, whose modes a mapper dropped, gets an event that
   * looks saved and cuts four pools. The record travels on the `rr-then-ko` arm and **only**
   * that arm, because the other three are `extra="forbid"`.
   */
  describe('the ownership record on the wire (ADR 20260808)', () => {
    const twoStage: TournamentEvent = {
      ...event,
      drawType: 'rr-then-ko',
      qualifiersPerPool: 2,
      drawOwnership: {
        ...everySettingAutomatic(),
        poolCountMode: 'manual',
        manualPoolCount: 6,
        poolSizeMode: 'manual',
        manualPoolSize: 5,
        membershipMode: 'manual',
      },
    }

    it('SENDS what the director owns, on both verbs', () => {
      const expected = {
        pool_count_mode: 'manual',
        manual_pool_count: 6,
        pool_size_mode: 'manual',
        manual_pool_size: 5,
        qualifiers_mode: 'automatic',
        membership_mode: 'manual',
      }

      expect(eventToCreateBody(asEditedEvent(twoStage)).draw_structure).toEqual(
        expected,
      )
      expect(eventToUpdateBody(asEditedEvent(twoStage)).draw_structure).toEqual(
        expected,
      )
    })

    // An event that has never seen the tab has no record, and the editor still sends one:
    // it puts back what it rendered, which is every setting the system's. (The same
    // structure the server's own `default_factory` would have written — so this is the
    // honest form of the request, not a different one.)
    it('sends the all-automatic record for an event that has never had one', () => {
      const body = eventToUpdateBody(asEditedEvent({ ...twoStage, drawOwnership: null }))

      expect(body.draw_structure).toEqual({
        pool_count_mode: 'automatic',
        manual_pool_count: null,
        pool_size_mode: 'automatic',
        manual_pool_size: null,
        qualifiers_mode: 'automatic',
        membership_mode: 'snake',
      })
    })

    // The three structure-less arms declare no `draw_structure` field at all, so the key
    // is a **422** there — not a `null` politely ignored. `toBeNull()` would pass against
    // the payload that gets refused.
    it.each(['round-robin', 'single-elim'] as const)(
      'OMITS the key entirely for %s — where sending it is a 422, not a no-op',
      (drawType) => {
        const create = eventToCreateBody(asEditedEvent({ ...event, drawType }))
        const update = eventToUpdateBody(asEditedEvent({ ...event, drawType }))

        expect('draw_structure' in create).toBe(false)
        expect('draw_structure' in update).toBe(false)
      },
    )

    // The near half of the round trip: what the server stored comes back in this client's
    // vocabulary, and reaches the tab.
    it('reads a stored record back off the wire', () => {
      const read = apiToEvent(
        buildTournamentEventRead({
          draw_type: 'rr-then-ko',
          qualifiers_per_pool: 2,
          draw_structure: {
            ...EVERY_SETTING_AUTOMATIC,
            pool_count_mode: 'manual',
            manual_pool_count: 6,
          },
        }),
      )

      expect(read.drawOwnership).toEqual({
        ...everySettingAutomatic(),
        poolCountMode: 'manual',
        manualPoolCount: 6,
      })
    })

    it('reads a structure-less draw type back as null, never as a record', () => {
      const read = apiToEvent(buildTournamentEventRead({ draw_type: 'round-robin' }))

      expect(read.drawOwnership).toBeNull()
    })

    // PARSED, not cast (`.claude/rules/parse-at-boundaries.md`). A manual `0` is a number
    // the server's `ge=1` could never have stored, and it is the exact value a cleared box
    // would author on the way back out — a 422 three components from here. It fails
    // INSIDE the mapper, where the payload is.
    it('throws on a manual number the server could never have stored', () => {
      expect(() =>
        apiToEvent(
          buildTournamentEventRead({
            draw_type: 'rr-then-ko',
            qualifiers_per_pool: 2,
            draw_structure: {
              ...EVERY_SETTING_AUTOMATIC,
              pool_count_mode: 'manual',
              manual_pool_count: 0,
            },
          }),
        ),
      ).toThrow()
    })

    it('round-trips a taken setting: type 6 pools, send 6, read 6 back', () => {
      const sent = eventToUpdateBody(asEditedEvent(twoStage))
      const stored = buildTournamentEventRead({
        draw_type: 'rr-then-ko',
        qualifiers_per_pool: 2,
        draw_structure: sent.draw_structure,
      })

      expect(apiToEvent(stored).drawOwnership).toEqual(twoStage.drawOwnership)
    })
  })

  // The same claim for the same reason, one draw type over (ADR "swiss pre-cuts every round
  // and pairs each one on advance"): the round count the director configured has to reach
  // the API, because it is what sizes the whole draw (`R × ⌊n/2⌋` fixtures, cut up front).
  // A dropped R is a swiss of the wrong length — silent, well-formed and wrong.
  describe('the swiss round count on the wire', () => {
    const swiss: TournamentEvent = { ...event, drawType: 'swiss', rounds: 5 }
    const twoStage: TournamentEvent = {
      ...event,
      drawType: 'rr-then-ko',
      qualifiersPerPool: 2,
    }

    it('SENDS the round count for swiss, on both verbs', () => {
      expect(eventToCreateBody(asEditedEvent(swiss)).rounds).toBe(5)
      expect(eventToUpdateBody(asEditedEvent(swiss)).rounds).toBe(5)
    })

    it('sends the DIRECTOR’s count, never a default', () => {
      // `1` is the smallest legal R and the shape a dropped setting lands on, so a fixture
      // of 1 could not tell "threaded through" from "fell back". Seven is neither.
      const body = eventToUpdateBody(asEditedEvent({ ...swiss, rounds: 7 }))
      expect(body.rounds).toBe(7)
    })

    // The three round-count-less arms of the server's draw-settings union are
    // `extra="forbid"` and declare no `rounds` field at all, so the key is a **422** there —
    // not a `null` politely ignored. Omission is the only correct spelling, and `toBeNull()`
    // would pass against the payload that gets refused.
    it.each(['round-robin', 'single-elim'] as const)(
      'OMITS the key entirely for %s — where sending it is a 422, not a no-op',
      (drawType) => {
        const create = eventToCreateBody(asEditedEvent({ ...event, drawType }))
        const update = eventToUpdateBody(asEditedEvent({ ...event, drawType }))

        expect('rounds' in create).toBe(false)
        expect('rounds' in update).toBe(false)
      },
    )

    // The two settings are on OPPOSITE arms, so each body carries exactly one of them. A
    // swiss body with a `qualifiers_per_pool` is a 422 naming the field, and vice versa —
    // which a mapper that merely added a key rather than choosing an arm would author.
    it('sends only its own arm’s setting, never both', () => {
      const swissBody = eventToUpdateBody(asEditedEvent(swiss))
      expect('qualifiers_per_pool' in swissBody).toBe(false)

      const twoStageBody = eventToUpdateBody(asEditedEvent(twoStage))
      expect('rounds' in twoStageBody).toBe(false)
    })

    it('reads the stored round count back off the wire', () => {
      const read = apiToEvent(
        buildTournamentEventRead({ draw_type: 'swiss', rounds: 4 }),
      )

      expect(read.rounds).toBe(4)
    })

    it('reads a round-count-less draw type back as null, never as a number', () => {
      const read = apiToEvent(buildTournamentEventRead({ draw_type: 'round-robin' }))

      expect(read.rounds).toBeNull()
    })

    it('round-trips a swiss event: configure 5, send 5, read 5 back', () => {
      const sent = eventToUpdateBody(asEditedEvent(swiss))
      const stored = buildTournamentEventRead({
        draw_type: 'swiss',
        rounds: sent.rounds,
      })

      expect(apiToEvent(stored).rounds).toBe(5)
    })
  })

  it('omits the server-owned entered count so a PATCH never clobbers it', () => {
    const body = eventToUpdateBody(edited)
    expect('entered' in body).toBe(false)
  })

  it('omits the entrants too — registrations are written through the entries endpoints, never an event PATCH', () => {
    const body = eventToUpdateBody(edited)
    expect('entrants' in body).toBe(false)
  })

  // The same lost-update argument as `entered` and `entrants`, and with sharper teeth: a
  // PATCH that echoed the client's last-read `fixtures` back would let a rename throw
  // away a draw the director cut in another tab — or, worse, re-assert a stale one over
  // a re-cut. A draw moves only through `POST …/draw` and `DELETE …/draw` (ADR-0786).
  it('omits the draw — an event PATCH can neither cut, keep, nor clobber fixtures', () => {
    const body = eventToUpdateBody({
      ...edited,
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
          pinnedAt: null,
          callNotifiedCount: 0,
        completedAt: null,
        },
      ],
    })

    expect('fixtures' in body).toBe(false)
  })
})
