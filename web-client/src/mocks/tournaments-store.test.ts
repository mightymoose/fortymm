// The dev store models entries the way the server does (ADR-0016): the `entered`
// count is DERIVED from the active entrants, so the two can never disagree, and
// withdrawing frees the player to enter again.

import { beforeEach, describe, expect, it } from 'vitest'

import {
  createEvent,
  enterEvent,
  findTournament,
  listTournaments,
  resetTournamentsStore,
  transitionTournament,
  updateEvent,
  updateTournament,
  withdrawEntry,
  type EnterResult,
  type WithdrawResult,
} from './tournaments-store'
import type { components } from '@/api/schema'

type TournamentStatus = components['schemas']['TournamentStatus']

const TOURNAMENT = 'bay-area-open-2026' // seeded `published`, owned
const DRAFT_TOURNAMENT = 'summer-slam-2026' // seeded `draft`, owned, no events
const EMPTY_SINGLES = 'ev-u1500' // seeded with no entrants
const FULLISH_SINGLES = 'ev-open-singles' // seeded with 52 other players
const DOUBLES = 'ev-mixed-doubles'

/** What each closed status must SAY — the distinctive phrase of the server's
 * sentence for it (`_registration_closed_detail`, `api/app/tournaments.py`), the
 * way the API's own tests assert it ("already under way").
 *
 * A fragment, not the sentence: re-typing all three in full here would only prove
 * this file equals itself — the store's copy and the test's copy would be two
 * hand-written copies of the server's, and a drift in either could be "fixed" by
 * editing the other. What is worth pinning is that live/draft/archived are three
 * DIFFERENT pieces of news and that the store gives each one its own. */
const CLOSED_PHRASE: Record<Exclude<TournamentStatus, 'published'>, string> = {
  draft: 'has not been published yet',
  live: 'already under way',
  archived: 'has ended',
}

const STATUSES: TournamentStatus[] = ['draft', 'published', 'live', 'archived']
const CLOSED_STATUSES = ['draft', 'live', 'archived'] as const

/** Assert a refusal is the registration-window 409, and that it says WHY in the
 * words the server uses for that status. */
function expectRegistrationClosed(
  result: EnterResult | WithdrawResult,
  status: Exclude<TournamentStatus, 'published'>,
) {
  if (result.ok || result.status !== 409) {
    throw new Error(`expected a 409, got ${JSON.stringify(result)}`)
  }
  expect(result.detail).toContain(CLOSED_PHRASE[status])
}

function event(eventId: string) {
  const found = findTournament(TOURNAMENT)!.events.find((e) => e.id === eventId)
  if (!found) throw new Error(`no seeded event ${eventId}`)
  return found
}

/** A tournament genuinely IN `status`, holding an empty singles event and a
 * doubles event.
 *
 * The lifecycle is forward-only, so there is no walking a tournament *back* to
 * `draft`: the draft case is the seeded draft (which has no events of its own)
 * with the two events added to it, and the rest are the seeded `published`
 * tournament moved along legal edges only. */
function tournamentIn(status: TournamentStatus): {
  tournamentId: string
  singlesId: string
  doublesId: string
} {
  if (status === 'draft') {
    const singles = createEvent(DRAFT_TOURNAMENT, {
      name: 'Novice Singles',
      format: 'singles',
      draw_type: 'single-elim',
      max_players: 16,
      entry_fee: 10,
      slot: { date: '2026-08-22', start: '09:00', end: '12:00' },
      match_settings: { rated: false, length_games: 3 },
    })
    const doubles = createEvent(DRAFT_TOURNAMENT, {
      name: 'Novice Doubles',
      format: 'doubles',
      draw_type: 'single-elim',
      max_players: 16,
      entry_fee: 10,
      slot: { date: '2026-08-23', start: '09:00', end: '12:00' },
      match_settings: { rated: false, length_games: 3 },
    })
    if (!singles.ok || !doubles.ok) throw new Error('setup failed: no events')
    return {
      tournamentId: DRAFT_TOURNAMENT,
      singlesId: singles.event.id,
      doublesId: doubles.event.id,
    }
  }
  // `published` is where the seed already is (so: no steps); `live` and
  // `archived` are one and two legal edges further on.
  const forward: TournamentStatus[] = ['live', 'archived']
  for (const step of forward.slice(0, forward.indexOf(status) + 1)) {
    const moved = transitionTournament(TOURNAMENT, step)
    if (!moved.ok) throw new Error(`setup failed: could not reach ${status}`)
  }
  return {
    tournamentId: TOURNAMENT,
    singlesId: EMPTY_SINGLES,
    doublesId: DOUBLES,
  }
}

