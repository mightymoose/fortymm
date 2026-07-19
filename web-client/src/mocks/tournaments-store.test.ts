// The dev store models entries the way the server does (ADR-0016): the `entered`
// count is DERIVED from the active entrants, so the two can never disagree, and
// withdrawing frees the player to enter again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildFixtureTimeRead } from '@/mocks/factories/tournaments/tournament.factory'
import {
  createEvent,
  createTournament,
  cutDraw,
  enterEvent,
  findTournament,
  listTournaments,
  markFixturePlayed,
  placeInStatus,
  requestScheduleSolve,
  resetTournamentsStore,
  transitionTournament,
  uncutDraw,
  updateEvent,
  updateTournament,
  withdrawEntry,
  type EnterResult,
  type TransitionResult,
  type WithdrawResult,
} from './tournaments-store'
import type { components } from '@/api/schema'

type TournamentStatus = components['schemas']['TournamentStatus']

const TOURNAMENT = 'bay-area-open-2026' // seeded `published`, owned
const DRAFT_TOURNAMENT = 'summer-slam-2026' // seeded `draft`, owned, one drawn event
const EMPTY_SINGLES = 'ev-u1500' // seeded with no entrants
const FULLISH_SINGLES = 'ev-open-singles' // seeded with 52 other players, cap 64
const FULL_SINGLES = 'ev-champ-singles' // seeded 16 of 16 — no room (#783)
const INELIGIBLE_SINGLES = 'ev-u1200' // rating < 1200; the dev user is 1650 (#783)
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

/** A window of time, for the pool literals the draw cases patch events with. Nothing
 * about a draw turns on *when* a pool plays — only on which pools there are — so one
 * slot serves them all. */
const SLOT = { date: '2026-06-14', start: '09:00', end: '12:00' }

const STATUSES: TournamentStatus[] = ['draft', 'published', 'live', 'archived']
const CLOSED_STATUSES = ['draft', 'live', 'archived'] as const

/** The sentence a 409 carries, from either shape: entering answers with a CODED
 * refusal (`{code, message}` — ADR-0968), withdrawing still answers with prose,
 * because the ADR converted the entry endpoint and left the withdraw route alone. */
function refusalMessage(result: EnterResult | WithdrawResult): string {
  if (result.ok || result.status !== 409) {
    throw new Error(`expected a 409, got ${JSON.stringify(result)}`)
  }
  return 'refusal' in result ? result.refusal.message : result.detail
}

/** Assert a refusal is the registration-window 409, and that it says WHY in the
 * words the server uses for that status. */
