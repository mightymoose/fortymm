import { describe, expect, it } from 'vitest'

import {
  buildTournamentDetailRead,
  buildTournamentEntrantRead,
  buildTournamentEntrantReads,
  buildTournamentEventRead,
} from '@/mocks/factories/tournaments/tournament.factory'
import {
  apiToEntrant,
  apiToEvent,
  apiToTournament,
  draftToCreateBody,
  eventToCreateBody,
  eventToUpdateBody,
  tournamentToUpdateBody,
} from './api'
import type { Tournament, TournamentEvent } from './types'

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
          }),
        ],
      }),
    )

    expect(event.entrants).toEqual([
      { id: 'entry-9', userId: 'u-7', username: 'rita.kovac', seed: 3 },
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

describe('apiToEntrant', () => {
  it('renames user_id and passes an unseeded entrant through', () => {
    expect(
      apiToEntrant({
        id: 'entry-1',
        user_id: 'u-1',
        username: 'player.1',
        seed: null,
      }),
    ).toEqual({ id: 'entry-1', userId: 'u-1', username: 'player.1', seed: null })
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
  entrants: [
    { id: 'entry-1', userId: 'u-1', username: 'player.1', seed: 1 },
    { id: 'entry-2', userId: 'u-2', username: 'player.2', seed: null },
  ],
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

  it('round-trips through apiToEvent back to the prototype shape', () => {
    const wire = eventToCreateBody(event)
    const roundTripped = apiToEvent({
      ...wire,
      // eventToCreateBody always populates these, but they're typed optional on
      // the *create* body — coalesce so the value satisfies the *read* shape.
      predicates: wire.predicates ?? [],
      pools: wire.pools ?? [],
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
        }),
        buildTournamentEntrantRead({
          id: 'entry-2',
          user_id: 'u-2',
          username: 'player.2',
          seed: null,
        }),
      ],
      entered: event.entered,
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
    })

    expect(roundTripped).toEqual(event)
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

  it('omits the server-owned entered count so a PATCH never clobbers it', () => {
    const body = eventToUpdateBody(event)
    expect('entered' in body).toBe(false)
  })

  it('omits the entrants too — registrations are written through the entries endpoints, never an event PATCH', () => {
    const body = eventToUpdateBody(event)
    expect('entrants' in body).toBe(false)
  })
})