/** The event as the store now reads it back — the count included, so a refusal
 * can be shown to have left the roster alone. */
function eventIn(tournamentId: string, eventId: string) {
  const found = findTournament(tournamentId)!.events.find(
    (e) => e.id === eventId,
  )
  if (!found) throw new Error(`no event ${eventId}`)
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
      detail: 'You have already entered this event.',
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
    // Published (so the window is open) but owned by the league office: what is
    // being proved here is that ownership has nothing to do with entering.
    const notMine = findTournament('club-champs-2026')!
    expect(notMine.can_edit).toBe(false)
    expect(notMine.status).toBe('published')

    const result = enterEvent('club-champs-2026', 'ev-cc-open')

    expect(result.ok).toBe(true)
    const found = findTournament('club-champs-2026')!.events.find(
      (e) => e.id === 'ev-cc-open',
    )!
    expect(found.entered).toBe(29)
  })
})

// The registration window (ADR-0017): a tournament's status IS the state of its
// registration, and only `published` is open. The mock must be no more permissive
// than the server here — if it 201'd on a `live` tournament, a regression that
// offered Enter there would pass every vitest test and look fine in `npm run dev`.
describe('enterEvent, against the registration window', () => {
  it.each(CLOSED_STATUSES)(
    "409s an entry on a %s tournament, in the server's words, and adds no entrant",
    (status) => {
      const { tournamentId, singlesId } = tournamentIn(status)

      expectRegistrationClosed(enterEvent(tournamentId, singlesId), status)
      const after = eventIn(tournamentId, singlesId)
      expect(after.entrants).toEqual([])
      expect(after.entered).toBe(0)
    },
  )

  it('still enters on a published tournament — the window is open, not welded shut', () => {
    const { tournamentId, singlesId } = tournamentIn('published')

    expect(enterEvent(tournamentId, singlesId).ok).toBe(true)
    expect(eventIn(tournamentId, singlesId).entered).toBe(1)
  })

  // Ordering, mirrored from the server: the permanent refusal outranks the
  // transient one. A 409 invites the caller back once the tournament is
  // published — but a doubles event will never be enterable in ANY status, so it
  // must be answered with the fact that will not change.
  it.each(CLOSED_STATUSES)(
    'answers a doubles event on a %s tournament with the 400, not the status 409',
    (status) => {
      const { tournamentId, doublesId } = tournamentIn(status)

      expect(enterEvent(tournamentId, doublesId)).toEqual({
        ok: false,
        status: 400,
      })
    },
  )
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

// Withdrawal is gated on the same registration window as entry (ADR-0017) —
// pulling a player out of a `live` tournament would empty a slot the draw was cut
// from — but the gate is on the state CHANGE, not on the call.
describe('withdrawEntry, against the registration window', () => {
  /** Enter the dev user while the window is open, then move the tournament to
   * `status`: an ACTIVE entry sitting in a tournament whose window has shut.
   * (Only `live` and `archived` are reachable — a published tournament cannot go
   * back to `draft`, so an active entry against a draft cannot exist at all.) */
  function activeEntryIn(status: 'live' | 'archived'): string {
    const entered = enterEvent(TOURNAMENT, EMPTY_SINGLES)
    if (!entered.ok) throw new Error('setup failed: could not enter')
    tournamentIn(status)
    return entered.entrant.id
  }

  /** An entry that is ALREADY withdrawn, on a tournament in `status`. A withdrawn
   * entry is one the event no longer carries (this store drops the row; the server
   * tombstones it — the same fact on the wire).
   *
   * For the three statuses a published tournament can reach, the entry is genuinely
   * entered-and-then-withdrawn while the window was open, and the tournament is
   * only then moved on. `draft` is different by construction: entering a draft is
   * refused and there is no edge back to it, so a draft tournament can never HOLD
   * an entry — an entry id against its event is necessarily one the event does not
   * carry, which is exactly what "already withdrawn" is here. */
  function withdrawnEntryIn(status: TournamentStatus): {
    tournamentId: string
    singlesId: string
    entryId: string
  } {
    if (status === 'draft') {
      const { tournamentId, singlesId } = tournamentIn('draft')
      return { tournamentId, singlesId, entryId: 'entry-me-1' }
    }
    const entered = enterEvent(TOURNAMENT, EMPTY_SINGLES)
    if (!entered.ok) throw new Error('setup failed: could not enter')
    const gone = withdrawEntry(TOURNAMENT, EMPTY_SINGLES, entered.entrant.id)
    if (!gone.ok) throw new Error('setup failed: could not withdraw')
    tournamentIn(status) // published: already there; live/archived: forward
    return {
      tournamentId: TOURNAMENT,
      singlesId: EMPTY_SINGLES,
      entryId: entered.entrant.id,
    }
  }

  it.each(['live', 'archived'] as const)(
    "409s the withdrawal of an ACTIVE entry once the tournament is %s, in the server's words",
    (status) => {
      const entryId = activeEntryIn(status)

      expectRegistrationClosed(
        withdrawEntry(TOURNAMENT, EMPTY_SINGLES, entryId),
        status,
      )
      // Still on the roster: the refusal did not half-apply.
      expect(event(EMPTY_SINGLES).entered).toBe(1)
    },
  )

  it('still withdraws on a published tournament — the window is open both ways', () => {
    const entered = enterEvent(TOURNAMENT, EMPTY_SINGLES)
    if (!entered.ok) throw new Error('setup failed')

    expect(
      withdrawEntry(TOURNAMENT, EMPTY_SINGLES, entered.entrant.id),
    ).toEqual({ ok: true })
    expect(event(EMPTY_SINGLES).entered).toBe(0)
  })

  // The invariant a blunt gate breaks. ADR-0016 designed the idempotent 204; a
  // status check placed before the "is this entry still active?" question would
  // quietly convert it into a 409 for a request that changes nothing — a conflict
  // with no conflict in it. An entry that is already withdrawn has nothing left to
  // lock, in ANY status.
  it.each(STATUSES)(
    '204s an already-withdrawn entry on a %s tournament — the gate is on the state change, not the call',
    (status) => {
      const { tournamentId, singlesId, entryId } = withdrawnEntryIn(status)

      expect(withdrawEntry(tournamentId, singlesId, entryId)).toEqual({
        ok: true,
      })
      expect(eventIn(tournamentId, singlesId).entered).toBe(0)
    },
  )

  it('403s someone else’s entry BEFORE the status 409 — "not yours" is the fact that will not change', () => {
    const theirs = event(FULLISH_SINGLES).entrants[0]
    tournamentIn('live')

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
  const NOT_MINE = 'club-champs-2026' // seeded `published`, can_edit: false

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
      // is part of the contract. Two shapes: the self-transition is told what
      // happened, every other illegal edge names both ends.
      detail:
        from === to
          ? `This tournament is already ${to}.`
          : `This tournament is ${from}; it cannot be moved to ${to}.`,
    })
    expect(findTournament(id)!.status).toBe(from)
  })

  // The self-transition sentence, pinned on its own rather than only through the
  // table above — it is the copy a stale tab actually reads, and the tautology it
  // replaced ("this tournament is live; it cannot be moved to live") told that tab
  // nothing. `it.each` over the table would happily go green against either shape
  // if the ternary above were dropped on both sides.
  it.each(STATUSES)('tells a stale tab that %s is already the status', (s) => {
    const id = at(s)

    expect(transitionTournament(id, s)).toEqual({
      ok: false,
      status: 409,
      detail: `This tournament is already ${s}.`,
    })
  })

  // `published → archived` is an illegal edge too, so this also pins the ordering:
  // not-yours is answered before the edge is judged.
  it('403s a tournament the caller does not own, whatever the edge', () => {
    expect(transitionTournament(NOT_MINE, 'archived')).toEqual({
      ok: false,
      status: 403,
    })
    expect(findTournament(NOT_MINE)!.status).toBe('published')
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

// Visibility (#967): a draft is owner-only. The store holds a foreign draft — the
// database really does — and the two READS are what keep it off the wire, so these
// are the tests that make the predicate real. Without them (and without that seeded
// row) the filter is dead code that could be deleted and stay green.
describe('draft visibility', () => {
  const FOREIGN_DRAFT = 'league-office-draft-2027' // seeded `draft`, u-office
  const FOREIGN_PUBLISHED = 'club-champs-2026' // seeded `published`, u-office
  const OWN_DRAFT = 'summer-slam-2026' // seeded `draft`, the dev user's

  it("omits another organiser's draft from the list", () => {
    const ids = listTournaments().map((t) => t.id)

    expect(ids).not.toContain(FOREIGN_DRAFT)
  })

  // The row IS in the store — so the assertion above is about the predicate, not
  // about an absent fixture. A `not.toContain` against a row that was never seeded
  // would pass for the wrong reason, and would keep passing if the filter were
  // deleted; this is what stops that.
  //
  // The proof runs through a WRITE, because the reads (rightly) cannot see it: the
  // transitions route has no visibility predicate on the server either, so it loads
  // the row and refuses it as **not yours** (403). A tournament that did not exist
  // would be a 404. Same call, two different refusals — the row is there.
  it('holds the hidden draft: a write against it is 403 (not yours), not 404', () => {
    expect(transitionTournament(FOREIGN_DRAFT, 'published')).toEqual({
      ok: false,
      status: 403,
    })
    expect(transitionTournament('no-such-tournament-at-all', 'published')).toEqual(
      { ok: false, status: 404 },
    )
  })

  // A 404, NOT a 403 — the whole point. `findTournament` returning `undefined` is
  // what the handler turns into "Tournament not found.", the same answer a
  // nonexistent id gets, so a stranger cannot tell a hidden draft from one that was
  // never created. A 403 would confirm the tournament exists.
  it("answers a GET of another organiser's draft as if it did not exist", () => {
    expect(findTournament(FOREIGN_DRAFT)).toBeUndefined()
    expect(findTournament('no-such-tournament-at-all')).toBeUndefined()
  })

  // The other half of the predicate, and the half a `status !== 'draft'` filter or a
  // blanket "hide what I can't edit" would break: MY draft is still mine to see.
  it('still lists and serves the dev user’s OWN draft', () => {
    expect(listTournaments().map((t) => t.id)).toContain(OWN_DRAFT)
    expect(findTournament(OWN_DRAFT)!.status).toBe('draft')
  })

  it("still serves another organiser's ANNOUNCED tournament, read-only", () => {
    expect(listTournaments().map((t) => t.id)).toContain(FOREIGN_PUBLISHED)
    expect(findTournament(FOREIGN_PUBLISHED)!.can_edit).toBe(false)
  })

  // Announced is an allow-list, so a foreign tournament becomes visible the moment
  // it is announced — and every announced status is visible, not just `published`.
  // (Driven through the seeded foreign row's OWNER-side twin: the store has no
  // foreign transition, so this walks the dev user's own draft forward and checks
  // the predicate admits each status it reaches.)
  it.each(['published', 'live', 'archived'] as const)(
    'treats %s as announced',
    (status) => {
      const path: TournamentStatus[] = ['published', 'live', 'archived']
      for (const step of path.slice(0, path.indexOf(status) + 1)) {
        const moved = transitionTournament(OWN_DRAFT, step)
        if (!moved.ok) throw new Error(`setup failed: could not reach ${status}`)
      }

      expect(findTournament(OWN_DRAFT)!.status).toBe(status)
      expect(listTournaments().map((t) => t.id)).toContain(OWN_DRAFT)
    },
  )
})