function expectRegistrationClosed(
  result: EnterResult | WithdrawResult,
  status: Exclude<TournamentStatus, 'published'>,
) {
  expect(refusalMessage(result)).toContain(CLOSED_PHRASE[status])
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
 * `draft`: the draft case is the seeded draft with the two events added to it, and
 * the rest are the seeded `published` tournament PUT in that status.
 *
 * `placeInStatus`, not a walk through the transitions, since #786 gave `published →
 * live` a precondition (every event drawn, every draw current — ADR-0786). These are
 * tests of ENTRY, and the tournament they need is one that IS live; walking there would
 * make every one of them depend on the draws of the five seeded events, and the two
 * events these tests then add would have no draw at all and could not be walked past.
 * That precondition has tests of its own, below, where a real walk is the point. */
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
      timezone: 'America/Chicago',
      slot: { date: '2026-08-22', start: '09:00', end: '12:00' },
      match_settings: { rated: false, length_games: 3 },
    })
    const doubles = createEvent(DRAFT_TOURNAMENT, {
      name: 'Novice Doubles',
      format: 'doubles',
      draw_type: 'single-elim',
      max_players: 16,
      entry_fee: 10,
      timezone: 'America/Chicago',
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
  // `published` is where the seed already is; `live` and `archived` are seeded states
  // here, not journeys (see the note above).
  placeInStatus(TOURNAMENT, status)
  if (findTournament(TOURNAMENT)!.status !== status) {
    throw new Error(`setup failed: could not reach ${status}`)
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

  // `entry_state` (ADR-0783) is derived on read for the same reason `entered` is:
  // a tag stored at seed time could say `open` while the roster stood at
  // `max_players`, and the card — which renders exactly what this says — would go
  // on offering an Enter the server can only 409.
  it('derives the capacity arm of entry_state from the entrants', () => {
    expect(event(FULL_SINGLES).entrants).toHaveLength(16)
    expect(event(FULL_SINGLES).entry_state).toEqual({ state: 'event_full' })
    expect(event(FULLISH_SINGLES).entry_state).toEqual({ state: 'open' })
  })

  // Rating-ineligibility is NOT derivable from an event — it is a judgement about a
  // player's rating on the tournament's ladder — so the seed states it, and the read
  // names the rule that refused (a predicate on this same event) plus the rating.
  it('states rating-ineligibility, pointing at a rule the event actually carries', () => {
    const ineligible = event(INELIGIBLE_SINGLES)

    expect(ineligible.entry_state).toEqual({
      state: 'rating_ineligible',
      predicate_id: 'pr-u1200',
      rating: 1650,
    })
    expect(ineligible.predicates.map((p) => p.id)).toContain('pr-u1200')
  })
})

// #783: the two refusals the EVENT itself makes. A mock that 201'd them would be
// more permissive than the server, and a UI that kept offering Enter on a full
// event would look perfect in `npm run dev`.
describe('enterEvent, against the event itself', () => {
  it('409s a FULL event with the event_full code, and adds no entrant', () => {
    expect(enterEvent(TOURNAMENT, FULL_SINGLES)).toEqual({
      ok: false,
      status: 409,
      refusal: { code: 'event_full', message: 'This event is full.' },
    })
    expect(event(FULL_SINGLES).entered).toBe(16)
  })

  it('409s a rating-INELIGIBLE event with the rating_ineligible code', () => {
    const result = enterEvent(TOURNAMENT, INELIGIBLE_SINGLES)

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      refusal: { code: 'rating_ineligible' },
    })
  })

  // Eligibility BEFORE capacity, the server's precedence (ADR-0783): telling an
  // ineligible player an event is full invites them back for a place that will
  // never be theirs.
  it('entering the last free place makes the very next read say event_full', () => {
    const nearlyFull = createEvent(TOURNAMENT, {
      name: 'Two-seater',
      format: 'singles',
      draw_type: 'single-elim',
      max_players: 1,
      entry_fee: 0,
      timezone: 'America/Chicago',
      slot: { date: '2026-06-14', start: '09:00', end: '10:00' },
      match_settings: { rated: true, length_games: 3 },
    })
    if (!nearlyFull.ok) throw new Error('setup failed: no event')
    expect(nearlyFull.event.entry_state).toEqual({ state: 'open' })

    expect(enterEvent(TOURNAMENT, nearlyFull.event.id).ok).toBe(true)

    expect(event(nearlyFull.event.id).entry_state).toEqual({ state: 'event_full' })
  })

  // The duplicate guard is asked FIRST, so a player already inside a full event is
  // told "you are already in" — never "it is full", which is true and useless, and
  // which the UI would render as a notice where their Withdraw button belongs.
  it('tells a player already in a full event that they are already in', () => {
    const filling = createEvent(TOURNAMENT, {
      name: 'One-seater',
      format: 'singles',
      draw_type: 'single-elim',
      max_players: 1,
      entry_fee: 0,
      timezone: 'America/Chicago',
      slot: { date: '2026-06-14', start: '09:00', end: '10:00' },
      match_settings: { rated: true, length_games: 3 },
    })
    if (!filling.ok) throw new Error('setup failed: no event')
    enterEvent(TOURNAMENT, filling.event.id)

    expect(enterEvent(TOURNAMENT, filling.event.id)).toMatchObject({
      refusal: { code: 'already_entered' },
    })
  })

  // …and they can still LEAVE it. The trap #783 sets: capacity must never outrank
  // membership, or a full event locks in everybody already inside it.
  it('lets a player WITHDRAW from an event that is full', () => {
    const entered = enterEvent(TOURNAMENT, INELIGIBLE_SINGLES)
    // (Not through the front door — that is refused. The director's seed is how a
    // player ends up inside an event that would now refuse them.)
    expect(entered.ok).toBe(false)

    const full = createEvent(TOURNAMENT, {
      name: 'One-seater',
      format: 'singles',
      draw_type: 'single-elim',
      max_players: 1,
      entry_fee: 0,
      timezone: 'America/Chicago',
      slot: { date: '2026-06-14', start: '09:00', end: '10:00' },
      match_settings: { rated: true, length_games: 3 },
    })
    if (!full.ok) throw new Error('setup failed: no event')
    const mine = enterEvent(TOURNAMENT, full.event.id)
    if (!mine.ok) throw new Error('setup failed: not entered')
    expect(event(full.event.id).entry_state).toEqual({ state: 'event_full' })

    expect(withdrawEntry(TOURNAMENT, full.event.id, mine.entrant.id)).toEqual({
      ok: true,
    })
    // …and the place it freed is open again.
    expect(event(full.event.id).entry_state).toEqual({ state: 'open' })
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

    // The CODE is the contract the client reads (ADR-0968); the message rides
    // along for a client that does not know the code.
    expect(enterEvent(TOURNAMENT, EMPTY_SINGLES)).toEqual({
      ok: false,
      status: 409,
      refusal: {
        code: 'already_entered',
        message: 'You have already entered this event.',
      },
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

      const result = enterEvent(tournamentId, singlesId)

      // One code for all three closed statuses — what the client switches on is
      // *why* it was refused, not *how it was worded* (ADR-0968) — and the words
      // still differ, because "not yet" and "too late" are different news to a
      // client that has to fall back on them.
      expect(result).toMatchObject({
        status: 409,
        refusal: { code: 'registration_closed' },
      })
      expectRegistrationClosed(result, status)
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
      timezone: 'America/Chicago',
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

  // ADR-0935: a null cap is "no cap". Create stores it as null; an omitted cap
  // is also "no cap" (null), never `undefined`.
  it('creates an uncapped event (null max_players)', () => {
    const result = createEvent(TOURNAMENT, {
      name: 'Uncapped Singles',
      format: 'singles',
      draw_type: 'single-elim',
      max_players: null,
      entry_fee: 0,
      timezone: 'America/Chicago',
      slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
      match_settings: { rated: false, length_games: 3 },
    })
    if (!result.ok) throw new Error('create failed')
    expect(result.event.max_players).toBeNull()
  })

  // An explicit null clears the cap; `??` would have kept the old value. This is
  // the store half of the no-cap round-trip.
  it('clears the cap when a PATCH sends max_players: null', () => {
    const result = updateEvent(TOURNAMENT, EMPTY_SINGLES, { max_players: null })
    if (!result.ok) throw new Error('update failed')
    expect(result.event.max_players).toBeNull()
  })
})

// The lifecycle (ADR-0017). The store enforces the SERVER's edge table, not a
// looser one: a mock that permitted an illegal edge would let a broken UI look
// fine in dev and in vitest, which is the entire point of mirroring it.
describe('transitionTournament', () => {
  const DRAFT = 'summer-slam-2026' // seeded `draft`, owned
  const PUBLISHED = 'bay-area-open-2026' // seeded `published`, owned
  const NOT_MINE = 'club-champs-2026' // seeded `published`, can_edit: false
  /** `DRAFT`'s only event: round-robin, 8 entrants, a draw already cut across its two
   * pools — i.e. the one seeded event whose draw is CURRENT, which is what makes that
   * tournament the only one in the seed that can go live at all. */
  const SLAM_EVENT = 'ev-slam-open'

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

  // ----- the go-live precondition (ADR-0786) --------------------------------
  //
  // The store must not be more permissive than the server here, or the UI could be
  // built — and go green in vitest and in `npm run dev` — against a Start button that
  // works on a tournament the API would refuse. Each case below is one of the three
  // things `_enforce_ready_to_go_live` refuses, and the sentence is pinned because the
  // client shows the sentence.

  /** The 409's sentence, or a failed assertion — so the cases below read `detail`
   * without a cast, and a refusal that is *not* the 409 (a 403, a 404) fails loudly
   * instead of quietly skipping every assertion after it. */
  function refusalDetail(result: TransitionResult): string {
    if (result.ok || result.status !== 409) {
      throw new Error(`expected a 409, got ${JSON.stringify(result)}`)
    }
    return result.detail
  }

  /** A brand-new, empty tournament, published — i.e. announced, with nothing in it. */
  function announcedEmptyTournament(): string {
    const created = createTournament({
      name: 'Announced, Empty',
      description: null,
      start_date: '2026-09-01',
      end_date: '2026-09-02',
      address: {
        venue: 'TBC',
        street: '',
        city: 'Oakland',
        region: 'CA',
        postal: '',
        country: 'USA',
      },
      table_catalogue: [],
    })
    const published = transitionTournament(created.id, 'published')
    if (!published.ok) throw new Error('setup failed: could not publish')
    return created.id
  }

  it('PUBLISHES an empty tournament — announcing one early is fine', () => {
    // The positive control for the refusal below: it is *starting* an empty tournament
    // that is refused, not announcing it. A guard that failed here would be the one that
    // stopped a director putting a date up before writing the events.
    const id = announcedEmptyTournament()

    expect(findTournament(id)!.status).toBe('published')
  })

  it('refuses to START an empty tournament — there is nothing to run', () => {
    const id = announcedEmptyTournament()

    expect(transitionTournament(id, 'live')).toEqual({
      ok: false,
      status: 409,
      detail:
        'This tournament has no events, so there is nothing to start. Add an event ' +
        'and cut its draw, then start the tournament.',
    })
    expect(findTournament(id)!.status).toBe('published')
  })

  it('refuses to start when events have NO DRAW, and names them', () => {
    // The seeded published tournament: five events, only `ev-u1200` drawn.
    const detail = refusalDetail(transitionTournament(PUBLISHED, 'live'))

    // The NAMES are the point — a director with five events, told merely "something
    // isn't ready", is left clicking through all five.
    expect(detail).toContain('“Open Singles”')
    expect(detail).toContain('“U1500 Singles”')
    expect(detail).toContain('have no draw yet')
    // …and the one event that IS drawn is not blamed.
    expect(detail).not.toContain('“U1200 Singles”')
    expect(findTournament(PUBLISHED)!.status).toBe('published')
  })

  it('STARTS a tournament whose every event has a current draw', () => {
    // The happy path of the precondition, and the reason the seed holds a drawn,
    // startable tournament at all: without this, every assertion above would be equally
    // satisfied by a store that simply refused to start anything.
    const id = at('published') // the seeded draft, published — its one event is drawn

    const result = transitionTournament(id, 'live')

    expect(result.ok).toBe(true)
    expect(findTournament(id)!.status).toBe('live')
  })

  it('MATERIALIZES every ready fixture into an in_progress match at go-live (#788)', () => {
    // Go-live is the act that turns a draw's planned pairings into real, playable
    // matches: after it, every ready fixture (both sides known) carries a match id and a
    // live status, which is what gives the draw panel its "View match" links. Before it,
    // the same fixtures are inert — `match_id` null.
    const id = at('published')
    const before = findTournament(id)!.events.flatMap((e) => e.fixtures)
    expect(before.length).toBeGreaterThan(0)
    expect(before.every((f) => f.match_id === null)).toBe(true)

    const result = transitionTournament(id, 'live')
    expect(result.ok).toBe(true)

    const after = findTournament(id)!.events.flatMap((e) => e.fixtures)
    // A round-robin draw has both sides known on every fixture, so every one is ready.
    for (const fixture of after) {
      expect(fixture.match_id).not.toBeNull()
      expect(fixture.match_status).toBe('in_progress')
    }
  })

  it('refuses to start on a STALE draw — somebody entered after it was cut', () => {
    // Registration stays open right up to go-live, which is exactly how a draw goes
    // stale: the field the fixtures were dealt from is not the field that would play.
    const id = at('published')
    const entered = enterEvent(id, 'ev-slam-open')
    if (!entered.ok) throw new Error('setup failed: could not enter')

    const detail = refusalDetail(transitionTournament(id, 'live'))

    expect(detail).toContain('“Slam Open Singles”')
    expect(detail).toContain('has a draw that no longer matches its entrants')
    // A stale draw is not an uncut one: the director is told their draw needs
    // RE-cutting, not that they never cut it.
    expect(detail).not.toContain('no draw yet')
    expect(findTournament(id)!.status).toBe('published')
  })

  // ⚠️ THE case that pins `drawCurrency` as a **set** comparison rather than a count.
  //
  // The test above adds an entrant, so the field grows: 8 seated, 9 active. A currency
  // check written as `active.length === seated.size` refuses that one too — and passes
  // every other test in this file. (Measured, not theorised: mutating the store's
  // comparison to a count left all 2464 vitest tests green.) The case that tells the two
  // apart is a **swap**, and it is the one that actually loses a director their morning:
  // the field is the same SIZE and is not the same field, so a count-based check calls
  // the draw current, the tournament starts, and a player who withdrew is scheduled to
  // play while their replacement is scheduled nowhere.
  //
  // The unit of the comparison is the ENTRY, not the player: the server soft-deletes a
  // withdrawn entry and INSERTs a fresh row when someone re-enters (the partial unique
  // index — and the store mints a new entry id for the same reason). So "I withdrew and
  // came back" is, on the wire, exactly what "player A left and player B took the place"
  // is — one seated id the event no longer lists, one listed id the draw does not seat —
  // and it is the only swap this store's own routes can make, since the dev user is the
  // only person who can enter or withdraw here.
  it('refuses to start on a SWAPPED field — the same NUMBER of entrants, different entries', () => {
    const id = at('published')
    const first = enterEvent(id, SLAM_EVENT)
    if (!first.ok) throw new Error('setup failed: could not enter')
    // The draw is cut over the field as it stands: 9 entrants, `first.entrant` among them.
    if (!cutDraw(id, SLAM_EVENT).ok) throw new Error('setup failed: could not cut')

    // …and then the swap: that entry leaves, and another arrives in its place.
    const out = withdrawEntry(id, SLAM_EVENT, first.entrant.id)
    if (!out.ok) throw new Error('setup failed: could not withdraw')
    const second = enterEvent(id, SLAM_EVENT)
    if (!second.ok) throw new Error('setup failed: could not re-enter')
    // A re-entry is a NEW entry, never the resurrection of the withdrawn one — which is
    // what makes this a swap at all.
    expect(second.entrant.id).not.toBe(first.entrant.id)

    // The discriminator itself, asserted rather than assumed: the counts AGREE. Without
    // this line the test could quietly drift into being another "somebody entered" case
    // — and would then go green against the very mutation it exists to kill.
    const event = findTournament(id)!.events.find((e) => e.id === SLAM_EVENT)!
    const seated = new Set(
      event.fixtures.flatMap((f) =>
        [f.entry_a_id, f.entry_b_id].filter((x): x is string => x !== null),
      ),
    )
    expect(event.entrants).toHaveLength(seated.size)
    // …and the SETS do not: the draw seats an entry the event no longer lists, and the
    // event lists an entry the draw seats nowhere.
    expect(seated.has(first.entrant.id)).toBe(true)
    expect(seated.has(second.entrant.id)).toBe(false)

    const detail = refusalDetail(transitionTournament(id, 'live'))

    expect(detail).toContain('“Slam Open Singles”')
    expect(detail).toContain('has a draw that no longer matches its entrants')
    expect(findTournament(id)!.status).toBe('published')
  })

  it('starts again once the stale draw is RE-CUT', () => {
    // The way out, end to end — and the proof that the refusal above is about the draw's
    // currency and not about the entrant simply existing.
    const id = at('published')
    enterEvent(id, 'ev-slam-open')
    expect(transitionTournament(id, 'live').ok).toBe(false)

    const recut = cutDraw(id, 'ev-slam-open')
    if (!recut.ok) throw new Error('setup failed: could not re-cut')

    expect(transitionTournament(id, 'live').ok).toBe(true)
    expect(findTournament(id)!.status).toBe('live')
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

  const listedIds = () => listTournaments().map((t) => t.id)

  it("omits another organiser's draft from the list", () => {
    expect(listedIds()).not.toContain(FOREIGN_DRAFT)
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
    expect(listedIds()).toContain(OWN_DRAFT)
    expect(findTournament(OWN_DRAFT)!.status).toBe('draft')
  })

  // The only row on which the ANNOUNCED allow-list is load-bearing is a row the dev
  // user does NOT own — on an owned one the ownership clause short-circuits true in
  // every status, so a sweep over the dev user's own tournament would go green even
  // if the allow-list were all-false. This is that row, and the allow-list's
  // per-status behaviour is pinned properly on the API side.
  it("still serves another organiser's ANNOUNCED tournament, read-only", () => {
    expect(listedIds()).toContain(FOREIGN_PUBLISHED)
    expect(findTournament(FOREIGN_PUBLISHED)!.can_edit).toBe(false)
  })
})

// The draw (ADR-0786). A mock that were more permissive than the server it stands in
// for would be a trap: a Generate button that "worked" in `npm run dev` and 422'd in
// production would look like a server bug rather than the missing generator it is. So
// each refusal below is one the API really makes, in the API's own order.
describe('cutting and un-cutting a draw', () => {
  beforeEach(() => resetTournamentsStore())

  const FOREIGN = 'club-champs-2026' // `u-office`'s, published: readable, not writable
  const FOREIGN_EVENT = 'ev-cc-open'
  /** Round-robin, two pools, nine entrants — the seed's one cuttable (and pre-cut)
   * event, because round-robin is the only draw type with a generator today. */
  const ROUND_ROBIN = 'ev-u1200'

  const eventOf = (tournamentId: string, eventId: string) =>
    findTournament(tournamentId)!.events.find((e) => e.id === eventId)!

  const poolNamed = (id: string) => ({
    id,
    name: id,
    slot: SLOT,
    table_ids: [],
  })

  it('seeds the round-robin event ALREADY DRAWN, and every other event with no draw', () => {
    const drawn = eventOf(TOURNAMENT, ROUND_ROBIN)
    // 9 entrants snaked across 2 pools → pools of 5 and 4 → C(5,2) + C(4,2) = 16 pairs.
    expect(drawn.fixtures).toHaveLength(16)
    for (const other of findTournament(TOURNAMENT)!.events.filter(
      (e) => e.id !== ROUND_ROBIN,
    )) {
      // `[]`, not null: an event with no draw is EMPTY, and empty is a state.
      expect(other.fixtures).toEqual([])
    }
  })

  it('cuts every pair exactly once, inside a pool, and nobody twice in a round', () => {
    expect(uncutDraw(TOURNAMENT, ROUND_ROBIN).ok).toBe(true)
    const result = cutDraw(TOURNAMENT, ROUND_ROBIN)
    if (!result.ok) throw new Error(`expected a cut, got ${result.status}`)

    const pools = eventOf(TOURNAMENT, ROUND_ROBIN).pools.map((p) => p.id)
    // Every fixture names one of THIS event's pools — a `pool_id` is a string ref into
    // that JSONB, not a foreign key, so a draw pointing at a pool the event does not
    // have is a draw nothing can render.
    expect(new Set(result.fixtures.map((f) => f.pool_id))).toEqual(new Set(pools))

    // Every pair meets exactly once…
    const pairs = result.fixtures.map((f) =>
      [f.entry_a_id, f.entry_b_id].sort().join('|'),
    )
    expect(new Set(pairs).size).toBe(pairs.length)

    // …and nobody plays twice in the same (pool, round): the circle method's whole
    // promise, and the thing a naive "pair them up" planner gets wrong.
    for (const fixture of result.fixtures) {
      const sameRound = result.fixtures.filter(
        (f) => f.pool_id === fixture.pool_id && f.round === fixture.round,
      )
      const players = sameRound.flatMap((f) => [f.entry_a_id, f.entry_b_id])
      expect(new Set(players).size).toBe(players.length)
    }
  })

  it('re-cuts an unplayed draw deterministically — the same field cuts the same draw', () => {
    const before = eventOf(TOURNAMENT, ROUND_ROBIN).fixtures

    const again = cutDraw(TOURNAMENT, ROUND_ROBIN)

    if (!again.ok) throw new Error('a re-cut of an unplayed draw must be allowed')
    // Nothing is random (ADR-0786) — entrants are ordered by seed, then registration
    // order — which is what makes a re-cut a reviewable act rather than a gamble.
    expect(again.fixtures).toEqual(before)
  })

  it('re-cuts WHOLESALE against the event as it stands now — new pools, new draw', () => {
    // The plan is made against the CURRENT config, never patched onto the old one. Two
    // pools of 5 + 4 (16 pairs) become one pool of 9 (36 pairs) — and the fixtures that
    // referred to the old pools are gone, not re-pointed.
    expect(uncutDraw(TOURNAMENT, ROUND_ROBIN).ok).toBe(true) // the freeze lifts first
    updateEvent(TOURNAMENT, ROUND_ROBIN, { pools: [poolNamed('p-single')] })

    const result = cutDraw(TOURNAMENT, ROUND_ROBIN)

    if (!result.ok) throw new Error(`expected a cut, got ${result.status}`)
    expect(result.fixtures).toHaveLength(36) // C(9,2)
    expect(new Set(result.fixtures.map((f) => f.pool_id))).toEqual(
      new Set(['p-single']),
    )
  })

  it('un-cutting empties the draw; un-cutting again is still a success (idempotent DELETE)', () => {
    expect(uncutDraw(TOURNAMENT, ROUND_ROBIN)).toEqual({ ok: true })
    expect(eventOf(TOURNAMENT, ROUND_ROBIN).fixtures).toEqual([])
    // An event with no draw is already in the state this asks for.
    expect(uncutDraw(TOURNAMENT, ROUND_ROBIN)).toEqual({ ok: true })
    expect(uncutDraw(TOURNAMENT, EMPTY_SINGLES)).toEqual({ ok: true })
  })

  // The 422s — the refusals a director actually meets, each naming what they must change.
  it('refuses a draw type with no generator yet (only round-robin has one)', () => {
    const result = cutDraw(TOURNAMENT, FULL_SINGLES) // `single-elim`, 16 entrants
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(422)
    expect(result.status === 422 && result.detail).toContain('single-elim')
  })

  it('refuses a pooled draw with NO pools — there is nowhere to deal the field', () => {
    // `ev-open-singles` is `rr-then-ko`, so make it the one type that CAN be cut and
    // leave its pools empty: the refusal must be about the pools, not the type.
    updateEvent(TOURNAMENT, FULLISH_SINGLES, { draw_type: 'round-robin', pools: [] })

    const result = cutDraw(TOURNAMENT, FULLISH_SINGLES)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(422)
    expect(result.status === 422 && result.detail).toContain('at least one pool')
  })

  it('refuses a field too small for its pools — a pool of one has nobody to play', () => {
    // Three pools, three entrants… would be three pools of one. The server refuses it,
    // so the mock must: a pool of one is not a competition.
    updateEvent(TOURNAMENT, EMPTY_SINGLES, {
      draw_type: 'round-robin',
      pools: [poolNamed('p-1'), poolNamed('p-2'), poolNamed('p-3')],
    })
    enterEvent(TOURNAMENT, EMPTY_SINGLES) // one entrant: the dev user

    const result = cutDraw(TOURNAMENT, EMPTY_SINGLES)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(422)
    expect(result.status === 422 && result.detail).toContain('fewer than 2 entrants')
  })

  // The play guard — the ONE reason a cut or an un-cut is refused, and it is not the
  // tournament's status (ADR-0786 rejected status-gating: it would forbid the legitimate
  // day-of re-cut while protecting nothing).
  it.each([
    { evidence: 'a recorded winner', played: { winner_entry_id: 'entry-ev-u1200-1' } },
    { evidence: 'a linked match', played: { match_id: 'm-1' } },
  ])('refuses both verbs once a fixture shows $evidence — and destroys nothing', ({
    played,
  }) => {
    const fixtures = eventOf(TOURNAMENT, ROUND_ROBIN).fixtures
    markFixturePlayed(TOURNAMENT, ROUND_ROBIN, fixtures[0].id, played)

    const recut = cutDraw(TOURNAMENT, ROUND_ROBIN)
    expect(recut.ok).toBe(false)
    if (!recut.ok) expect(recut.status).toBe(409)

    const removed = uncutDraw(TOURNAMENT, ROUND_ROBIN)
    expect(removed.ok).toBe(false)
    if (!removed.ok) expect(removed.status).toBe(409)

    // The standing draw survives a refusal — the guard's whole promise. A re-cut that
    // deleted first and refused second would have eaten the very score it was protecting.
    const after = eventOf(TOURNAMENT, ROUND_ROBIN).fixtures
    expect(after).toHaveLength(fixtures.length)
    expect(after[0]).toMatchObject(played)
  })

  // 404 → 403 → 409, the API's ordering: a stranger never learns whether an event's draw
  // has been played, because ownership is judged before the draw's state is looked at.
  it("refuses a stranger's cut with a 403, and an unknown event with a 404", () => {
    expect(cutDraw(FOREIGN, FOREIGN_EVENT)).toEqual({ ok: false, status: 403 })
    expect(uncutDraw(FOREIGN, FOREIGN_EVENT)).toEqual({ ok: false, status: 403 })
    expect(cutDraw(TOURNAMENT, 'ev-nope')).toEqual({ ok: false, status: 404 })
    expect(uncutDraw('no-such-tournament', 'ev-nope')).toEqual({
      ok: false,
      status: 404,
    })
  })
})

// The pool-set FREEZE (ADR-0786): while a draw exists, an event's pools may change in
// every way except identity. A fixture's `pool_id` is a string ref into this very JSONB
// and there is no foreign key to stop a PATCH from orphaning it — "integrity is
// procedural, not schematic" — so the procedure is here, in the mock, for the same
// reason it is on the server.
describe('the pool set freezes while a draw exists', () => {
  beforeEach(() => resetTournamentsStore())

  const ROUND_ROBIN = 'ev-u1200'
  const poolsOf = (eventId: string) =>
    findTournament(TOURNAMENT)!.events.find((e) => e.id === eventId)!.pools

  it('refuses a PATCH that removes a pool the draw was dealt across', () => {
    const [poolA] = poolsOf(ROUND_ROBIN)

    const result = updateEvent(TOURNAMENT, ROUND_ROBIN, { pools: [poolA] })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    // The sentence ends with the way OUT — remove the draw, change the pools, cut again
    // — because a refusal a director cannot act on is just a wall.
    expect(result.status === 409 && result.detail).toContain('remove the draw first')
    // …and the pools are untouched: a refused write writes nothing.
    expect(poolsOf(ROUND_ROBIN)).toHaveLength(2)
  })

  it('refuses a PATCH that ADDS a pool — an added pool would arrive with no fixtures', () => {
    const pools = poolsOf(ROUND_ROBIN)

    const result = updateEvent(TOURNAMENT, ROUND_ROBIN, {
      pools: [...pools, { id: 'p-new', name: 'Pool C', slot: SLOT, table_ids: [] }],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
  })

  // Only IDENTITY is frozen. A pool's tables and its window stay editable with a draw
  // standing, on purpose: venues change under running tournaments (a table breaks, a
  // table frees up), and a director who cannot record that would have to un-cut a draw
  // that is *correct*.
  it('ALLOWS a venue edit — same pool ids, new tables and a new window', () => {
    const pools = poolsOf(ROUND_ROBIN)

    const result = updateEvent(TOURNAMENT, ROUND_ROBIN, {
      pools: pools.map((p) => ({
        ...p,
        name: `${p.name} (moved)`,
        table_ids: ['t9'],
        slot: SLOT,
      })),
    })

    expect(result.ok).toBe(true)
    expect(poolsOf(ROUND_ROBIN)[0].table_ids).toEqual(['t9'])
  })

  it('leaves an UNDRAWN event’s pools wholesale-replaceable, as they have always been', () => {
    const result = updateEvent(TOURNAMENT, EMPTY_SINGLES, {
      pools: [{ id: 'p-anything', name: 'A', slot: SLOT, table_ids: [] }],
    })

    expect(result.ok).toBe(true)
  })

  it('un-freezes the moment the draw is removed', () => {
    expect(uncutDraw(TOURNAMENT, ROUND_ROBIN).ok).toBe(true)

    const result = updateEvent(TOURNAMENT, ROUND_ROBIN, {
      pools: [{ id: 'p-fresh', name: 'Pool A', slot: SLOT, table_ids: [] }],
    })

    expect(result.ok).toBe(true)
    expect(poolsOf(ROUND_ROBIN).map((p) => p.id)).toEqual(['p-fresh'])
  })
})

// The pool-set freeze's SIBLING (ADR-0786): the other fact a cut draw froze. The mock
// enforces it for the same reason it enforces the pool set — a mock more permissive than
// the server it stands in for is a trap, and the UI built against it would look perfect
// in `npm run dev` and 409 in production.
describe('the draw type freezes while a draw exists', () => {
  beforeEach(() => resetTournamentsStore())

  const ROUND_ROBIN = 'ev-u1200'
  const eventOf = (eventId: string) =>
    findTournament(TOURNAMENT)!.events.find((e) => e.id === eventId)!

  it('refuses a PATCH that re-labels the draw type of a cut draw', () => {
    const result = updateEvent(TOURNAMENT, ROUND_ROBIN, {
      draw_type: 'single-elim',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    // The way out — otherwise the director is stuck: `single-elim` has no generator, so
    // they could not even re-cut their way back into agreement with themselves.
    expect(result.status === 409 && result.detail).toContain('remove the draw')
    // A refused write writes nothing.
    expect(eventOf(ROUND_ROBIN).draw_type).toBe('round-robin')
  })

  // ⚠️ The one that keeps the freeze from eating the edits it exists to permit. The
  // editor PATCHes the WHOLE form back — draw type included — to move a pool's tables.
  // A guard that fired on the mere *presence* of `draw_type` would refuse that, and the
  // pools editor would be unusable against a server that allows it.
  it('ALLOWS a PATCH that re-sends the SAME draw type (the whole-form save)', () => {
    const result = updateEvent(TOURNAMENT, ROUND_ROBIN, {
      draw_type: 'round-robin',
      pools: eventOf(ROUND_ROBIN).pools.map((p) => ({ ...p, table_ids: ['t9'] })),
    })

    expect(result.ok).toBe(true)
    expect(eventOf(ROUND_ROBIN).pools[0].table_ids).toEqual(['t9'])
  })

  it('leaves an UNDRAWN event’s draw type free to change', () => {
    const result = updateEvent(TOURNAMENT, EMPTY_SINGLES, {
      draw_type: 'round-robin',
    })

    expect(result.ok).toBe(true)
    expect(eventOf(EMPTY_SINGLES).draw_type).toBe('round-robin')
  })

  it('un-freezes the moment the draw is removed', () => {
    expect(uncutDraw(TOURNAMENT, ROUND_ROBIN).ok).toBe(true)

    const result = updateEvent(TOURNAMENT, ROUND_ROBIN, {
      draw_type: 'single-elim',
    })

    expect(result.ok).toBe(true)
    expect(eventOf(ROUND_ROBIN).draw_type).toBe('single-elim')
  })
})

// ----- the solve tick's calling pass (ADR "the schedule is solved; the call is
// pinned"): while a tournament is LIVE, the mock worker's apply also CALLS the
// imminent fixtures — pinned_at set, one notification counted — so `npm run dev`
// demos a call, badge and all. Pre-live, a solve plans and notifies no one.

describe('the schedule solve tick — calling on a live tournament', () => {
  // The mock worker advances at most one step per ~600ms of `Date.now()`; a test
  // cannot wait, so the clock is driven forward a second per read. The base keeps
  // GROWING across tests (never reset) because the dwell's last-tick watermark is
  // module state in the store.
  let clock = Date.parse('2027-01-01T00:00:00Z')
  function stepClock() {
    vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 1_000
      return clock
    })
  }
  afterEach(() => vi.restoreAllMocks())

  /** Request a solve and read the detail twice — queued → running → succeeded,
   * exactly the walk the Schedule tab's polling makes. */
  function solveToCompletion(id: string) {
    const requested = requestScheduleSolve(id)
    if (!requested.ok) throw new Error('setup failed: solve refused')
    findTournament(id) // queued → running
    return findTournament(id)! // running → succeeded, placements applied
  }

  it('calls the imminent fixtures — placed within 10 minutes of the day’s first ball — with one notification counted', () => {
    stepClock()
    // Summer Slam: one drawn round-robin event, two pools (t1/t2 from 09:00,
    // t3/t4 from 11:00). LIVE, so the apply may promise.
    placeInStatus(DRAFT_TOURNAMENT, 'live')

    const detail = solveToCompletion(DRAFT_TOURNAMENT)

    const fixtures = detail.events.flatMap((e) => e.fixtures)
    const called = fixtures.filter((f) => f.pinned_at !== null)
    // Pool A's first wave — one fixture per pool table at the window's start —
    // is inside the call-ahead window; everything later is not.
    expect(called).toHaveLength(2)
    for (const fixture of called) {
      // The wire now carries a `FixtureTimeRead` object (ADR "tournament times are
      // timezone-aware instants"): a UTC instant for geometry + the venue-local label.
      expect(fixture.scheduled_start).toEqual(buildFixtureTimeRead('2026-08-22T09:00:00'))
      expect(fixture.pinned_at).toEqual(buildFixtureTimeRead('2026-08-22T09:00:00'))
      expect(fixture.call_notified_count).toBe(1)
    }
    // The rest of the plan stays an estimate: unpinned, nobody notified.
    for (const fixture of fixtures.filter((f) => f.pinned_at === null)) {
      expect(fixture.call_notified_count).toBe(0)
    }
    // The ledger row reports the calls it made.
    expect(detail.latest_schedule_solve).toMatchObject({
      status: 'succeeded',
      fixtures_pinned: 2,
    })
  })

  it('calls nothing pre-live — a solve plans, it does not notify', () => {
    stepClock()
    // Summer Slam stays a draft: same draw, same placements, no promises.
    const detail = solveToCompletion(DRAFT_TOURNAMENT)

    const fixtures = detail.events.flatMap((e) => e.fixtures)
    expect(fixtures.some((f) => f.table_id !== null)).toBe(true)
    expect(fixtures.every((f) => f.pinned_at === null)).toBe(true)
    expect(fixtures.every((f) => f.call_notified_count === 0)).toBe(true)
    expect(detail.latest_schedule_solve).toMatchObject({
      status: 'succeeded',
      fixtures_pinned: 0,
    })
  })

  it('never re-calls what is already promised — a second solve leaves the pins exactly as they were', () => {
    stepClock()
    placeInStatus(DRAFT_TOURNAMENT, 'live')
    solveToCompletion(DRAFT_TOURNAMENT)

    const again = solveToCompletion(DRAFT_TOURNAMENT)

    const called = again.events
      .flatMap((e) => e.fixtures)
      .filter((f) => f.pinned_at !== null)
    expect(called).toHaveLength(2)
    // Still exactly one notification each: the pass skips pinned fixtures, so a
    // re-solve cannot quietly spend the players' attention twice.
    expect(called.every((f) => f.call_notified_count === 1)).toBe(true)
  })
})
