// The dev store models entries the way the server does (ADR-0016): the `entered`
// count is DERIVED from the active entrants, so the two can never disagree, and
// withdrawing frees the player to enter again.

import { beforeEach, describe, expect, it } from 'vitest'

import {
  createEvent,
  enterEvent,
  findTournament,
  resetTournamentsStore,
  transitionTournament,
  updateEvent,
  updateTournament,
  withdrawEntry,
} from './tournaments-store'
import type { components } from '@/api/schema'

type TournamentStatus = components['schemas']['TournamentStatus']

const TOURNAMENT = 'bay-area-open-2026'
const EMPTY_SINGLES = 'ev-u1500' // seeded with no entrants
const FULLISH_SINGLES = 'ev-open-singles' // seeded with 52 other players
const DOUBLES = 'ev-mixed-doubles'

function event(eventId: string) {
  const found = findTournament(TOURNAMENT)!.events.find((e) => e.id === eventId)
  if (!found) throw new Error(`no seeded event ${eventId}`)
  return found
}

beforeEach(() => resetTournamentsStore())

describe('the seeded read shape', () => {
  it('derives entered from the entrants it lists, never a stored number', () => {
    expect(event(FULLISH_SINGLES).entrants).toHaveLength(52)
    expect(event(FULLISH_SINGLES).entered).toBe(52)
    expect(event(EMPTY_SINGLES).entrants).toEqual([])
    expect(event(EMPTY_SINGLES).entered).toBe(0)
  })
})

describe('enterEvent', () => {
  it('makes the next read of the event show the entrant AND an incremented count', () => {
    const result = enterEvent(TOURNAMENT, EMPTY_SINGLES)

    expect(result.ok).toBe(true)
    const after = event(EMPTY_SINGLES)
    expect(after.entrants.map((e) => e.username)).toEqual(['rita.kovac'])
    expect(after.entered).toBe(1)
  })

  it('increments a busy event from 52 to 53 — count and list stay in step', () => {
    enterEvent(TOURNAMENT, FULLISH_SINGLES)

    const after = event(FULLISH_SINGLES)
    expect(after.entered).toBe(53)
    expect(after.entrants).toHaveLength(53)
  })

  it('409s a second active entry rather than adding a second row', () => {
    enterEvent(TOURNAMENT, EMPTY_SINGLES)

    expect(enterEvent(TOURNAMENT, EMPTY_SINGLES)).toEqual({
      ok: false,
      status: 409,
    })
    expect(event(EMPTY_SINGLES).entered).toBe(1)
  })

  it('400s a doubles event — one row per user cannot express a pairing', () => {
    expect(enterEvent(TOURNAMENT, DOUBLES)).toEqual({ ok: false, status: 400 })
    expect(event(DOUBLES).entered).toBe(0)
  })

  it('404s an unknown tournament or event', () => {
    expect(enterEvent('nope', EMPTY_SINGLES)).toEqual({ ok: false, status: 404 })
    expect(enterEvent(TOURNAMENT, 'ev-nope')).toEqual({ ok: false, status: 404 })
  })

  it('is allowed on a tournament the entrant does not own — entry is not creator-gated', () => {
    const notMine = findTournament('club-champs-2026')!
    expect(notMine.can_edit).toBe(false)

    const result = enterEvent('club-champs-2026', 'ev-cc-open')

    expect(result.ok).toBe(true)
    const found = findTournament('club-champs-2026')!.events.find(
      (e) => e.id === 'ev-cc-open',
    )!
    expect(found.entered).toBe(29)
  })
})

describe('withdrawEntry', () => {
  it('removes the entrant AND decrements the count', () => {
    const entered = enterEvent(TOURNAMENT, EMPTY_SINGLES)
    if (!entered.ok) throw new Error('setup failed')

    expect(
      withdrawEntry(TOURNAMENT, EMPTY_SINGLES, entered.entrant.id),
    ).toEqual({ ok: true })
    const after = event(EMPTY_SINGLES)
    expect(after.entrants).toEqual([])
    expect(after.entered).toBe(0)
  })

  it('lets the player enter again afterwards — a withdrawal is not a lockout', () => {
    const first = enterEvent(TOURNAMENT, EMPTY_SINGLES)
    if (!first.ok) throw new Error('setup failed')
    withdrawEntry(TOURNAMENT, EMPTY_SINGLES, first.entrant.id)

    expect(enterEvent(TOURNAMENT, EMPTY_SINGLES).ok).toBe(true)
    expect(event(EMPTY_SINGLES).entered).toBe(1)
  })

  it('is idempotent — withdrawing an already-withdrawn entry is not an error', () => {
    const first = enterEvent(TOURNAMENT, EMPTY_SINGLES)
    if (!first.ok) throw new Error('setup failed')
    withdrawEntry(TOURNAMENT, EMPTY_SINGLES, first.entrant.id)

    expect(
      withdrawEntry(TOURNAMENT, EMPTY_SINGLES, first.entrant.id),
    ).toEqual({ ok: true })
    expect(event(EMPTY_SINGLES).entered).toBe(0)
  })

  it("403s someone else's entry, leaving the count alone", () => {
    const theirs = event(FULLISH_SINGLES).entrants[0]

    expect(withdrawEntry(TOURNAMENT, FULLISH_SINGLES, theirs.id)).toEqual({
      ok: false,
      status: 403,
    })
    expect(event(FULLISH_SINGLES).entered).toBe(52)
  })
})

describe('the rest of the event surface still holds', () => {
  it('creates an event with no entrants and a zero count', () => {
    const result = createEvent(TOURNAMENT, {
      name: 'Novice Singles',
      format: 'singles',
      draw_type: 'single-elim',
      max_players: 16,
      entry_fee: 10,
      slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
      match_settings: { rated: false, length_games: 3 },
    })
    if (!result.ok) throw new Error('create failed')

    expect(result.event.entrants).toEqual([])
    expect(result.event.entered).toBe(0)
  })

  it('leaves the registrations untouched when the event is edited', () => {
    enterEvent(TOURNAMENT, EMPTY_SINGLES)

    const result = updateEvent(TOURNAMENT, EMPTY_SINGLES, { name: 'Renamed' })
    if (!result.ok) throw new Error('update failed')

    expect(result.event.name).toBe('Renamed')
    expect(result.event.entered).toBe(1)
    expect(event(EMPTY_SINGLES).entrants).toHaveLength(1)
  })
})

// The lifecycle (ADR-0017). The store enforces the SERVER's edge table, not a
// looser one: a mock that permitted an illegal edge would let a broken UI look
// fine in dev and in vitest, which is the entire point of mirroring it.
describe('transitionTournament', () => {
  const DRAFT = 'summer-slam-2026' // seeded `draft`, owned
  const PUBLISHED = 'bay-area-open-2026' // seeded `published`, owned
  const NOT_MINE = 'club-champs-2026' // seeded `live`, can_edit: false

  const STATUSES: TournamentStatus[] = ['draft', 'published', 'live', 'archived']
  const LEGAL: [TournamentStatus, TournamentStatus][] = [
    ['draft', 'published'],
    ['published', 'live'],
    ['live', 'archived'],
  ]

  /** Walk the owned draft forward to `status` along legal edges only, so each
   * case starts from a tournament genuinely IN that status. */
  function at(status: TournamentStatus): string {
    const path: TournamentStatus[] = ['published', 'live', 'archived']
    for (const step of path.slice(0, path.indexOf(status) + 1)) {
      const result = transitionTournament(DRAFT, step)
      if (!result.ok) throw new Error(`setup failed: could not reach ${status}`)
    }
    return DRAFT
  }

  it.each(LEGAL)('moves %s → %s', (from, to) => {
    const id = at(from)

    const result = transitionTournament(id, to)

    expect(result.ok).toBe(true)
    expect(findTournament(id)!.status).toBe(to)
  })

  // Every pair that is NOT one of the three legal edges — 13 of the 16, including
  // the four self-transitions (`published → published` is a stale client, not a
  // no-op) and every edge out of the terminal `archived`.
  const ILLEGAL = STATUSES.flatMap((from) =>
    STATUSES.filter(
      (to) => !LEGAL.some(([f, t]) => f === from && t === to),
    ).map((to) => [from, to] as const),
  )

  it.each(ILLEGAL)('409s %s → %s, and does not move', (from, to) => {
    const id = at(from)

    const result = transitionTournament(id, to)

    expect(result).toEqual({
      ok: false,
      status: 409,
      // The server's wording, verbatim — a stale tab is shown this, so the copy
      // is part of the contract.
      detail: `This tournament is ${from}; it cannot be moved to ${to}.`,
    })
    expect(findTournament(id)!.status).toBe(from)
  })

  it('403s a tournament the caller does not own, whatever the edge', () => {
    expect(transitionTournament(NOT_MINE, 'archived')).toEqual({
      ok: false,
      status: 403,
    })
    expect(findTournament(NOT_MINE)!.status).toBe('live')
  })

  it('404s an unknown tournament — missing beats not-yours beats illegal', () => {
    expect(transitionTournament('nope', 'published')).toEqual({
      ok: false,
      status: 404,
    })
  })

  // The load-bearing half of ADR-0017: with `status` gone from `TournamentUpdate`,
  // editing a tournament's fields cannot move its lifecycle. The transitions
  // resource is the only door.
  it('is the ONLY way a status changes — a field edit leaves it where it was', () => {
    const result = updateTournament(PUBLISHED, { name: 'Renamed Open' })
    if (!result.ok) throw new Error('update failed')

    expect(result.tournament.name).toBe('Renamed Open')
    expect(result.tournament.status).toBe('published')
    expect(findTournament(PUBLISHED)!.status).toBe('published')
  })
})
