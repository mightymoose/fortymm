// The dev store models entries the way the server does (ADR-0016): the `entered`
// count is DERIVED from the active entrants, so the two can never disagree, and
// withdrawing frees the player to enter again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  buildFixtureTimeRead,
  DRAW_TYPE_CATALOGUE,
  planDraw,
} from '@/mocks/factories/tournaments/tournament.factory'
import { mockUuid } from '@/mocks/mock-uuid'
import {
  BAY_AREA_OPEN_ID,
  CLUB_CHAMPS_ID,
  GOLDEN_STATE_CLASSIC_ID,
  LEAGUE_OFFICE_DRAFT_ID,
  SUMMER_SLAM_ID,
} from '@/mocks/factories/tournaments/tournament-ids'
import {
  createEvent,
  createTournament,
  cutDraw,
  deleteEvent,
  enterEvent,
  findTournament,
  listTournaments,
  markFixturePlayed,
  placeFixture,
  placeInStatus,
  requestScheduleSolve,
  resetTournamentsStore,
  transitionTournament,
  uncutDraw,
  updateEvent,
  updateTournament,
  withdrawEntry,
  type EnterResult,
  type StoreResult,
  type TransitionResult,
  type WithdrawResult,
} from './tournaments-store'
import type { components } from '@/api/schema'

type TournamentStatus = components['schemas']['TournamentStatus']
type TournamentTable = components['schemas']['TournamentTable']
type TournamentTableUpsert = components['schemas']['TournamentTableUpsert']

const TOURNAMENT = BAY_AREA_OPEN_ID // seeded `published`, owned
const DRAFT_TOURNAMENT = SUMMER_SLAM_ID // seeded `draft`, owned, one drawn event
const EMPTY_SINGLES = mockUuid('ev-u1500') // seeded with no entrants
const FULLISH_SINGLES = mockUuid('ev-open-singles') // seeded with 52 other players, cap 64
const FULL_SINGLES = mockUuid('ev-champ-singles') // seeded 16 of 16 — no room (#783)
const INELIGIBLE_SINGLES = mockUuid('ev-u1200') // rating < 1200; the dev user is 1650 (#783)
const DOUBLES = mockUuid('ev-mixed-doubles')

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

/** A window of time, for the reservation literals the draw cases patch events with.
 * Nothing about a draw turns on *when* a reservation books — only on which reservations
 * (and therefore groups) there are — so one slot serves them all. */
const SLOT = { date: '2026-06-14', start: '09:00', end: '12:00' }

/** A v4 uuid, which is what a reservation id is on the wire (`Reservation.id` is
 * `format: uuid`) now that the server mints it (ADR 20260801) — and what the store's
 * own mint has to answer with, on the create path and on the patch path alike. Spelled
 * out rather than merely "is a string", because "the id is missing" and "the id is the
 * empty string" are exactly the two shapes a mint that quietly did nothing would leave
 * behind. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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

/**
 * `updateEvent`, with `lock_version` filled in from the CURRENT stored value (#1499)
 * — read fresh off the store right before the call, the same way a real client's most
 * recent GET would be. Every test below this point is about draw settings,
 * reservations, capacity, the group-set freeze, or some other business rule that
 * predates #1499 and has nothing to do with it, so none of them should have to state
 * a version by hand (or worse, a hard-coded number a future seed change silently
 * makes wrong). The dedicated version-conflict coverage lives in its own `describe`
 * block below and calls the real `updateEvent` directly, with an explicit —
 * deliberately wrong — number.
 */
function patchEvent(
  tournamentId: string,
  eventId: string,
  patch: Omit<Partial<components['schemas']['TournamentEventUpdate']>, 'lock_version'>,
) {
  const current = findTournament(tournamentId)?.events.find((e) => e.id === eventId)
  if (!current) throw new Error(`no such event ${eventId} on ${tournamentId}`)
  return updateEvent(tournamentId, eventId, {
    lock_version: current.lock_version,
    ...patch,
  } as components['schemas']['TournamentEventUpdate'])
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

// #1229 (duplicates #1211, #1323): the `$tournamentId` route Zod-validates the segment
// as a `z.string().uuid()` BEFORE any fetch (`tournaments.$tournamentId.tsx`, ADR-1001),
// so a mock tournament whose id is a slug 404s its own detail page under `npm run dev`
// before MSW ever sees the request. This pins the CLASS of bug, not just the six ids
// fixed here — a future seed row (or `createTournament` mint) that reverts to a
// hand-written slug reds this immediately, rather than waiting for someone to click
// through `npm run dev` and notice.
describe('every tournament id is uuid-shaped (#1229)', () => {
  const uuid = z.string().uuid()

  it('every id `listTournaments` (i.e. the dev seed) hands out', () => {
    for (const tournament of listTournaments()) {
      expect(uuid.safeParse(tournament.id).success).toBe(true)
    }
  })

  it('the id `createTournament` mints', () => {
    const created = createTournament({
      name: 'Newly Minted',
      description: null,
      address: null,
      table_catalogue: [],
    })
    expect(uuid.safeParse(created.id).success).toBe(true)
  })
})

// #1503, and the same class of bug one level down: which event's editor is open is a
// `?event=<uuid>` search param now, parsed at the route boundary before anything
// resolves it. An event whose mock id is a slug therefore cannot be OPENED under
// `npm run dev` — the value fails the union, `.catch({})` drops it, and the sheet
// silently never appears. The `createEvent` case is the one that bites hardest: the
// event a director has just authored is the one they are most likely to click.
describe('every event id is uuid-shaped (#1503)', () => {
  const uuid = z.string().uuid()

  it('every id the dev seed hands out', () => {
    for (const tournament of listTournaments()) {
      const detail = findTournament(tournament.id)
      for (const event of detail?.events ?? []) {
        expect(uuid.safeParse(event.id).success).toBe(true)
      }
    }
  })

  it('the id `createEvent` mints', () => {
    const created = createEvent(DRAFT_TOURNAMENT, {
      name: 'Freshly Authored',
      format: 'singles',
      draw_type: 'single-elim',
      max_players: 16,
      entry_fee: 10,
      timezone: 'America/Chicago',
      slot: { date: '2026-08-22', start: '09:00', end: '12:00' },
      match_settings: { rated: false, length_games: 3 },
    })
    if (!created.ok) throw new Error('setup failed: the event was refused')
    expect(uuid.safeParse(created.event.id).success).toBe(true)
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
    expect(enterEvent(TOURNAMENT, mockUuid('ev-nope'))).toEqual({ ok: false, status: 404 })
  })

  it('is allowed on a tournament the entrant does not own — entry is not creator-gated', () => {
    // Published (so the window is open) but owned by the league office: what is
    // being proved here is that ownership has nothing to do with entering.
    const notMine = findTournament(CLUB_CHAMPS_ID)!
    expect(notMine.can_edit).toBe(false)
    expect(notMine.status).toBe('published')

    const result = enterEvent(CLUB_CHAMPS_ID, mockUuid('ev-cc-open'))

    expect(result.ok).toBe(true)
    const found = findTournament(CLUB_CHAMPS_ID)!.events.find(
      (e) => e.id === mockUuid('ev-cc-open'),
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

    const result = patchEvent(TOURNAMENT, EMPTY_SINGLES, { name: 'Renamed' })
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
    const result = patchEvent(TOURNAMENT, EMPTY_SINGLES, { max_players: null })
    if (!result.ok) throw new Error('update failed')
    expect(result.event.max_players).toBeNull()
  })

  /**
   * **The reservation positions come from the array index, and nowhere else** — the
   * store half of the rule the editor and the draw panel both depend on.
   *
   * Neither write shape has a `position` (both are `extra="forbid"`, so sending one is a
   * 422), so the ORDER of the list is the only thing that says which reservation is
   * first. The server turns that order into numbers; if the mock did not, the app would
   * look right in `npm run dev` while every reservation came back tied for first — a
   * mock/server disagreement about a rule the UI reads on every load.
   *
   * Ten of them, named `Reservation 1`…`Reservation 10` — a set whose lexicographic
   * order is 1, 10, 2, 3 … — so a store that numbered them by name (or handed back a
   * default `0`) cannot pass by coincidence. They carry **no id**: `ReservationWrite`
   * has none (ADR 20260801), and the ids the assertions below travel on are the ones
   * the store minted.
   */
  const TEN_WRITE_RESERVATIONS = Array.from({ length: 10 }, (_, i) => ({
    name: `Reservation ${i + 1}`,
    slot: SLOT,
    table_ids: [],
  }))

  /** Create the ten-reservation event and hand back its reservations **as read** —
   * minted ids and all. */
  function createTenReservationEvent() {
    const result = createEvent(TOURNAMENT, {
      name: 'Ten-reservation Singles',
      // rr-then-ko (#1482): the one draw type ten reservations does not exceed the
      // cap on.
      draw_type: 'rr-then-ko',
      qualifiers_per_group: 2,
      format: 'singles',
      entry_fee: 0,
      timezone: 'America/Chicago',
      slot: SLOT,
      match_settings: { rated: false, length_games: 3 },
      reservations: TEN_WRITE_RESERVATIONS,
    })
    if (!result.ok) throw new Error('create failed')
    return result.event
  }

  it('stamps a created event’s reservations with the position of their index', () => {
    const event = createTenReservationEvent()

    expect(event.reservations.map((r) => r.position)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
    expect(event.reservations.map((r) => r.name)).toEqual(
      TEN_WRITE_RESERVATIONS.map((r) => r.name),
    )
  })

  // The create path has no id to send, so this is where the ids come from at all: the
  // store mints one per reservation (ADR 20260801), uuid-shaped and all different — the
  // same thing `gen_random_uuid()` does on the server, and what every fixture drawn
  // into the reservation's mapped group will hold.
  it('mints a uuid id for every reservation of a created event', () => {
    const ids = createTenReservationEvent().reservations.map((r) => r.id)

    expect(new Set(ids).size).toBe(10)
    for (const id of ids) expect(id).toMatch(UUID)
  })

  // …and RE-stamps on every reservations patch, because that is the whole reordering
  // API: send them in the order you want and the positions follow. The patch CITES the
  // ids the create minted — that is what makes it a reorder of these ten reservations
  // rather than ten additions, and the ids travelling with the names is the proof.
  it('re-positions a patched event’s reservations from the new order', () => {
    const created = createTenReservationEvent()
    const reversed = [...created.reservations]
      .reverse()
      .map((r) => ({ id: r.id, name: r.name, slot: r.slot, table_ids: r.table_ids }))

    const result = patchEvent(TOURNAMENT, created.id, { reservations: reversed })
    if (!result.ok) throw new Error('update failed')

    expect(result.event.reservations.map((r) => r.name)).toEqual(
      reversed.map((r) => r.name),
    )
    expect(result.event.reservations.map((r) => r.id)).toEqual(reversed.map((r) => r.id))
    expect(result.event.reservations.map((r) => r.position)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
  })

  // An absent `reservations` is not touching them, so the stored positions stand — the
  // same "absent means unchanged" the cap follows one test up.
  it('leaves the stored positions alone when a PATCH names no reservations', () => {
    const before = event(FULLISH_SINGLES).reservations.map((r) => r.position)
    const result = patchEvent(TOURNAMENT, FULLISH_SINGLES, { name: 'Renamed' })
    if (!result.ok) throw new Error('update failed')

    expect(result.event.reservations.map((r) => r.position)).toEqual(before)
  })
})

// Optimistic concurrency (#1499): a PATCH states the `lock_version` it read the
// event at, and the store refuses one that does not match — before either draw
// freeze and before the reservation cap, so a stale draft that ALSO trips one of
// those on its way through is told the true thing (the event moved under it)
// rather than blamed for a field it never touched. Every accepted PATCH moves the
// token on by one, unconditionally.
describe('updateEvent — the lock_version guard (#1499)', () => {
  it('accepts a PATCH whose lock_version matches the stored one, and moves it on by one', () => {
    const before = event(EMPTY_SINGLES).lock_version
    const result = updateEvent(TOURNAMENT, EMPTY_SINGLES, {
      lock_version: before,
      name: 'Renamed',
    })
    if (!result.ok) throw new Error('update failed')

    expect(result.event.lock_version).toBe(before + 1)
  })

  it('moves the token on even when the payload changes nothing else', () => {
    // Mirrors the server's own unconditional bump (#1499): a PATCH is still a
    // write, even a no-op one, and the alternative — bump only on a real change —
    // would mean deciding what "changed" means across scalars, JSONB
    // value-objects, a settings row and a child-row diff.
    const before = event(EMPTY_SINGLES).lock_version
    const result = updateEvent(TOURNAMENT, EMPTY_SINGLES, {
      lock_version: before,
      name: event(EMPTY_SINGLES).name,
    })
    if (!result.ok) throw new Error('update failed')

    expect(result.event.lock_version).toBe(before + 1)
  })

  it('refuses a STALE lock_version with a CODED 409, and writes nothing', () => {
    const before = event(EMPTY_SINGLES)
    const result = updateEvent(TOURNAMENT, EMPTY_SINGLES, {
      lock_version: before.lock_version + 1, // a version this event has not reached yet
      name: 'Should not land',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.status).toBe(409)
    expect('code' in result && result.code).toBe('event_version_conflict')
    // Nothing written — the name, and the version, are exactly as they were.
    expect(event(EMPTY_SINGLES).name).toBe(before.name)
    expect(event(EMPTY_SINGLES).lock_version).toBe(before.lock_version)
  })

  // FIRST of every payload gate (#1499) — before the group-set freeze, which THIS
  // stale patch would also trip (it removes the event's only reservation on a
  // cut draw). The version conflict is the true news; the freeze would blame the
  // wrong thing.
  it('is judged BEFORE the group-set freeze — a stale draft is told the truth, not blamed for the freeze it also trips', () => {
    const cut = cutDraw(TOURNAMENT, FULLISH_SINGLES)
    if (!cut.ok) throw new Error('cut failed')
    const before = event(FULLISH_SINGLES)

    const result = updateEvent(TOURNAMENT, FULLISH_SINGLES, {
      lock_version: before.lock_version + 1,
      reservations: [], // would ALSO trip the group-set freeze, were it reached
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect('code' in result && result.code).toBe('event_version_conflict')
  })
})

// The lifecycle (ADR-0017). The store enforces the SERVER's edge table, not a
// looser one: a mock that permitted an illegal edge would let a broken UI look
// fine in dev and in vitest, which is the entire point of mirroring it.
describe('transitionTournament', () => {
  const DRAFT = SUMMER_SLAM_ID // seeded `draft`, owned
  const PUBLISHED = BAY_AREA_OPEN_ID // seeded `published`, owned
  const NOT_MINE = CLUB_CHAMPS_ID // seeded `published`, can_edit: false
  /** `DRAFT`'s only event: round-robin, 8 entrants, a draw already cut across its one
   * group (#1482) — i.e. the one seeded event whose draw is CURRENT, which is what
   * makes that tournament the only one in the seed that can go live at all. */
  const SLAM_EVENT = mockUuid('ev-slam-open')

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
    const entered = enterEvent(id, mockUuid('ev-slam-open'))
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
    enterEvent(id, mockUuid('ev-slam-open'))
    expect(transitionTournament(id, 'live').ok).toBe(false)

    const recut = cutDraw(id, mockUuid('ev-slam-open'))
    if (!recut.ok) throw new Error('setup failed: could not re-cut')

    expect(transitionTournament(id, 'live').ok).toBe(true)
    expect(findTournament(id)!.status).toBe('live')
  })

  // ----- the undrawable half of the refusal (#1300) -------------------------
  //
  // The dead end this closes: an event nobody can cut a draw for — a field under two
  // entrants, or a doubles/teams event — was reported as merely "has no draw yet", and
  // the refusal told the director to go and cut it. The cut then refused, and the only
  // escape the QA pass found was deleting the event.
  //
  // ⚠️ THESE FOUR ARE MIRROR ASSERTIONS. Each string below is the API's composed
  // refusal, copied verbatim from the now-passing API tests, asserted with `toBe` and
  // never `toContain`. Nothing here may be imported from the store: a test that read the
  // copy out of the code it is testing would pass whatever the copy became, and the whole
  // point of the mock is that a page built against it is built against words the server
  // really says. A `toContain` would be almost as bad — the load-bearing property of the
  // all-undrawable case is a sentence that is ABSENT.

  /** A reservation to add, in a create body's own shape: no `id`, because its id is the
   * server's to mint (ADR 20260801). */
  const reservationNamed = (name: string) => ({ name, slot: SLOT, table_ids: [] })

  /** One event on a tournament that already exists, with the shape these cases turn on
   * (format, draw type, reservations) and boring defaults for everything else. */
  function addEvent(
    tournamentId: string,
    body: Partial<Parameters<typeof createEvent>[1]> &
      Pick<Parameters<typeof createEvent>[1], 'name' | 'format' | 'draw_type'>,
  ): string {
    const created = createEvent(tournamentId, {
      max_players: 16,
      entry_fee: 0,
      timezone: 'America/Chicago',
      slot: SLOT,
      match_settings: { rated: false, length_games: 3 },
      ...body,
    })
    if (!created.ok) throw new Error(`setup failed: could not add ${body.name}`)
    return created.event.id
  }

  it('reports a ZERO-entrant round-robin event as undrawable, in the planner’s own words', () => {
    // Zero entrants is the same dead end as one: every floor tests `< 2`. The counts are
    // what the director has to change, so the planner's counted sentence goes through
    // verbatim — and it is the sentence the mock used to get WRONG ("0 entrants across 1
    // group(s)"), which nothing caught while it lived only behind the cut's 422.
    const id = announcedEmptyTournament()
    addEvent(id, {
      name: 'Empty Event',
      format: 'singles',
      draw_type: 'round-robin',
      reservations: [reservationNamed('Reservation A')],
    })

    expect(refusalDetail(transitionTournament(id, 'live'))).toBe(
      'This tournament cannot start yet: “Empty Event”: 0 entrants across 1 group ' +
        'would leave a group with fewer than 2 entrants, who would have nobody to play. ' +
        'Add entrants, or remove the event.',
    )
    expect(findTournament(id)!.status).toBe('published')
  })

  it('appends NO fix to a degenerate message that already names its own', () => {
    // The other arm of the fix rule, and the one every case above is blind to: the fix is
    // appended for a field under two entrants and for NOTHING else. "Take fewer
    // qualifiers…, or add entrants" already tells the director what to do, and this
    // event has 52 entrants — a second, separate "Add entrants…" would repeat itself.
    //
    // "A round-robin draw needs at least one group" no longer serves this purpose (ADR
    // 20260823): a standalone event's one stage now always holds exactly one group,
    // decoupled from its reservation count, so that refusal is unreachable for a
    // round-robin event — see `ev-u1500`'s own seed comment, `tournaments-store.ts`.
    const id = PUBLISHED
    for (const gone of [EMPTY_SINGLES, FULL_SINGLES, INELIGIBLE_SINGLES, DOUBLES]) {
      if (!deleteEvent(id, gone).ok) throw new Error(`setup failed: ${gone}`)
    }
    // 52 entrants, re-typed `rr-then-ko` across two reservations — the group stage still
    // derives its count from `reservations.length` alone (`groupsForEvent`'s `rr-then-ko`
    // arm is unchanged), so this snakes to 26 entrants a group — and K set past that
    // smallest group, the one refusal that is about the qualifier count.
    if (
      !patchEvent(id, FULLISH_SINGLES, {
        draw_type: 'rr-then-ko',
        qualifiers_per_group: 27,
        reservations: [
          { name: 'Reservation A', slot: SLOT, table_ids: [] },
          { name: 'Reservation B', slot: SLOT, table_ids: [] },
        ],
      }).ok
    ) {
      throw new Error('setup failed: could not re-type the event')
    }

    // No trailing fix, and no trailing space — which is why this is a `toBe`.
    expect(refusalDetail(transitionTournament(id, 'live'))).toBe(
      'This tournament cannot start yet: “Open Singles”: Taking 27 qualifiers from ' +
        'each group is more than the 26 entrants in the smallest group — take fewer ' +
        'qualifiers from each group, or add entrants.',
    )
  })

  it('reports a NON-SINGLES event as undrawable, and names removal as the only fix', () => {
    // The worst instance of the dead end, because it is permanent: entry is refused for
    // every non-singles event, so its field can never reach two and "add entrants" would
    // be an instruction nobody can follow. Judged on format alone — no draw is planned.
    const id = announcedEmptyTournament()
    addEvent(id, {
      name: 'Doubles Event',
      format: 'doubles',
      draw_type: 'single-elim',
    })

    expect(refusalDetail(transitionTournament(id, 'live'))).toBe(
      'This tournament cannot start yet: “Doubles Event”: A doubles event cannot be ' +
        'given a draw — only singles events can. A fixture seats one entrant on each ' +
        'side, and there is nowhere to record a doubles pairing or a team. Remove the ' +
        'event.',
    )
    expect(findTournament(id)!.status).toBe('published')
  })

  it('says NOTHING about cutting a draw when every at-fault event is undrawable', () => {
    // The acceptance criterion of #1300, and the reason the sentence is built as two
    // independent bodies rather than one with an extra clause. Each event carries its own
    // reason and its own fix; neither fix is "cut the draw", because for these two events
    // that click can only fail.
    const id = announcedEmptyTournament()
    addEvent(id, {
      name: 'Doubles Event',
      format: 'doubles',
      draw_type: 'single-elim',
    })
    const lone = addEvent(id, {
      name: 'Lone Event',
      format: 'singles',
      draw_type: 'single-elim',
    })
    if (!enterEvent(id, lone).ok) throw new Error('setup failed: could not enter')

    const detail = refusalDetail(transitionTournament(id, 'live'))

    expect(detail).toBe(
      'This tournament cannot start yet: “Doubles Event”: A doubles event cannot be ' +
        'given a draw — only singles events can. A fixture seats one entrant on each ' +
        'side, and there is nowhere to record a doubles pairing or a team. Remove the ' +
        'event. “Lone Event”: A single-elimination draw needs at least 2 entrants — a ' +
        'bracket of one has nobody to play. Add entrants, or remove the event.',
    )
    // Asserted separately from the `toBe` above, because this is the property the ticket
    // is about and it must fail with its own name when it breaks.
    expect(detail).not.toContain('cut the draw')
    expect(findTournament(id)!.status).toBe('published')
  })

  it('reports an undrawable, an uncut and a stale event side by side, undrawable first', () => {
    // The mixed tournament: all three at-fault kinds at once. The cut instruction is
    // still there — two of these events really are one click from ready — and it now
    // names only the events it is true of. The undrawable body is reported FIRST so that
    // instruction, which closes the uncut/stale body, trails only those two names; with
    // the bodies the other way round QA read "cut the draw for each event named" and
    // clicked Generate draw on the undrawable event, which the cut refuses (#1300).
    const id = PUBLISHED
    // Down to the two seeded events with a real field. (The seed's other three are an
    // empty group-less round-robin, a doubles event and the drawn U1200 — each a case
    // above, and each noise here.)
    for (const gone of [EMPTY_SINGLES, INELIGIBLE_SINGLES, DOUBLES]) {
      if (!deleteEvent(id, gone).ok) throw new Error(`setup failed: ${gone}`)
    }
    // “C Stale”: 52 entrants, drawn — and then a 53rd enters, so the draw seats a field
    // that is no longer the field. A re-cut fixes it, so it stays in the stale bucket.
    if (!cutDraw(id, FULLISH_SINGLES).ok) throw new Error('setup failed: cut')
    if (!enterEvent(id, FULLISH_SINGLES).ok) throw new Error('setup failed: enter')
    if (!patchEvent(id, FULLISH_SINGLES, { name: 'C Stale' }).ok) {
      throw new Error('setup failed: rename')
    }
    // “B Uncut”: 16 entrants, never cut — one click from ready.
    if (!patchEvent(id, FULL_SINGLES, { name: 'B Uncut' }).ok) {
      throw new Error('setup failed: rename')
    }
    // “A Undrawable”: one group, one entrant — the headline repro of #1300.
    const lone = addEvent(id, {
      name: 'A Undrawable',
      format: 'singles',
      draw_type: 'round-robin',
      reservations: [reservationNamed('Reservation A')],
    })
    if (!enterEvent(id, lone).ok) throw new Error('setup failed: could not enter')

    const mixed = refusalDetail(transitionTournament(id, 'live'))!

    // The ORDER first, and deliberately BEFORE the whole-sentence pin below. All three
    // buckets are non-empty here, so this is the real three-bucket ordering — and put
    // after the `toBe`, these could never be the failing signal, because the exact-string
    // assertion already pins the order and would red first. A test whose comment claims
    // it guards a property it can never report on is worse than no test.
    expect(mixed.indexOf('“A Undrawable”')).toBeLessThan(mixed.indexOf('“B Uncut”'))
    expect(mixed.indexOf('“B Uncut”')).toBeLessThan(mixed.indexOf('cut the draw'))
    expect(mixed.endsWith('then start the tournament.')).toBe(true)

    // Undrawable first, mirroring the server: "cut the draw for each event named" must
    // trail only the names a cut would actually fix (#1300 QA).
    expect(mixed).toBe(
      'This tournament cannot start yet: “A Undrawable”: 1 entrant across 1 group would ' +
        'leave a group with fewer than 2 entrants, who would have nobody to play. Add ' +
        'entrants, or remove the event. “B Uncut” has no draw yet; and “C Stale” has ' +
        'a draw that no longer matches its entrants. A draw is cut from the field as ' +
        'it stands at the time, and registration stays open right up to the moment a ' +
        'tournament goes live — so cut the draw for each event named (again, if ' +
        'somebody entered or withdrew since it was last cut), then start the ' +
        'tournament.',
    )
    expect(findTournament(id)!.status).toBe('published')
  })

  // ⚠️ NOT covered here, and not for want of trying: "a draw that is stale AND whose
  // field has dropped below two is reported as undrawable, not as stale". The store
  // cannot reach that state through its own routes — only the dev user can enter, and
  // `withdrawEntry` 403s on anybody else's entry, so a field that was cuttable (≥ 2) can
  // never shrink below two here. The API's own tests cover it; the arm that would answer
  // it in this store is the same one the mixed case above exercises, since the dry run
  // runs over `uncut` and `stale` alike.

  // The load-bearing half of ADR-0017: with `status` gone from `TournamentUpdate`,
  // editing a tournament's fields cannot move its lifecycle. The transitions
  // resource is the only door.
  it('is the ONLY way a status changes — a field edit leaves it where it was', () => {
    const result = updateTournament(PUBLISHED, { details_version: 1, name: 'Renamed Open' })
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
  const FOREIGN_DRAFT = LEAGUE_OFFICE_DRAFT_ID // seeded `draft`, u-office
  const FOREIGN_PUBLISHED = CLUB_CHAMPS_ID // seeded `published`, u-office
  const OWN_DRAFT = SUMMER_SLAM_ID // seeded `draft`, the dev user's

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

// #1482: a non-`rr-then-ko` event holds AT MOST ONE reservation — every other draw
// type runs its whole stage as one group (ADR 20260808), so a second reservation would
// be dead data no fixture could ever be dealt into. Zero stays legal; this is a
// ceiling, not a floor. The mock enforces the SAME 422 the server does (`_enforce_
// reservation_cap` / `enforce_event_reservation_cap`, `api/app/schemas/tournament.py`)
// so a web-client test cannot pass against a server that does not exist.
describe('the reservation cap (#1482)', () => {
  beforeEach(() => resetTournamentsStore())

  it('refuses a CREATE of a round-robin event with more than one reservation', () => {
    const result = createEvent(TOURNAMENT, {
      name: 'Over-cap Singles',
      format: 'singles',
      draw_type: 'round-robin',
      entry_fee: 0,
      timezone: 'America/Chicago',
      slot: SLOT,
      match_settings: { rated: false, length_games: 3 },
      reservations: [
        { name: 'Reservation A', slot: SLOT, table_ids: [] },
        { name: 'Reservation B', slot: SLOT, table_ids: [] },
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(422)
  })

  it('accepts a CREATE of an rr-then-ko event with more than one reservation', () => {
    const result = createEvent(TOURNAMENT, {
      name: 'Two-stage Singles',
      format: 'singles',
      draw_type: 'rr-then-ko',
      qualifiers_per_group: 2,
      entry_fee: 0,
      timezone: 'America/Chicago',
      slot: SLOT,
      match_settings: { rated: false, length_games: 3 },
      reservations: [
        { name: 'Reservation A', slot: SLOT, table_ids: [] },
        { name: 'Reservation B', slot: SLOT, table_ids: [] },
      ],
    })

    expect(result.ok).toBe(true)
  })

  it('accepts a CREATE of a round-robin event with zero reservations — a ceiling, not a floor', () => {
    const result = createEvent(TOURNAMENT, {
      name: 'Zero-reservation Singles',
      format: 'singles',
      draw_type: 'round-robin',
      entry_fee: 0,
      timezone: 'America/Chicago',
      slot: SLOT,
      match_settings: { rated: false, length_games: 3 },
    })

    expect(result.ok).toBe(true)
  })

  it('refuses a PATCH sending only reservations, more than one, against a stored round-robin event', () => {
    // `EMPTY_SINGLES` is seeded round-robin with no reservations at all.
    const result = patchEvent(TOURNAMENT, EMPTY_SINGLES, {
      reservations: [
        { name: 'Reservation A', slot: SLOT, table_ids: [] },
        { name: 'Reservation B', slot: SLOT, table_ids: [] },
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(422)
  })

  it('accepts a PATCH that leaves a round-robin event at exactly one reservation', () => {
    const result = patchEvent(TOURNAMENT, EMPTY_SINGLES, {
      reservations: [{ name: 'Reservation A', slot: SLOT, table_ids: [] }],
    })

    expect(result.ok).toBe(true)
  })

  // The cap reads the EFFECTIVE pair: a PATCH that sends only `draw_type`, against a
  // stored event already holding more than one reservation, is judged against the
  // reservation count it would be LEFT holding — the stored one — not against a count
  // this payload never mentions. Built via a fresh `rr-then-ko` create (legally holding
  // two) rather than off a seeded fixture, so the claim stands on its own.
  it('refuses a PATCH sending only draw_type against a stored event already holding more than one reservation', () => {
    const created = createEvent(TOURNAMENT, {
      name: 'Two-stage For A Flip',
      format: 'singles',
      draw_type: 'rr-then-ko',
      qualifiers_per_group: 2,
      entry_fee: 0,
      timezone: 'America/Chicago',
      slot: SLOT,
      match_settings: { rated: false, length_games: 3 },
      reservations: [
        { name: 'Reservation A', slot: SLOT, table_ids: [] },
        { name: 'Reservation B', slot: SLOT, table_ids: [] },
      ],
    })
    if (!created.ok) throw new Error('setup create failed')

    const result = patchEvent(TOURNAMENT, created.event.id, { draw_type: 'round-robin' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(422)
  })

  // …and the flip the OTHER way is always legal — the cap only narrows.
  it('accepts a PATCH flipping round-robin to rr-then-ko while holding more than one reservation', () => {
    const result = patchEvent(TOURNAMENT, EMPTY_SINGLES, {
      draw_type: 'rr-then-ko',
      qualifiers_per_group: 2,
      reservations: [
        { name: 'Reservation A', slot: SLOT, table_ids: [] },
        { name: 'Reservation B', slot: SLOT, table_ids: [] },
      ],
    })

    expect(result.ok).toBe(true)
  })
})

// The draw (ADR-0786). A mock that were more permissive than the server it stands in
// for would be a trap: a Generate button that "worked" in `npm run dev` and 422'd in
// production would look like a server bug rather than the missing generator it is. So
// each refusal below is one the API really makes, in the API's own order.
describe('cutting and un-cutting a draw', () => {
  beforeEach(() => resetTournamentsStore())

  const FOREIGN = CLUB_CHAMPS_ID // `u-office`'s, published: readable, not writable
  const FOREIGN_EVENT = mockUuid('ev-cc-open')
  /** Round-robin, one group, nine entrants, cut — the seed's `ev-u1200` (#1482: a
   * round-robin event holds at most one reservation, so this is also the store's ONE
   * cuttable round-robin event, because round-robin is the only draw type with a
   * generator today). There is no seeded round-robin event with two groups any more —
   * that state is reachable only through data minted before the cap existed, and this
   * store mints fresh on every run, so it seeds none. */
  const ROUND_ROBIN = mockUuid('ev-u1200')

  const eventOf = (tournamentId: string, eventId: string) =>
    findTournament(tournamentId)!.events.find((e) => e.id === eventId)!

  /** A reservation to ADD, in a PATCH's own shape: no `id`, because a reservation id is
   * the server's to mint (ADR 20260801) and omitting one is how a payload says "add this
   * reservation" — and, 1:1, the group it mints. */
  const reservationNamed = (name: string) => ({
    name,
    slot: SLOT,
    table_ids: [],
  })

  it('seeds the round-robin event ALREADY DRAWN, and every other event with no draw', () => {
    const drawn = eventOf(TOURNAMENT, ROUND_ROBIN)
    // 9 entrants, ONE group (#1482): C(9,2) = 36 pairs.
    expect(drawn.fixtures).toHaveLength(36)
    // One other event in this seed is ALSO drawn: `ev-two-stage-cut` (`rr-then-ko`, the
    // group-set-freeze fixture below) — deliberate, so this sweep excludes it by name
    // rather than asserting a state the seed no longer has.
    const alsoDrawn = new Set([mockUuid('ev-two-stage-cut')])
    for (const other of findTournament(TOURNAMENT)!.events.filter(
      (e) => e.id !== ROUND_ROBIN && !alsoDrawn.has(e.id),
    )) {
      // `[]`, not null: an event with no draw is EMPTY, and empty is a state.
      expect(other.fixtures).toEqual([])
    }
  })

  it('cuts every pair exactly once, inside a group, and nobody twice in a round', () => {
    expect(uncutDraw(TOURNAMENT, ROUND_ROBIN).ok).toBe(true)
    const result = cutDraw(TOURNAMENT, ROUND_ROBIN)
    if (!result.ok) throw new Error(`expected a cut, got ${result.status}`)

    const groups = eventOf(TOURNAMENT, ROUND_ROBIN).groups.map((g) => g.id)
    // Every fixture names one of THIS event's groups — a `group_id` is a string ref into
    // that JSONB, not a foreign key, so a draw pointing at a group the event does not
    // have is a draw nothing can render.
    expect(new Set(result.fixtures.map((f) => f.group_id))).toEqual(new Set(groups))

    // Every pair meets exactly once…
    const pairs = result.fixtures.map((f) =>
      [f.entry_a_id, f.entry_b_id].sort().join('|'),
    )
    expect(new Set(pairs).size).toBe(pairs.length)

    // …and nobody plays twice in the same (group, round): the circle method's whole
    // promise, and the thing a naive "pair them up" planner gets wrong.
    for (const fixture of result.fixtures) {
      const sameRound = result.fixtures.filter(
        (f) => f.group_id === fixture.group_id && f.round === fixture.round,
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

  it('re-cuts WHOLESALE against the event as it stands now — a fresh reservation, a fresh group, a fresh draw', () => {
    // The plan is made against the CURRENT config, never patched onto the old one. #1482
    // caps a round-robin event at one reservation, so what varies here is the
    // reservation's IDENTITY rather than its count: the stored one is dropped for a
    // newly-named one, and the fixtures that referred to the OLD group are gone, not
    // re-pointed at the new one.
    const before = eventOf(TOURNAMENT, ROUND_ROBIN).groups.map((g) => g.id)
    expect(uncutDraw(TOURNAMENT, ROUND_ROBIN).ok).toBe(true) // the freeze lifts first
    patchEvent(TOURNAMENT, ROUND_ROBIN, { reservations: [reservationNamed('Reservation One')] })
    // The one group the event now has — a freshly MINTED id, not a name the test chose,
    // because the old reservation (and its group) was dropped and this one was added.
    const after = eventOf(TOURNAMENT, ROUND_ROBIN).groups.map((g) => g.id)
    expect(after).toHaveLength(1)
    expect(after).not.toEqual(before)

    const result = cutDraw(TOURNAMENT, ROUND_ROBIN)

    if (!result.ok) throw new Error(`expected a cut, got ${result.status}`)
    // Still one group of nine — the count did not change, the reservation did — so the
    // fixture count is unchanged and every one of them names the NEW group, not the old.
    expect(result.fixtures).toHaveLength(36) // C(9,2)
    expect(new Set(result.fixtures.map((f) => f.group_id))).toEqual(new Set(after))
  })

  it('un-cutting empties the draw; un-cutting again is still a success (idempotent DELETE)', () => {
    expect(uncutDraw(TOURNAMENT, ROUND_ROBIN)).toEqual({ ok: true })
    expect(eventOf(TOURNAMENT, ROUND_ROBIN).fixtures).toEqual([])
    // An event with no draw is already in the state this asks for.
    expect(uncutDraw(TOURNAMENT, ROUND_ROBIN)).toEqual({ ok: true })
    expect(uncutDraw(TOURNAMENT, EMPTY_SINGLES)).toEqual({ ok: true })
  })

  it('cuts a round-robin draw with NO reservations — the group floor no longer needs one (ADR 20260823)', () => {
    // Before #1484 this refused ("A round-robin draw needs at least one group"): the
    // group count came from `reservations.length` alone, and zero reservations meant
    // zero groups. Since ADR 20260823 a standalone event's one stage always holds
    // exactly one group, decoupled from its reservation count — so this now CUTS, into
    // one group that maps to no reservation (an Edge Case the ticket names outright:
    // "a zero-reservation event… their fixtures fall to the synthetic event-wide
    // reservation… nothing here refuses that state").
    patchEvent(TOURNAMENT, FULLISH_SINGLES, { draw_type: 'round-robin', reservations: [] })

    const result = cutDraw(TOURNAMENT, FULLISH_SINGLES)
    if (!result.ok) throw new Error(`expected a cut, got ${result.status}`)

    const event = eventOf(TOURNAMENT, FULLISH_SINGLES)
    expect(event.groups).toHaveLength(1)
    expect(event.groups[0].reservation_id).toBeNull()
    // Every fixture names the event's one (unmapped) group — never `null`, which is
    // what this event's fixtures used to carry before there was a group to name.
    expect(new Set(result.fixtures.map((f) => f.group_id))).toEqual(
      new Set([event.groups[0].id]),
    )
  })

  it('refuses a field too small for its groups — a group of one has nobody to play', () => {
    // ONE reservation (#1482 caps round-robin at one), one entrant: still a group too
    // small to play — the refusal this test is about needs no second or third
    // reservation to reach it.
    patchEvent(TOURNAMENT, EMPTY_SINGLES, {
      draw_type: 'round-robin',
      reservations: [reservationNamed('Reservation A')],
    })
    enterEvent(TOURNAMENT, EMPTY_SINGLES) // one entrant: the dev user

    const result = cutDraw(TOURNAMENT, EMPTY_SINGLES)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(422)
    // The WHOLE sentence, not a fragment: the counts are the message, and both nouns are
    // inflected exactly as `_snake` inflects them ("1 entrant", "1 group"). The mock used
    // to say "1 entrants across N group(s)" — a sentence the API has never said, invisible
    // for as long as every assertion on it was a `toContain` of the tail.
    expect(result.status === 422 && result.detail).toBe(
      '1 entrant across 1 group would leave a group with fewer than 2 entrants, who ' +
        'would have nobody to play.',
    )
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
    expect(cutDraw(TOURNAMENT, mockUuid('ev-nope'))).toEqual({ ok: false, status: 404 })
    expect(uncutDraw('no-such-tournament', mockUuid('ev-nope'))).toEqual({
      ok: false,
      status: 404,
    })
  })
})

// Cutting a SINGLE-ELIMINATION draw (ADR-0785, and ADR 20260726 for why the store may no
// longer refuse it). The store used to answer every non-round-robin cut with "A <type>
// draw cannot be cut yet" — a sentence the CUT route has not been able to say since #785
// (the schedule preview still raises `UnsupportedDrawType` for single-elim, so the string
// is alive on that path — just not this one), and which, with the enum down to the two
// types that run, could only ever fire on this route for a type
// the server cuts perfectly well. A mock that refuses what the server accepts is the same
// trap as one that accepts what the server refuses, pointed the other way: the bracket
// panel would be unreachable in `npm run dev`, in vitest and in the browser at once.
describe('cutting a single-elimination draw', () => {
  beforeEach(() => resetTournamentsStore())

  /** Seeded `single-elim` with SIXTEEN entrants — an exact power of two, so the bracket
   * is full and no seed draws a bye. */
  const BRACKET = FULL_SINGLES
  /** The seed's 9-entrant round-robin, re-typed as a bracket below: **9 is the point** —
   * padded to 16, seven of the top eight seeds draw byes, which is the state that says
   * what a bye actually is. */
  const BYES = INELIGIBLE_SINGLES

  const fixturesOf = (eventId: string) =>
    findTournament(TOURNAMENT)!.events.find((e) => e.id === eventId)!.fixtures

  /** Cut `eventId` and hand back the fixtures, failing loudly on a refusal — so a test
   * that meant to assert about a bracket never quietly asserts about `undefined`. */
  function cut(eventId: string) {
    const result = cutDraw(TOURNAMENT, eventId)
    if (!result.ok) {
      throw new Error(
        `expected a cut, got ${result.status}: ${'detail' in result ? result.detail : ''}`,
      )
    }
    return result.fixtures
  }

  /** Re-type an event as a bracket. The draw type FREEZES while a draw stands
   * (ADR-0786), so the standing round-robin draw comes off first — which is exactly the
   * route a director would take through the UI. */
  function asSingleElim(eventId: string) {
    expect(uncutDraw(TOURNAMENT, eventId).ok).toBe(true)
    const patched = patchEvent(TOURNAMENT, eventId, { draw_type: 'single-elim' })
    if (!patched.ok) throw new Error(`could not re-type ${eventId}`)
  }

  /** The fixtures of one round, in position order. */
  const round = (fixtures: ReturnType<typeof cut>, n: number) =>
    fixtures.filter((f) => f.round === n).sort((a, b) => a.position - b.position)

  const entry = (eventId: string, seed: number) => `entry-${eventId}-${seed}`

  it('cuts a bracket instead of refusing the draw type', () => {
    // The whole chore in one assertion: the seed's single-elim event is CUT, not 422'd.
    const fixtures = cut(BRACKET)
    expect(fixtures.length).toBeGreaterThan(0)
    expect(fixturesOf(BRACKET)).toEqual(fixtures)
  })

  it('emits every round up front, halving each time, all dealt into the stage’s one group', () => {
    const fixtures = cut(BRACKET) // 16 entrants → a 16-slot bracket, 4 rounds

    expect(round(fixtures, 1)).toHaveLength(8)
    expect(round(fixtures, 2)).toHaveLength(4)
    expect(round(fixtures, 3)).toHaveLength(2)
    expect(round(fixtures, 4)).toHaveLength(1)
    expect(fixtures).toHaveLength(15)
    // A single-elim event's one stage holds exactly one group (#1483's floor), and
    // every fixture of its bracket is dealt into it (ADR 20260823, #1484) — never
    // `null`, whatever reservations the event has.
    expect(fixtures[0].group_id).not.toBeNull()
    expect(fixtures.every((f) => f.group_id === fixtures[0].group_id)).toBe(true)
    // `position` is contiguous within a round, and the later rounds are all TBD: nothing
    // is decided at the cut but round 1.
    expect(round(fixtures, 1).map((f) => f.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    for (const later of fixtures.filter((f) => f.round > 1)) {
      expect([later.entry_a_id, later.entry_b_id]).toEqual([null, null])
    }
  })

  it('seats round 1 by the standard recursive seeding, so 1 and 2 can only meet in the final', () => {
    // 1-16, 8-9, 5-12, 4-13, 3-14, 6-11, 7-10, 2-15 (`_seed_slots`, `api/app/draws.py`).
    // The naive wrong deal — 1 v 2, 3 v 4, … — would knock the top two seeds out in
    // round 1 and would still *look* like a bracket, which is why this asserts the
    // pairings rather than the shape.
    const seeded = round(cut(BRACKET), 1).map((f) => [f.entry_a_id, f.entry_b_id])

    expect(seeded).toEqual(
      [
        [1, 16],
        [8, 9],
        [5, 12],
        [4, 13],
        [3, 14],
        [6, 11],
        [7, 10],
        [2, 15],
      ].map(([a, b]) => [entry(BRACKET, a), entry(BRACKET, b)]),
    )
  })

  it('renders a bye as a MISSING round-1 fixture, never a null-sided one', () => {
    asSingleElim(BYES) // 9 entrants, padded to 16 → seven byes

    const fixtures = cut(BYES)

    // Seven of the eight round-1 slots are byes, so seven round-1 rows are simply not
    // there: one fixture, between the only two seeds (8 and 9) that face each other.
    // A planner that emitted a "bye" row with an empty side would give 8 here.
    expect(round(fixtures, 1)).toHaveLength(1)
    expect(round(fixtures, 1)[0]).toMatchObject({
      entry_a_id: entry(BYES, 8),
      entry_b_id: entry(BYES, 9),
    })
    // …and NO round-1 fixture has a null side. `null` means TBD and only TBD, so a
    // null-sided round-1 row would be a fixture waiting on a feeder that cannot exist.
    for (const fixture of round(fixtures, 1)) {
      expect(fixture.entry_a_id).not.toBeNull()
      expect(fixture.entry_b_id).not.toBeNull()
    }
  })

  it('seats a byed seed straight onto its round-2 side, one column along', () => {
    asSingleElim(BYES)

    const two = round(cut(BYES), 2)

    // All three round-2 shapes at once, which is the point of a 9-entrant field:
    //  · one bye + one live feeder  → one side pre-filled, the other TBD;
    //  · both feeders byes          → a fully-known fixture, playable at go-live;
    // (the third — both feeders live, so both sides TBD — needs a fuller bracket and is
    // covered by the 16-entrant case above.)
    expect(two.map((f) => [f.entry_a_id, f.entry_b_id])).toEqual([
      [entry(BYES, 1), null],
      [entry(BYES, 5), entry(BYES, 4)],
      [entry(BYES, 3), entry(BYES, 6)],
      [entry(BYES, 7), entry(BYES, 2)],
    ])
  })

  it('refuses a bracket of fewer than two entrants, in the server’s words', () => {
    // Round-robin's per-group floor, one level up — and the ONLY 422 a single-elim cut
    // makes. Notably NOT a refusal about groups: this store holds none for `ev-u1500`,
    // and a single-elim cut never asks. (On the real server since #1483 a bracket IS
    // dealt into its stage's one group — which is how the scheduler confines it — and
    // that changes nothing here: this refusal is about the FIELD being smaller than two
    // entrants, which no group would fix.)
    const patched = patchEvent(TOURNAMENT, EMPTY_SINGLES, { draw_type: 'single-elim' })
    expect(patched.ok).toBe(true)
    enterEvent(TOURNAMENT, EMPTY_SINGLES) // one entrant: the dev user

    const result = cutDraw(TOURNAMENT, EMPTY_SINGLES)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(422)
    expect(result.status === 422 && result.detail).toContain('at least 2 entrants')
  })

  it('survives a re-cut and an un-cut like any other draw', () => {
    // Nothing about the bracket is random, so the same field cuts the same draw — which
    // is what makes a re-cut a reviewable act rather than a gamble — and the draw is
    // still just fixtures, so removing it empties the event as usual.
    const first = cut(BRACKET)
    expect(cut(BRACKET)).toEqual(first)
    expect(uncutDraw(TOURNAMENT, BRACKET)).toEqual({ ok: true })
    expect(fixturesOf(BRACKET)).toEqual([])
  })
})

// Cutting a ROUND-ROBIN-THEN-KNOCKOUT draw (#1227, ADR "rr-then-ko cuts both stages
// upfront and seeds qualifiers rematch-free"). The format the enum lost in #1219 and got
// back once it had a strategy — and the one whose two stages live in one event, so the
// claims worth pinning are all about the SEAM: that a single cut produces groups *and* a
// bracket, that the bracket is ungrouped (which is what routes it to the bracket view
// rather than into a group's list), and that its rounds restart at 1.
describe('cutting a round-robin-then-knockout draw', () => {
  beforeEach(() => resetTournamentsStore())

  /** Sixteen entrants — enough to deal four groups of four (a full 4-slot bracket) or
   * three of 6/5/5 (a 3-qualifier bracket, where a bye is visible). */
  const TWO_STAGE = FULL_SINGLES

  const eventOf = (eventId: string) =>
    findTournament(TOURNAMENT)!.events.find((e) => e.id === eventId)!

  /** A reservation to ADD: no `id`, which is how a PATCH says "add this one" now that
   * the ids are the server's to mint (ADR 20260801). */
  const reservationNamed = (name: string) => ({ name, slot: SLOT, table_ids: [] })

  /** Re-type an event as two-stage, across `groupCount` groups, taking `qualifiers` out
   * of each. The draw type and the group set both FREEZE while a draw stands (ADR-0786),
   * so any standing draw comes off first — the route a director would take through the
   * UI.
   *
   * The qualifier count is patched **with** the draw type, because that is the only way
   * it can be: the two are one configuration (ADR 20260727), and the server 422s a count
   * that arrives without its type. It defaults to `1` so the cases below that predate it
   * still describe the field they were written for — but it is now genuinely STORED and
   * read back out at the cut, rather than a planner default nobody chose. */
  function asRrThenKo(eventId: string, groupCount: number, qualifiers = 1) {
    expect(uncutDraw(TOURNAMENT, eventId).ok).toBe(true)
    const patched = patchEvent(TOURNAMENT, eventId, {
      draw_type: 'rr-then-ko',
      qualifiers_per_group: qualifiers,
      reservations: Array.from({ length: groupCount }, (_, i) =>
        reservationNamed(`Reservation ${i + 1}`),
      ),
    })
    if (!patched.ok) throw new Error(`could not re-type ${eventId}`)
  }

  /** Cut `eventId`, failing loudly on a refusal — so a test that meant to assert about a
   * two-stage draw never quietly asserts about `undefined`. */
  function cut(eventId: string) {
    const result = cutDraw(TOURNAMENT, eventId)
    if (!result.ok) {
      throw new Error(
        `expected a cut, got ${result.status}: ${'detail' in result ? result.detail : ''}`,
      )
    }
    return result.fixtures
  }

  /** The two stages, split by STAGE (position 1 is `mintStageReads`'s `'s-2'`, the
   * knockout stage) — never by `group_id`, which no longer tells them apart: every
   * fixture of both stages now names a real group (ADR 20260823, #1484), the group
   * stage's own or the knockout stage's own. */
  const knockoutStageIdOf = (eventId: string) =>
    [...eventOf(eventId).stages].sort((a, b) => a.position - b.position)[1]!.id
  const grouped = (fixtures: ReturnType<typeof cut>) =>
    fixtures.filter((f) => f.stage_id !== knockoutStageIdOf(TWO_STAGE))
  const knockout = (fixtures: ReturnType<typeof cut>) =>
    fixtures.filter((f) => f.stage_id === knockoutStageIdOf(TWO_STAGE))

  it('cuts BOTH stages in one stroke — the groups and the whole bracket', () => {
    // Not a convenience (ADR): `advance()` can only ever FILL a side of an existing
    // fixture, never create one, so a bracket that did not exist at the cut could never
    // come into being. The qualifier count is `P × K` = 4 × 1, known before anybody
    // plays, so the bracket's size is settled at cut time.
    asRrThenKo(TWO_STAGE, 4) // 16 entrants → four groups of four

    const fixtures = cut(TWO_STAGE)

    // Four groups of four: C(4,2) = 6 pairs each.
    expect(grouped(fixtures)).toHaveLength(24)
    // Four qualifiers → a 4-slot bracket: two semis and a final.
    expect(knockout(fixtures)).toHaveLength(3)
    // …and the store really kept them — a plan that never landed is not a draw.
    expect(eventOf(TWO_STAGE).fixtures).toEqual(fixtures)
  })

  it('lays the group stage out exactly as a round-robin draw', () => {
    asRrThenKo(TWO_STAGE, 4)

    const stage = grouped(cut(TWO_STAGE))

    // Every fixture names one of THIS event's GROUP-STAGE groups — never the knockout
    // stage's own group (ADR 20260823 mints one there too, but nothing here deals
    // into it: this event's `fixtures` stay group-stage-only for the freeze mechanics
    // this seed exists to cover).
    const groupStageId = [...eventOf(TWO_STAGE).stages].sort(
      (a, b) => a.position - b.position,
    )[0]!.id
    expect(new Set(stage.map((f) => f.group_id))).toEqual(
      new Set(
        eventOf(TWO_STAGE)
          .groups.filter((g) => g.stage_id === groupStageId)
          .map((g) => g.id),
      ),
    )
    // …every pair meets exactly once…
    const pairs = stage.map((f) => [f.entry_a_id, f.entry_b_id].sort().join('|'))
    expect(new Set(pairs).size).toBe(pairs.length)
    // …nobody plays twice in a (group, round), and no group fixture is ever TBD: the
    // group stage is fully known at the cut, unlike the bracket hanging off it.
    for (const fixture of stage) {
      const sameRound = stage.filter(
        (f) => f.group_id === fixture.group_id && f.round === fixture.round,
      )
      const players = sameRound.flatMap((f) => [f.entry_a_id, f.entry_b_id])
      expect(new Set(players).size).toBe(players.length)
      expect(fixture.entry_a_id).not.toBeNull()
      expect(fixture.entry_b_id).not.toBeNull()
    }
  })

  it('gives the knockout stage its OWN group, distinct from the group stage’s, and leaves it entirely TBD', () => {
    asRrThenKo(TWO_STAGE, 4)

    const cutFixtures = cut(TWO_STAGE)
    const bracket = knockout(cutFixtures)
    const stage = grouped(cutFixtures)

    // ADR 20260823, #1484: the knockout stage holds its own group now, never `null` —
    // and never one of the group stage's own group ids either (a knockout fixture
    // sharing an id with a pool fixture would deal it into the wrong stage's join row).
    expect(bracket.length).toBeGreaterThan(0)
    expect(bracket.every((f) => f.group_id !== null)).toBe(true)
    expect(bracket.every((f) => f.group_id === bracket[0].group_id)).toBe(true)
    const groupStageIds = new Set(stage.map((f) => f.group_id))
    expect(groupStageIds.has(bracket[0].group_id)).toBe(false)
    // Nobody has qualified yet, so every side is TBD. A bracket cut with entrants
    // already in it would be seating people the groups have not chosen.
    for (const fixture of bracket) {
      expect([fixture.entry_a_id, fixture.entry_b_id]).toEqual([null, null])
    }
  })

  it('restarts the knockout rounds at 1, rather than continuing the group numbering', () => {
    // Continuing was rejected as ill-defined, not merely ugly (ADR): groups may differ in
    // size, so there is no single "last group round" to offset from. Restarting is also
    // what lets the client's bracket — which names rounds relative to the maximum it is
    // handed — say "Final / Semifinals" with no change at all.
    asRrThenKo(TWO_STAGE, 3) // 16 → groups of 6, 5, 5: the group rounds differ in length

    const fixtures = cut(TWO_STAGE)

    // The longest group runs to round 5, so a continuation would start the bracket at 6.
    expect(Math.max(...grouped(fixtures).map((f) => f.round))).toBe(5)
    expect(
      [...new Set(knockout(fixtures).map((f) => f.round))].sort(),
    ).toEqual([1, 2])
  })

  it('renders a bye as a MISSING round-1 slot, never an extra null-sided row', () => {
    // Three groups taking one qualifier each → three qualifiers in a 4-slot bracket, so
    // the top seed byes. A planner that emitted a "bye" row would give TWO round-1
    // fixtures here; a bye is the ABSENCE of one (ADR-0786), leaving a gap in the
    // position sequence — position 1 is simply not there.
    asRrThenKo(TWO_STAGE, 3)

    const bracket = knockout(cut(TWO_STAGE))
    const roundOne = bracket.filter((f) => f.round === 1)

    expect(roundOne).toHaveLength(1)
    expect(roundOne[0].position).toBe(2)
    expect(bracket.filter((f) => f.round === 2)).toHaveLength(1)
  })

  it('refuses a single group taking a single qualifier, in the server’s words', () => {
    // The one `P × K < 2` shape reachable at all (`K ≥ 1` is a bound at the request
    // boundary, and the snake guarantees `P ≥ 1`): one group, one qualifier, one player
    // alone in the knockout stage.
    asRrThenKo(TWO_STAGE, 1)

    const result = cutDraw(TOURNAMENT, TWO_STAGE)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(422)
    expect(result.status === 422 && result.detail).toContain(
      'leaves one player in the knockout stage',
    )
  })

  it('makes the GROUP stage’s refusals first, in round-robin’s own words', () => {
    // The server runs `_snake` before it consults the qualifier count at all, so an
    // rr-then-ko event with no reservations is refused with the sentence about a
    // *round-robin* draw. That reads oddly and is right: the group stage of an
    // rr-then-ko draw IS a round-robin, and inventing a second wording would put a
    // sentence in the server's mouth it never says.
    const patched = patchEvent(TOURNAMENT, EMPTY_SINGLES, {
      draw_type: 'rr-then-ko',
      reservations: [],
    })
    expect(patched.ok).toBe(true)

    const result = cutDraw(TOURNAMENT, EMPTY_SINGLES)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status === 422 && result.detail).toContain('at least one group')
  })

  /**
   * **The store's K reaches the planner** (ADR 20260727) — the seam that was missing, and
   * the reason the count had to be stored at all.
   *
   * ⚠️ This is the *silent* mismatch, which is why it needs pinning by size rather than
   * by an error: a count substituted on the way to `planDraw` cuts a perfectly well-formed
   * bracket — just one sized for a K nobody chose. Nothing throws, nothing warns, and
   * `npm run dev` and vitest both look healthy while an event configured at K=2 runs a
   * K=1 knockout. (The planner having no default is what makes *dropping* the argument a
   * type error; this pins the value that actually arrives.)
   *
   * Two groups of sixteen entrants, so the two candidate brackets are unmistakably
   * different: `P × K` = 2 × 2 = 4 slots (2 semis + 1 final = **3** fixtures) against the
   * default's 2 × 1 = 2 slots (**1** fixture).
   */
  it('cuts the bracket from the event’s OWN qualifier count, not the planner’s default', () => {
    asRrThenKo(TWO_STAGE, 2, 2)

    const bracket = knockout(cut(TWO_STAGE))

    // 4 qualifiers → two semifinals and a final. A K=1 fallback would give exactly 1.
    expect(bracket).toHaveLength(3)
    expect(bracket.filter((f) => f.round === 1)).toHaveLength(2)
  })

  it('keeps the count on the stored event, so a re-read still knows it', () => {
    asRrThenKo(TWO_STAGE, 2, 2)

    // Not merely accepted by the PATCH — actually held, which is what the *next* cut
    // (and the editor re-opening on this event) reads.
    expect(eventOf(TWO_STAGE).qualifiers_per_group).toBe(2)
  })

  // The pair moves together (ADR 20260727): a draw type with no knockout stage has no
  // count, so re-typing away from rr-then-ko must not strand the old K on the event —
  // that is a configuration the server's tagged union cannot even represent.
  it('clears the count when the event is re-typed to a format with no knockout stage', () => {
    asRrThenKo(TWO_STAGE, 2, 2)
    expect(uncutDraw(TOURNAMENT, TWO_STAGE).ok).toBe(true)

    // #1482: round-robin holds at most one reservation, so the same PATCH that drops
    // the type also has to leave the event at one — the claim under test here
    // (`qualifiers_per_group` clearing) is independent of that count either way.
    const patched = patchEvent(TOURNAMENT, TWO_STAGE, {
      draw_type: 'round-robin',
      reservations: [reservationNamed('Reservation 1')],
    })

    expect(patched.ok).toBe(true)
    expect(eventOf(TWO_STAGE).qualifiers_per_group).toBeNull()
  })

  it('survives a re-cut and an un-cut like any other draw', () => {
    asRrThenKo(TWO_STAGE, 4)

    const first = cut(TWO_STAGE)
    // Nothing about either stage is random, so the same field cuts the same draw —
    // bracket included, because its shape is a pure function of `P × K`.
    expect(cut(TWO_STAGE)).toEqual(first)
    expect(uncutDraw(TOURNAMENT, TWO_STAGE)).toEqual({ ok: true })
    // Both stages go: a draw is just fixtures, whichever stage they belong to.
    expect(eventOf(TWO_STAGE).fixtures).toEqual([])
  })
})

// The qualifier count as a PARAMETER of the rr-then-ko planner. The store now stores it
// and passes it in (see "cuts the bracket from the event's OWN qualifier count" above),
// so the seam is covered end to end; these stay because they exercise `planDraw` directly
// at counts the store's fixtures would need contorting to reach, and because the two
// refusals that depend on K read most clearly next to the arithmetic that produces them.
describe('planDraw, rr-then-ko, with a qualifier count', () => {
  const entrants = (n: number) => Array.from({ length: n }, (_, i) => `entry-${i + 1}`)
  const groups = (n: number) => Array.from({ length: n }, (_, i) => `grp-${i + 1}`)

  it('takes group winners only at K = 1 — the smallest legal count', () => {
    // 8 entrants across 2 groups of 4, K = 1, so 2 qualifiers meet in a one-fixture
    // bracket. The count is passed explicitly like every other: the planner has no
    // default, so "group winners only" is a configuration, never an omission.
    const plan = planDraw('rr-then-ko', entrants(8), groups(2), 1, null)

    if (!plan.ok) throw new Error(`expected a plan, got: ${plan.detail}`)
    // `'s-2'` — `mintStageReads('rr-then-ko')`'s knockout stage, the default `planDraw`
    // cuts against here (no real event's `stages` was passed). Never `group_id ===
    // null`: the knockout stage holds its own group now too (ADR 20260823, #1484).
    expect(plan.fixtures.filter((f) => f.stage_id === 's-2')).toHaveLength(1)
  })

  it('sizes the bracket from P × K — derived, never configured', () => {
    // 2 groups × 3 qualifiers = 6, padded to an 8-slot bracket: 7 slots, of which the two
    // byed seeds' round-1 rows are absent → 2 round-1 + 2 semis + 1 final.
    const plan = planDraw('rr-then-ko', entrants(12), groups(2), 3, null)

    if (!plan.ok) throw new Error(`expected a plan, got: ${plan.detail}`)
    expect(plan.fixtures.filter((f) => f.stage_id === 's-2')).toHaveLength(5)
  })

  it('refuses taking more qualifiers than the smallest group holds', () => {
    // 9 entrants across 2 groups → 5 and 4; taking 5 from each is more than the 4 the
    // smaller group has, and the sentence names both numbers.
    const plan = planDraw('rr-then-ko', entrants(9), groups(2), 5, null)

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.detail).toBe(
      'Taking 5 qualifiers from each group is more than the 4 entrants in the ' +
        'smallest group — take fewer qualifiers from each group, or add entrants.',
    )
  })

  it('allows a ONE-GROUP draw once more than one player qualifies', () => {
    // "League, then a playoff" is a real format (ADR), and so is K = ⌊N/P⌋, where
    // everyone qualifies and the group stage exists purely to seed.
    const plan = planDraw('rr-then-ko', entrants(4), groups(1), 4, null)

    if (!plan.ok) throw new Error(`expected a plan, got: ${plan.detail}`)
    expect(plan.fixtures.filter((f) => f.stage_id === 's-2')).toHaveLength(3)
  })
})

/**
 * The **swiss** arm of the planner (ADR "swiss pre-cuts every round and pairs each one on
 * advance"). What it has to get right is the shape the ADR chose, and it is a shape that
 * looks broken until you know the reason: **all `R` rounds are written at the cut**, and
 * every round past the first has both sides `null`. That is not a stub — with the field
 * frozen at the cut and `R` an explicit setting, the number of fixtures is fully
 * determined and only the sides are unknown, which is the one state `advance()` has always
 * handled.
 *
 * The mock's job is to cut exactly what the server cuts, empty rounds included, so a
 * director in `npm run dev` sees the same draw a director on the real API does.
 */
describe('planDraw, swiss', () => {
  const entrants = (n: number) => Array.from({ length: n }, (_, i) => `entry-${i + 1}`)

  it('writes every round up front — R × ⌊n/2⌋ fixtures', () => {
    // 8 entrants, 3 rounds → 4 pairings per round, 12 fixtures. A planner that wrote only
    // round 1 (the "we will create them as we go" reading the ADR rejects) gives 4.
    const plan = planDraw('swiss', entrants(8), [], null, 3)

    if (!plan.ok) throw new Error(`expected a plan, got: ${plan.detail}`)
    expect(plan.fixtures).toHaveLength(12)
    expect(plan.fixtures.map((f) => f.round)).toEqual([
      1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
    ])
  })

  it('pairs ONLY round 1, top half against bottom half, and leaves the rest TBD', () => {
    const plan = planDraw('swiss', entrants(8), [], null, 3)

    if (!plan.ok) throw new Error(`expected a plan, got: ${plan.detail}`)
    // Draw-order index `i` meets index `i + ⌊n/2⌋`: seed 1 meets seed 5, not seed 2 (a
    // consecutive pairing) and not seed 8 (a bracket's 1-v-N).
    expect(
      plan.fixtures
        .filter((f) => f.round === 1)
        .map((f) => [f.entry_a_id, f.entry_b_id]),
    ).toEqual([
      ['entry-1', 'entry-5'],
      ['entry-2', 'entry-6'],
      ['entry-3', 'entry-7'],
      ['entry-4', 'entry-8'],
    ])
    // Every later round is genuinely unpaired — `advance()` fills it once the round before
    // it is decided. A planner that seeded them all the same way would look identical on
    // round 1 and be wrong everywhere else.
    expect(
      plan.fixtures
        .filter((f) => f.round > 1)
        .every((f) => f.entry_a_id === null && f.entry_b_id === null),
    ).toBe(true)
  })

  it('deals every fixture into ONE group, never partitioned across the list it is handed', () => {
    // Swiss ranks the whole field in one table — the event's groups are not CONSULTED
    // as a partition, exactly as on the server. But since ADR 20260823 (#1484) a swiss
    // event's one stage still holds exactly one group (#1483's floor), and every
    // fixture is dealt into it: `groupIds[0]`, never `groupIds[1]` — two ids reaching
    // here is not a shape the real store ever produces (#1482 caps a swiss event at
    // one reservation), but proves the arm reads only the first regardless.
    const plan = planDraw('swiss', entrants(8), ['grp-1', 'grp-2'], null, 2)

    if (!plan.ok) throw new Error(`expected a plan, got: ${plan.detail}`)
    expect(plan.fixtures.every((f) => f.group_id === 'grp-1')).toBe(true)
  })

  it('byes the LOWEST-ranked entrant on an odd field, by leaving them out of every round', () => {
    // 7 entrants → 3 pairings per round, and `entry-7` sits in no fixture. A bye is the
    // ABSENCE of a row (ADR-0786), never a row with a null side — which here would be
    // indistinguishable from a later round awaiting its pairing.
    const plan = planDraw('swiss', entrants(7), [], null, 2)

    if (!plan.ok) throw new Error(`expected a plan, got: ${plan.detail}`)
    expect(plan.fixtures).toHaveLength(6)
    const seated = plan.fixtures
      .filter((f) => f.round === 1)
      .flatMap((f) => [f.entry_a_id, f.entry_b_id])
    expect(seated).toEqual([
      'entry-1',
      'entry-4',
      'entry-2',
      'entry-5',
      'entry-3',
      'entry-6',
    ])
    expect(seated).not.toContain('entry-7')
  })

  it('refuses a field of one, in the server’s own words', () => {
    const plan = planDraw('swiss', entrants(1), [], null, 1)

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.detail).toBe(
      'A Swiss draw needs at least 2 entrants — a smaller field has nobody to play.',
    )
  })

  /**
   * `R > n - 1 + n % 2` is refused at the **cut**, not at configure time: `n` is not known
   * when the setting is written, so a round count that was legal when the director typed it
   * must not become unwritable when somebody withdraws. This is the sentence the API raises
   * (`SwissStrategy.plan_initial`), copied verbatim — a paraphrase here would go green
   * against words the server never says.
   */
  it('refuses more rounds than the field can play rematch-free, naming both numbers', () => {
    const plan = planDraw('swiss', entrants(5), [], null, 9)

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.detail).toBe(
      '9 rounds is more than the 5 rounds a field of 5 entrants can play without a ' +
        'rematch — play fewer rounds, or add entrants.',
    )
  })

  /**
   * ⚠️ **The discriminating case for the ceiling.** An ODD field byes one entrant a round,
   * so over `n` rounds everybody plays `n - 1` matches and sits out once: five entrants can
   * play five rounds with no rematch. The old bound was `n - 1` for every field and refused
   * this — a legal swiss, turned away.
   */
  it('accepts an odd field’s n-th round', () => {
    const plan = planDraw('swiss', entrants(5), [], null, 5)

    if (!plan.ok) throw new Error(`expected a plan, got: ${plan.detail}`)
    // `R × ⌊n/2⌋` — five rounds of two pairings, the fifth entrant sitting each one out.
    expect(plan.fixtures).toHaveLength(10)
  })

  /** The other half of the same claim, and the reason the bound is `n - 1 + n % 2` rather
   * than `n`: an EVEN field byes nobody, so it still stops at `n - 1`. Without this, a
   * ceiling read as "a field can play `n` rounds" passes every case above. */
  it('still refuses an even field’s n-th round', () => {
    const plan = planDraw('swiss', entrants(6), [], null, 6)

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.detail).toBe(
      '6 rounds is more than the 5 rounds a field of 6 entrants can play without a ' +
        'rematch — play fewer rounds, or add entrants.',
    )
  })

  // Singular/plural, because the message is read by a person. Two rounds against a field of
  // two is the only shape that reaches both nouns at once.
  it('inflects the sentence for a single round of ceiling', () => {
    const plan = planDraw('swiss', entrants(2), [], null, 2)

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.detail).toBe(
      '2 rounds is more than the 1 round a field of 2 entrants can play without a ' +
        'rematch — play fewer rounds, or add entrants.',
    )
  })

  /** NOT a refusal and NOT a default: the write boundary requires `rounds` with no default
   * on the swiss arm, so the column is never NULL for this draw type. A stub that arrived
   * here has been seeded into a shape the API cannot hold, and it says so rather than
   * quietly cutting a one-round event. */
  it('throws — never substitutes — when a swiss event has no round count', () => {
    expect(() => planDraw('swiss', entrants(8), [], null, null)).toThrow(
      /has no rounds/,
    )
  })
})

// The DRAW-TYPE CATALOGUE (ADR 20260726) — the `draw_types` table, served on the page
// that picks one. It is served rather than hardcoded client-side precisely so that "the
// table gates what a director can pick" is a fact about the running system; a mock that
// withheld it would leave the picker's only data source unreachable.
describe('the draw-type catalogue', () => {
  beforeEach(() => resetTournamentsStore())

  it('carries every draw type the server can run, in display order, on the DETAIL read', () => {
    const catalogue = findTournament(TOURNAMENT)!.draw_type_catalogue

    expect(catalogue).toEqual(DRAW_TYPE_CATALOGUE)
    // A row exists exactly when the type has an implementation, so the keys are the
    // members of `DrawType` — every one of which `cutDraw` above can now plan.
    expect(catalogue!.map((d) => d.key)).toEqual([
      'round-robin',
      'single-elim',
      'rr-then-ko',
      'swiss',
    ])
    expect(catalogue!.map((d) => d.display_order)).toEqual([1, 2, 3, 4])
    // The copy is what a director reads while choosing; neither field is ever empty.
    for (const drawType of catalogue!) {
      expect(drawType.name.length).toBeGreaterThan(0)
      expect(drawType.description.length).toBeGreaterThan(0)
    }
  })

  it('is NULL on the list — a catalogue is page data, not a property of a row', () => {
    // `null`, never `[]`: an empty array would say the server can run no draw types at
    // all, which is a different and false claim.
    for (const listed of listTournaments()) {
      expect(listed.draw_type_catalogue).toBeNull()
    }
  })
})

// The group-set FREEZE (ADR-0786): while a draw exists, an event's reservations may
// change in every way except the identity of the group each one mints, 1:1. A fixture
// names the group it was dealt into, and removing that group's reservation leaves the
// fixture pointing at nothing — a refusal the composite foreign key under
// `tournament_fixtures` would also make since ADR 20260801, but only at COMMIT and only
// as a driver error, so the procedure is here (and there) to answer it as a 409 that
// names the groups and the way out.
//
// **The freeze shrank when the ids were minted.** Re-identifying a reservation is not
// one of the things it refuses any more, because it is not a payload a client can send:
// an entry either cites an id this event has or carries none at all.
describe('the group set freezes while a draw exists', () => {
  beforeEach(() => resetTournamentsStore())

  // #1482: `rr-then-ko` is the one draw type the reservation cap does not apply to,
  // so it is where this suite's multi-reservation coverage now lives — `ev-u1200`
  // itself holds only one now.
  const TWO_STAGE = mockUuid('ev-two-stage-cut')
  const reservationsOf = (eventId: string) =>
    findTournament(TOURNAMENT)!.events.find((e) => e.id === eventId)!.reservations

  /** A stored reservation as a PATCH cites it: the id it was minted, and the words. The
   * read shape's `position` is deliberately dropped — `ReservationUpsert` is
   * `extra="forbid"`, so a payload carrying one is a 422 at the server's boundary. */
  const citing = (reservation: ReturnType<typeof reservationsOf>[number]) => ({
    id: reservation.id,
    name: reservation.name,
    slot: reservation.slot,
    table_ids: reservation.table_ids,
  })

  it('refuses a PATCH that removes a reservation whose group the draw was dealt across', () => {
    const [reservationA] = reservationsOf(TWO_STAGE)

    const result = patchEvent(TOURNAMENT, TWO_STAGE, {
      reservations: [citing(reservationA)],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    if (result.status !== 409) return
    // The refusal NAMES the group that would go, because a director looking at a page of
    // named reservations cannot act on "a group".
    expect(result.detail).toContain('“Group B”')
    expect(result.detail).toContain('already has fixtures drawn into it')
    // The sentence ends with the way OUT — remove the draw, change the reservations, cut
    // again — because a refusal a director cannot act on is just a wall.
    expect(result.detail).toContain('remove the draw first')
    // …and the reservations are untouched: a refused write writes nothing.
    expect(reservationsOf(TWO_STAGE)).toHaveLength(2)
  })

  // An added group is COUNTED, not named: it has no position yet, and the label it
  // would land on is one an existing group wears today (see the collision test below).
  it('refuses a PATCH that ADDS a reservation — the arriving group is counted, not named', () => {
    const reservations = reservationsOf(TWO_STAGE)

    const result = patchEvent(TOURNAMENT, TWO_STAGE, {
      // No `id`: that IS the addition, now that a client cannot author one.
      reservations: [
        ...reservations.map(citing),
        { name: 'Reservation C', slot: SLOT, table_ids: [] },
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok || result.status !== 409) throw new Error('expected a 409')
    expect(result.detail).toContain('1 new group would arrive with no fixtures in it')
    expect(result.detail).not.toContain('“Group C”')
    expect(reservationsOf(TWO_STAGE)).toHaveLength(2)
  })

  // The collision the naming bug produced: replacing the FIRST reservation removes the
  // group at position 0 and adds one that would land at position 0 too — so naming both
  // sides by their derived position reported "Group A already has fixtures drawn into
  // it; and Group A would arrive with no fixtures in it", the same label simultaneously
  // departing and arriving. The added side is counted now, so no label can appear on
  // both sides of the "; and " join.
  it('refuses a PATCH that replaces the FIRST reservation — no label departs and arrives at once', () => {
    const [reservationA, reservationB] = reservationsOf(TWO_STAGE)

    const result = patchEvent(TOURNAMENT, TWO_STAGE, {
      reservations: [
        { name: 'Reservation A (new)', slot: SLOT, table_ids: [] },
        citing(reservationB),
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok || result.status !== 409) throw new Error('expected a 409')
    expect(result.detail).toContain('“Group A”')
    expect(result.detail).toContain('1 new group would arrive with no fixtures in it')
    const [departing, arriving] = result.detail.split('; and ')
    for (const label of departing.match(/Group [A-Z]+/g) ?? []) {
      expect(arriving).not.toContain(label)
    }
    expect(reservationsOf(TWO_STAGE)).toEqual([reservationA, reservationB])
  })

  // Only the GROUP's identity is frozen. A reservation's tables and its window stay
  // editable with a draw standing, on purpose: venues change under running tournaments
  // (a table breaks, a table frees up), and a director who cannot record that would have
  // to un-cut a draw that is *correct*.
  it('ALLOWS a venue edit — same reservation ids, new tables and a new window', () => {
    const reservations = reservationsOf(TWO_STAGE)

    const result = patchEvent(TOURNAMENT, TWO_STAGE, {
      reservations: reservations.map((r) => ({
        ...citing(r),
        name: `${r.name} (moved)`,
        table_ids: ['t9'],
        slot: SLOT,
      })),
    })

    expect(result.ok).toBe(true)
    expect(reservationsOf(TWO_STAGE)[0].table_ids).toEqual(['t9'])
    // The ids — and therefore every fixture drawn into their mapped groups — survived
    // the edit.
    expect(reservationsOf(TWO_STAGE).map((r) => r.id)).toEqual(
      reservations.map((r) => r.id),
    )
  })

  // …and a REORDER of the same reservations is the same thing: the group set is
  // unchanged, so the freeze has nothing to say, and the positions follow the payload's
  // order.
  it('ALLOWS a reorder of exactly the reservations the draw was cut across', () => {
    const [reservationA, reservationB] = reservationsOf(TWO_STAGE)

    const result = patchEvent(TOURNAMENT, TWO_STAGE, {
      reservations: [citing(reservationB), citing(reservationA)],
    })

    expect(result.ok).toBe(true)
    expect(reservationsOf(TWO_STAGE).map((r) => r.id)).toEqual([
      reservationB.id,
      reservationA.id,
    ])
    expect(reservationsOf(TWO_STAGE).map((r) => r.position)).toEqual([0, 1])
  })

  it('leaves an UNDRAWN event’s reservations wholesale-replaceable, as they have always been', () => {
    const result = patchEvent(TOURNAMENT, EMPTY_SINGLES, {
      reservations: [{ name: 'A', slot: SLOT, table_ids: [] }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The PATCH path mints too: an entry with no `id` is an addition, and the store hands
    // it a uuid exactly as `gen_random_uuid()` would. Without this the reservation would
    // come back id-less — and every fixture later dealt into its group would name nothing.
    expect(result.event.reservations).toHaveLength(1)
    expect(result.event.reservations[0].id).toMatch(UUID)
  })

  it('un-freezes the moment the draw is removed', () => {
    const before = reservationsOf(TWO_STAGE).map((r) => r.id)
    expect(uncutDraw(TOURNAMENT, TWO_STAGE).ok).toBe(true)

    const result = patchEvent(TOURNAMENT, TWO_STAGE, {
      reservations: [{ name: 'Reservation A', slot: SLOT, table_ids: [] }],
    })

    expect(result.ok).toBe(true)
    const after = reservationsOf(TWO_STAGE)
    expect(after).toHaveLength(1)
    // A brand-new reservation, with a brand-new id: the two the draw was cut across
    // (via their mapped groups) are gone, and this one was MINTED rather than named by
    // the payload.
    expect(before).not.toContain(after[0].id)
  })
})

// The diff's own refusal (ADR 20260801), and the reason it exists: a reservation id is
// minted here, so an id the store never minted names nothing. Quietly minting a
// reservation for it would hand the client back a different id than it asked for while
// *removing* the reservation it meant to keep — the two failures a diff must never
// confuse.
describe('a reservations PATCH citing an id the event does not have', () => {
  beforeEach(() => resetTournamentsStore())

  // #1482: `rr-then-ko`, so a cut draw can still stand here to exercise the freeze
  // ordering below regardless of the reservation cap.
  const TWO_STAGE = mockUuid('ev-two-stage-cut') // seeded WITH a draw
  const eventOf = (eventId: string) =>
    findTournament(TOURNAMENT)!.events.find((e) => e.id === eventId)!

  const UNKNOWN = '11111111-2222-4333-8444-555555555555'

  it('is a 422 naming the entry, and writes nothing', () => {
    const before = eventOf(EMPTY_SINGLES).reservations

    // ONE entry, citing the unknown id — #1482 caps EMPTY_SINGLES (round-robin) at
    // one reservation, so a second entry here would trip that cap instead of the
    // refusal this test is about.
    const result = patchEvent(TOURNAMENT, EMPTY_SINGLES, {
      reservations: [{ id: UNKNOWN, name: 'Reservation B', slot: SLOT, table_ids: [] }],
    })

    expect(result.ok).toBe(false)
    if (result.ok || result.status !== 422 || 'reservationCapExceeded' in result) {
      throw new Error('expected the per-entry 422')
    }
    // The index is what lets the handler build `loc: ["body","reservations",0,"id"]` —
    // the reservations are a list, and a refusal a client cannot attribute to a row it
    // cannot render.
    expect(result.index).toBe(0)
    expect(result.reservationId).toBe(UNKNOWN)
    expect(result.detail).toBe('This event has no reservation with that id.')
    // Judged BEFORE anything is assigned.
    expect(eventOf(EMPTY_SINGLES).reservations).toEqual(before)
  })

  // The ordering the server states out loud: the freeze runs first, so a cut event
  // answers the 409 that names its groups rather than this 422. A cited-but-unknown id
  // is an addition as far as a standing draw is concerned.
  it('loses to the group-set freeze on an event whose draw is cut', () => {
    const result = patchEvent(TOURNAMENT, TWO_STAGE, {
      reservations: [{ id: UNKNOWN, name: 'Reservation Z', slot: SLOT, table_ids: [] }],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
  })
})

// The group-set freeze's SIBLING (ADR-0786): the other fact a cut draw froze. The mock
// enforces it for the same reason it enforces the group set — a mock more permissive
// than the server it stands in for is a trap, and the UI built against it would look
// perfect in `npm run dev` and 409 in production.
describe('the draw type freezes while a draw exists', () => {
  beforeEach(() => resetTournamentsStore())

  // #1482: `rr-then-ko`, the one draw type the reservation cap does not apply to, so
  // this block's own multi-reservation cases keep working undisturbed by it.
  const TWO_STAGE = mockUuid('ev-two-stage-cut')
  const eventOf = (eventId: string) =>
    findTournament(TOURNAMENT)!.events.find((e) => e.id === eventId)!

  it('refuses a PATCH that re-labels the draw type of a cut draw', () => {
    const result = patchEvent(TOURNAMENT, TWO_STAGE, {
      draw_type: 'single-elim',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    // The way out, named in the refusal — otherwise the director is stuck with an event
    // whose type they cannot change and whose fixtures they were never told to remove.
    // (It is not that the target type is unplannable: `single-elim` has had a generator
    // since #785, and since ADR 20260726 every member of the enum does. The freeze is
    // about the fixtures already dealt AS this draw type.)
    expect(result.status === 409 && result.detail).toContain('remove the draw')
    // A refused write writes nothing.
    expect(eventOf(TWO_STAGE).draw_type).toBe('rr-then-ko')
  })

  // ⚠️ The one that keeps the freeze from eating the edits it exists to permit. The
  // editor PATCHes the WHOLE form back — draw type included — to move a reservation's
  // tables. A guard that fired on the mere *presence* of `draw_type` would refuse that,
  // and the reservations editor would be unusable against a server that allows it.
  it('ALLOWS a PATCH that re-sends the SAME draw type (the whole-form save)', () => {
    const result = patchEvent(TOURNAMENT, TWO_STAGE, {
      draw_type: 'rr-then-ko',
      reservations: eventOf(TWO_STAGE).reservations.map((r) => ({
        ...r,
        table_ids: ['t9'],
      })),
    })

    expect(result.ok).toBe(true)
    expect(eventOf(TWO_STAGE).reservations[0].table_ids).toEqual(['t9'])
  })

  it('leaves an UNDRAWN event’s draw type free to change', () => {
    const result = patchEvent(TOURNAMENT, EMPTY_SINGLES, {
      draw_type: 'round-robin',
    })

    expect(result.ok).toBe(true)
    expect(eventOf(EMPTY_SINGLES).draw_type).toBe('round-robin')
  })

  it('un-freezes the moment the draw is removed', () => {
    expect(uncutDraw(TOURNAMENT, TWO_STAGE).ok).toBe(true)

    // #1482: `single-elim` holds at most one reservation, so the same PATCH that lifts
    // the type also has to leave it at one — exactly what a director flipping types
    // after un-cutting a two-reservation draw would send in one save.
    const result = patchEvent(TOURNAMENT, TWO_STAGE, {
      draw_type: 'single-elim',
      reservations: [{ name: 'Reservation A', slot: SLOT, table_ids: [] }],
    })

    expect(result.ok).toBe(true)
    expect(eventOf(TWO_STAGE).draw_type).toBe('single-elim')
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
    // Summer Slam: one drawn round-robin event, ONE reservation (#1482) across all
    // four tables (t1-t4), all from 09:00. LIVE, so the apply may promise.
    placeInStatus(DRAFT_TOURNAMENT, 'live')

    const detail = solveToCompletion(DRAFT_TOURNAMENT)

    const fixtures = detail.events.flatMap((e) => e.fixtures)
    const called = fixtures.filter((f) => f.pinned_at !== null)
    // The first wave — one fixture per table at the window's start — is inside the
    // call-ahead window; everything later is not. Four tables, all starting together
    // now that the reservation is one (#1482).
    expect(called).toHaveLength(4)
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
      fixtures_pinned: 4,
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
    expect(called).toHaveLength(4)
    // Still exactly one notification each: the pass skips pinned fixtures, so a
    // re-solve cannot quietly spend the players' attention twice.
    expect(called.every((f) => f.call_notified_count === 1)).toBe(true)
  })
})

// The venue on a WRITE. A tournament may have none at all (CONTEXT.md, "Venue"),
// and the server settles what that looks like on the wire at its own boundary
// (`SubmittedAddress`): omitted, `null`, and an object whose six components are all
// blank are ONE state — no venue — and none of them reaches the geocoder.
//
// The mock has to agree, in both directions. More permissive and `npm run dev`
// would store a blank address and pin it in Berkeley; less permissive and clearing
// the venue boxes would look like a bug in the form.
describe('the venue on a create/update', () => {
  beforeEach(() => resetTournamentsStore())

  const venue = {
    venue: 'Oakland Arena',
    street: '7000 Coliseum Way',
    city: 'Oakland',
    region: 'CA',
    postal: '94621',
    country: 'USA',
  }
  const blank = {
    venue: '',
    street: '',
    city: '',
    region: '',
    postal: '',
    country: '',
  }

  const create = (address: typeof venue | null | undefined) =>
    createTournament({
      name: 'Written Cup',
      description: null,
      address,
      table_catalogue: [],
    })

  it('creates with NO VENUE from an omitted, a null, and an all-blank address', () => {
    expect(findTournament(create(undefined).id)!.address).toBeNull()
    expect(findTournament(create(null).id)!.address).toBeNull()
    expect(findTournament(create(blank).id)!.address).toBeNull()
  })

  // The positive control: the same path with a real address still geocodes and
  // stores one, so the three nulls above are about the venue and not about a
  // create that quietly stopped recording addresses.
  it('creates WITH a venue — geocoded, as the server does at write time', () => {
    const created = create(venue)

    expect(findTournament(created.id)!.address).toMatchObject({
      venue: 'Oakland Arena',
      latitude: expect.any(Number),
      longitude: expect.any(Number),
    })
  })

  it('REMOVES the venue on a patch of null, and on a patch of six blanks', () => {
    const withVenue = create(venue)
    expect(updateTournament(withVenue.id, { details_version: 1, address: null }).ok).toBe(true)
    expect(findTournament(withVenue.id)!.address).toBeNull()

    const alsoWithVenue = create(venue)
    expect(updateTournament(alsoWithVenue.id, { details_version: 1, address: blank }).ok).toBe(true)
    expect(findTournament(alsoWithVenue.id)!.address).toBeNull()
  })

  // Omitted is NOT removed. The two are different edits on the server
  // (`TournamentUpdate`: absent means unchanged), so a patch of some other field
  // must leave the venue exactly where it was.
  it('leaves the venue alone when the patch does not mention it', () => {
    const created = create(venue)

    expect(updateTournament(created.id, { details_version: 1, name: 'Renamed Cup' }).ok).toBe(true)

    expect(findTournament(created.id)!.address).toMatchObject({
      venue: 'Oakland Arena',
    })
  })

  it('gives a venue-less tournament one when the organizer finally books it', () => {
    const created = create(null)

    expect(updateTournament(created.id, { details_version: 1, address: venue }).ok).toBe(true)

    expect(findTournament(created.id)!.address).toMatchObject({
      venue: 'Oakland Arena',
    })
  })
})

// ----- the seeded TWO-STAGE events (ADR 20260727) --------------------------------
//
// `rr-then-ko` reads out as the results union's THIRD arm,
// `kind: "standings_then_finishes"` — one standings block per group plus the bracket's
// finishes — and this store derives none of it: every seeded event hardcodes its own
// `results`, and `cutDraw` never writes one. So the shape exists in `npm run dev` and in
// vitest only because the seed spells it out, and a hand-written block with nothing
// checking it is a block whose arithmetic rots the first time somebody edits a row.
//
// These are the checks that stop that. Each one is a claim the server really makes and
// that slice 4c's rendering leans on:
//
//   - the champion is the **bracket final's winner** — never a group leader, because the
//     group stage only seeds the bracket (topping a group wins nothing);
//   - the finishes follow single-elimination's own placement shape
//     (`2 ** (final_round − round) + 1`), so same-round losers SHARE a position;
//   - each group's standings add up across that group's own fixtures;
//   - `complete` is **both** stages decided, not either.
//
// They are asserted against the STORE, not through `apiToTournament`: `parseResults` does
// not know this `kind` yet (that is 4c), and the seed's honesty is a fact about the
// payload regardless of who can currently read it.
describe('the seeded two-stage (rr-then-ko) events', () => {
  beforeEach(() => resetTournamentsStore())

  const GOLDEN_STATE = GOLDEN_STATE_CLASSIC_ID
  const FINISHED = mockUuid('ev-challenge-cup') // groups decided, bracket decided, champion crowned
  const MID_FLIGHT = mockUuid('ev-shield') // groups decided, the final still to be played

  type Fixture = components['schemas']['TournamentFixtureRead']
  type TwoStageResults =
    components['schemas']['StandingsThenFinishesResultsRead']

  const eventOf = (eventId: string) =>
    findTournament(GOLDEN_STATE)!.events.find((e) => e.id === eventId)!

  /** The event's results, having first asserted they really are the two-stage arm — so
   * every check below is reading the shape it claims to read. */
  function resultsOf(eventId: string): TwoStageResults {
    const results = eventOf(eventId).results
    expect(results?.kind).toBe('standings_then_finishes')
    return results as TwoStageResults
  }

  /** The knockout stage's own fixtures — its STAGE (position 1, `mintStageReads`'s
   * `'s-2'` for an `rr-then-ko` event) is what tells the two stages apart, never a
   * null `group_id` (ADR 20260823, #1484: every fixture, including the bracket's,
   * names a real group now — the group its own stage holds). */
  const bracketOf = (eventId: string): Fixture[] => {
    const event = eventOf(eventId)
    const knockoutStageId = [...event.stages].sort(
      (a, b) => a.position - b.position,
    )[1]?.id
    return event.fixtures.filter((f) => f.stage_id === knockoutStageId)
  }

  /** The FINAL — the single fixture in the bracket's last round. Its winner is the
   * event's champion, and `null` there is why an unfinished event has none. */
  function finalOf(eventId: string): Fixture {
    const bracket = bracketOf(eventId)
    const lastRound = Math.max(...bracket.map((f) => f.round))
    const final = bracket.filter((f) => f.round === lastRound)
    expect(final).toHaveLength(1)
    return final[0]
  }

  /** Wins and losses per entry, counted off a group's FIXTURES — the independent reading
   * the hardcoded standings block is checked against. */
  function recordFromFixtures(fixtures: Fixture[]) {
    const record = new Map<string, { wins: number; losses: number }>()
    const bump = (id: string, key: 'wins' | 'losses') => {
      const row = record.get(id) ?? { wins: 0, losses: 0 }
      row[key] += 1
      record.set(id, row)
    }
    for (const fixture of fixtures) {
      const { entry_a_id: a, entry_b_id: b, winner_entry_id: winner } = fixture
      expect(a).not.toBeNull()
      expect(b).not.toBeNull()
      expect(winner).not.toBeNull()
      bump(winner!, 'wins')
      bump(winner === a ? b! : a!, 'losses')
    }
    return record
  }

  it.each([FINISHED, MID_FLIGHT])(
    '%s is an rr-then-ko event whose results are the standings_then_finishes arm',
    (eventId) => {
      const event = eventOf(eventId)

      expect(event.draw_type).toBe('rr-then-ko')
      // The count that sized the bracket at the cut — NOT null, unlike every count-less
      // draw type in the seed.
      expect(event.qualifiers_per_group).toBe(2)
      const results = resultsOf(eventId)
      // Both blocks, always: a two-stage event that sent only one of them would be a
      // shape neither existing panel can read.
      expect(results.groups.length).toBeGreaterThan(0)
      expect(Array.isArray(results.finishes)).toBe(true)
    },
  )

  it.each([FINISHED, MID_FLIGHT])(
    "%s's bracket is the one planDraw would cut — played out, not hand-drawn",
    (eventId) => {
      const event = eventOf(eventId)
      // The GROUP STAGE's own group ids only (ADR 20260823) — never `event.groups` as a
      // whole, which now also carries the knockout stage's own group (`groupsForEvent`).
      // Handing the snake that one too would deal the field across an extra "group" the
      // real cut never sees: "the snake deals only into the stage being dealt", the same
      // filter `planEventDraw` (`tournaments-store.ts`) applies before calling `planDraw`.
      const groupStageId = [...event.stages].sort((a, b) => a.position - b.position)[0]!.id
      const groupIds = event.groups
        .filter((g) => g.stage_id === groupStageId)
        .map((g) => g.id)
      const plan = planDraw(
        'rr-then-ko',
        event.entrants.map((e) => e.id),
        groupIds,
        // The event's own count, unasserted: the planner takes `number | null` and
        // refuses the impossible pair loudly, so there is nothing here to talk past.
        event.qualifiers_per_group,
        // No round count: this draw type has none, and only the swiss arm reads it.
        null,
      )
      if (!plan.ok) throw new Error(`expected a plan, got: ${plan.detail}`)

      // The SHAPE — every fixture's id, stage, round and position — is the cut's. Only
      // the sides and the winners differ, which is precisely what playing an event does
      // to a draw. A bracket of a different size (or one that renumbered its rounds)
      // would be a draw this store could never have produced.
      const shapeOf = (fixtures: Fixture[]) =>
        fixtures.map((f) => ({
          id: f.id,
          group_id: f.group_id,
          round: f.round,
          position: f.position,
        }))
      expect(shapeOf(event.fixtures)).toEqual(shapeOf(plan.fixtures))
    },
  )

  it.each([FINISHED, MID_FLIGHT])(
    "%s's group standings add up across that group's own fixtures",
    (eventId) => {
      const event = eventOf(eventId)
      const results = resultsOf(eventId)

      for (const group of results.groups) {
        const fixtures = event.fixtures.filter((f) => f.group_id === group.group_id)
        expect(fixtures.length).toBeGreaterThan(0)
        const played = recordFromFixtures(fixtures)

        // The table names exactly the group's players, once each, ranked 1..n.
        expect(group.rows.map((r) => r.rank)).toEqual(
          group.rows.map((_, i) => i + 1),
        )
        expect(new Set(group.rows.map((r) => r.entry_id)).size).toBe(
          group.rows.length,
        )
        expect(new Set(group.rows.map((r) => r.entry_id))).toEqual(
          new Set(played.keys()),
        )

        for (const row of group.rows) {
          const actual = played.get(row.entry_id)!
          // The wins/losses a director reads are the ones the fixtures RECORD…
          expect({ entry: row.entry_id, ...actual }).toEqual({
            entry: row.entry_id,
            wins: row.wins,
            losses: row.losses,
          })
          // …every match counts as played exactly once…
          expect(row.played).toBe(row.wins + row.losses)
          // …and the difference is the server's own reduction of the two counts beside
          // it, never a third independent number.
          expect(row.game_difference).toBe(row.games_won - row.games_lost)
        }

        // Every game won by somebody was lost by somebody else, so a group's two game
        // columns balance. This is the check a typo in one cell cannot survive.
        const sum = (pick: (r: (typeof group.rows)[number]) => number) =>
          group.rows.reduce((total, row) => total + pick(row), 0)
        expect(sum((r) => r.games_won)).toBe(sum((r) => r.games_lost))
        // …and one win is one loss.
        expect(sum((r) => r.wins)).toBe(fixtures.length)
        expect(sum((r) => r.losses)).toBe(fixtures.length)
      }
    },
  )

  it.each([FINISHED, MID_FLIGHT])(
    "%s's finishes follow single-elimination's tie shape",
    (eventId) => {
      const results = resultsOf(eventId)
      const finalRound = finalOf(eventId).round

      // `2 ** (final_round − round) + 1` for a loser, 1 for the champion — the SAME
      // arithmetic `SingleElimResults` uses, which is what makes the two-stage arm's
      // finishes block the single-elim one rather than a near-copy of it.
      for (const finish of results.finishes) {
        const expected =
          finish.eliminated_in_round === null
            ? 1
            : 2 ** (finalRound - finish.eliminated_in_round) + 1
        expect({ entry: finish.entry_id, position: finish.position }).toEqual({
          entry: finish.entry_id,
          position: expected,
        })
      }

      // Same round out ⇒ same position, and no two entrants share a position without
      // sharing a round: inventing an order between two semifinal losers would fabricate
      // a result the bracket never produced.
      const roundsByPosition = new Map<number, Set<number | null>>()
      for (const finish of results.finishes) {
        const rounds = roundsByPosition.get(finish.position) ?? new Set()
        rounds.add(finish.eliminated_in_round)
        roundsByPosition.set(finish.position, rounds)
      }
      for (const rounds of roundsByPosition.values()) {
        expect(rounds.size).toBe(1)
      }

      // Ordered by position, as the wire sends it — the client renders it untouched.
      const positions = results.finishes.map((f) => f.position)
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
      // Nobody is placed twice.
      expect(new Set(results.finishes.map((f) => f.entry_id)).size).toBe(
        results.finishes.length,
      )
    },
  )

  // THE decision of ADR 20260727, and the one property 4c's rendering hangs on: the
  // champion comes from the BRACKET. A fixture whose champion also happened to top a
  // group would leave "crowned from the knockout" and "crowned from the standings"
  // indistinguishable on screen — and a renderer that read the wrong one would look
  // right.
  it('crowns the FINAL’s winner — who is nobody’s group leader', () => {
    const results = resultsOf(FINISHED)
    const final = finalOf(FINISHED)

    expect(final.winner_entry_id).not.toBeNull()
    expect(results.champion).toBe(final.winner_entry_id)
    // …and that entrant tops NO group.
    const groupLeaders = results.groups.map((g) => g.rows[0].entry_id)
    expect(groupLeaders).not.toContain(results.champion)
    // The champion is a real entrant of this event and is placed 1st in the finishes.
    expect(eventOf(FINISHED).entrants.map((e) => e.id)).toContain(
      results.champion,
    )
    expect(results.finishes[0]).toMatchObject({
      entry_id: results.champion,
      position: 1,
      eliminated_in_round: null,
    })
    // Both group leaders are still IN the finishes — they just lost, and are tied 3rd.
    for (const leader of groupLeaders) {
      expect(results.finishes.map((f) => f.entry_id)).toContain(leader)
    }
  })

  // `complete` is BOTH stages decided. The mid-flight event is what makes that a real
  // claim rather than a restatement of "the groups are done": every one of its groups
  // says `complete`, and the event does not.
  it('is complete only when the groups AND the bracket are decided', () => {
    const finished = resultsOf(FINISHED)
    expect(finished.groups.every((g) => g.complete)).toBe(true)
    expect(finalOf(FINISHED).winner_entry_id).not.toBeNull()
    expect(finished.complete).toBe(true)

    const midFlight = resultsOf(MID_FLIGHT)
    // Stage one: done, every group of it.
    expect(midFlight.groups.every((g) => g.complete)).toBe(true)
    // Stage two: the final is SEATED — both sides known, `advance()` carried the
    // semifinal winners in — and unplayed.
    const final = finalOf(MID_FLIGHT)
    expect(final.entry_a_id).not.toBeNull()
    expect(final.entry_b_id).not.toBeNull()
    expect(final.winner_entry_id).toBeNull()
    // …so there is no champion, and the event is NOT complete.
    expect(midFlight.champion).toBeNull()
    expect(midFlight.complete).toBe(false)
    // The finishes hold only what the bracket has actually settled: the two beaten
    // semifinalists, tied 3rd. No 1st, no 2nd — those do not exist yet.
    expect(midFlight.finishes.map((f) => f.position)).toEqual([3, 3])
  })
})

// ----- the venue catalogue on a write (ADR 20260801) --------------------------
//
// A table is a ROW now, and two things about it moved at once:
//
//   1. its **id is the server's to mint** — the create shape has no `id` at all, and the
//      patch shape's optional one *cites* a table rather than authoring one;
//   2. the catalogue write is a **diff**, not a replace — a stored table no entry names
//      is removed, and a removal can be REFUSED.
//
// Both are mirrored here, and the refusal is the reason it matters. A mock that
// wholesale-replaced the catalogue would let a component that drops a table look
// perfectly healthy in `npm run dev` and in vitest, and 409 in front of a director on
// the morning of their tournament — with the matches they had already placed silently
// homeless in the mock world in the meantime.
//
// The asymmetry is the ADR's point and is asserted on both sides: a table only a
// RESERVATION holds goes quietly (a table breaking or freeing up is ordinary venue
// traffic), a table a fixture is PLACED at is refused (clearing a placement destroys
// information on an unrelated write).
describe('the venue catalogue on a write (ADR 20260801)', () => {
  beforeEach(() => resetTournamentsStore())
  afterEach(() => resetTournamentsStore())

  /** Summer Slam: draft, owned, catalogue `T1`–`T8`, one drawn round-robin whose two
   * reservations hold `T1`–`T4`. Everything below edits ITS catalogue. */
  const SLAM = DRAFT_TOURNAMENT

  const catalogueOf = (id: string): TournamentTable[] =>
    findTournament(id)!.table_catalogue

  const fixturesOf = (id: string) =>
    findTournament(id)!.events.flatMap((e) => e.fixtures)

  /** The tournament's own catalogue as a PATCH body carries it — the round trip the
   * client really makes: read the tables, send them back edited. Every entry cites its
   * id, so this alone is a no-op diff. */
  const asUpserts = (id: string): TournamentTableUpsert[] =>
    catalogueOf(id).map((t) => ({ id: t.id, label: t.label, court: t.court }))

  /** Assert the named refusal and hand back its payload, narrowed — one per status, so
   * a test reading `.index` off a 409 is a type error rather than an `undefined`. */
  function refusal409(result: StoreResult) {
    if (result.ok || result.status !== 409) {
      throw new Error(`expected a 409, got ${JSON.stringify(result)}`)
    }
    return result
  }

  function refusal422(result: StoreResult) {
    if (result.ok || result.status !== 422) {
      throw new Error(`expected a 422, got ${JSON.stringify(result)}`)
    }
    return result
  }

  /** Place Summer Slam's first group fixture on `T1` — a FULL placement of a fixture
   * whose two sides are known, so it pins (`manualPlacementPin`, every status). That
   * pin is what makes the opt-in's "all three columns go" a real assertion. */
  function placeAFixtureOnT1(): { fixtureId: string; tableId: string } {
    const tableId = catalogueOf(SLAM)[0].id
    const fixtureId = fixturesOf(SLAM)[0].id
    const placed = placeFixture(SLAM, fixtureId, {
      table_id: tableId,
      scheduled_start: '2026-08-22T09:00:00',
    })
    if (!placed.ok) throw new Error('setup failed: could not place the fixture')
    expect(placed.fixture.pinned_at).not.toBeNull()
    return { fixtureId, tableId }
  }

  const fixtureIn = (tournamentId: string, fixtureId: string) =>
    fixturesOf(tournamentId).find((f) => f.id === fixtureId)!

  // ----- the one hard rule about a placement (ADR 20260801) -------------------
  //
  // Everything else about a placement is soft (ADR-0790, undisturbed): an
  // out-of-window time, a table outside the fixture's group's reservation, a
  // double-booking all still save. Only "does `table_id` name a real table of THIS
  // tournament" is an
  // invariant, mirroring the server's `_enforce_table_exists`
  // (`api/app/tournament_placement.py`) — without this, a component tested against
  // the mock could place a fixture at a garbage id and never see the 422 the real
  // API would answer with.

  it('REFUSES a placement whose table_id names no table of this tournament', () => {
    const fixtureId = fixturesOf(SLAM)[0].id
    const before = fixtureIn(SLAM, fixtureId)

    const result = placeFixture(SLAM, fixtureId, {
      table_id: 'not-a-real-table-id',
      scheduled_start: '2026-08-22T09:00:00',
    })

    if (result.ok || result.status !== 422) {
      throw new Error(`expected a 422, got ${JSON.stringify(result)}`)
    }
    expect(result.detail).toBe(
      "This tournament's venue catalogue has no table with that id.",
    )
    // NOTHING was written — a refused placement leaves the fixture exactly as it was.
    expect(fixtureIn(SLAM, fixtureId)).toEqual(before)
  })

  it('ACCEPTS a placement naming a real table, and unplacing with table_id: null always passes', () => {
    const { fixtureId, tableId } = placeAFixtureOnT1()
    expect(fixtureIn(SLAM, fixtureId).table_id).toBe(tableId)

    // `null` is not a miss — it is the unplace case, and the one value that always
    // passes the check regardless of what the catalogue holds.
    const cleared = placeFixture(SLAM, fixtureId, {
      table_id: null,
      scheduled_start: null,
    })

    expect(cleared.ok).toBe(true)
    if (!cleared.ok) throw new Error('expected the unplace to succeed')
    expect(cleared.fixture.table_id).toBeNull()
  })

  // ----- who mints an id ------------------------------------------------------

  it('MINTS an id for every table on a create — the client sends none', () => {
    const created = createTournament({
      name: 'Minted On Create',
      description: null,
      address: null,
      // `TournamentTableWrite`: label and court, and no `id` to send.
      table_catalogue: [
        { label: 'T1', court: 'A' },
        { label: 'T2', court: 'B' },
      ],
    })

    const [first, second] = created.table_catalogue
    expect(first).toMatchObject({ label: 'T1', court: 'A' })
    expect(second).toMatchObject({ label: 'T2', court: 'B' })
    // Real, distinct uuids — the wire says `format: uuid`, and two rows sharing an id
    // is the one thing an id-keyed diff cannot survive.
    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(second.id).not.toBe(first.id)
  })

  it('MINTS an id for a table added by a PATCH, and leaves the cited ones alone', () => {
    const before = catalogueOf(SLAM)

    const result = updateTournament(SLAM, { details_version: 1,
      // The whole catalogue, cited by id, plus one entry with NO id: "add this one".
      table_catalogue: [...asUpserts(SLAM), { label: 'T9', court: '9' }],
    })

    expect(result.ok).toBe(true)
    const after = catalogueOf(SLAM)
    expect(after).toHaveLength(before.length + 1)
    // Every table that was already there kept its id — every reservation `table_ids`
    // and fixture `table_id` that names one still names it.
    expect(after.slice(0, before.length).map((t) => t.id)).toEqual(
      before.map((t) => t.id),
    )
    const added = after[after.length - 1]
    expect(added).toMatchObject({ label: 'T9', court: '9' })
    expect(before.map((t) => t.id)).not.toContain(added.id)
  })

  // ----- the diff is keyed on the id, not the position ------------------------

  it('re-words a CITED table in place — the id is what the entry names', () => {
    const [first, ...rest] = catalogueOf(SLAM)

    updateTournament(SLAM, { details_version: 1,
      table_catalogue: [
        { id: first.id, label: 'Centre Court', court: 'Z' },
        ...rest.map((t) => ({ id: t.id, label: t.label, court: t.court })),
      ],
    })

    expect(catalogueOf(SLAM)[0]).toEqual({
      id: first.id,
      label: 'Centre Court',
      court: 'Z',
    })
  })

  // The by-position stopgap this replaces matched the i-th sent against the i-th stored,
  // so sending two tables in the other order left each row holding its own id and its
  // NEIGHBOUR's words: a fixture placed at "T1" silently began rendering as "T2", with
  // nothing refused and nothing to see. Only the client knows which of its rows is which.
  it('MOVES tables on a reorder — it does not swap labels between ids', () => {
    const [first, second, ...rest] = catalogueOf(SLAM)

    updateTournament(SLAM, { details_version: 1,
      table_catalogue: [second, first, ...rest].map((t) => ({
        id: t.id,
        label: t.label,
        court: t.court,
      })),
    })

    const after = catalogueOf(SLAM)
    expect(after[0]).toEqual(second)
    expect(after[1]).toEqual(first)
  })

  it('refuses an entry citing an id this catalogue does not hold, naming the entry', () => {
    const before = catalogueOf(SLAM)

    const result = updateTournament(SLAM, { details_version: 1,
      name: 'Renamed While Citing A Ghost',
      table_catalogue: [
        ...asUpserts(SLAM),
        { id: 'not-a-table-of-this-tournament', label: 'T9', court: '9' },
      ],
    })

    const refused = refusal422(result)
    // The INDEX, because a catalogue is a list and a refusal a client cannot attribute
    // to a row is a refusal it cannot render.
    expect(refused.index).toBe(before.length)
    expect(refused.tableId).toBe('not-a-table-of-this-tournament')
    expect(refused.detail).toBe(
      "This tournament's venue catalogue has no table with that id.",
    )
    // Never a silently minted table — and never the name that rode along either.
    expect(catalogueOf(SLAM)).toEqual(before)
    expect(findTournament(SLAM)!.name).toBe('Summer Slam 2026')
  })

  // ----- removal: the quiet half, and the loud one ----------------------------

  it('REMOVES a table no entry names', () => {
    const before = catalogueOf(SLAM)

    updateTournament(SLAM, { details_version: 1,
      table_catalogue: asUpserts(SLAM).filter((t) => t.id !== before[7].id),
    })

    expect(catalogueOf(SLAM).map((t) => t.id)).toEqual(
      before.slice(0, 7).map((t) => t.id),
    )
  })

  // The QUIET half of the ADR's split. A reservation's `table_ids` name tables it
  // holds, not a placement — "a table breaks, a table frees up" is ordinary venue
  // traffic — so the reservation simply holds one fewer and nothing is refused. (The
  // stored `table_ids` still list the dead id; pruning them is a later slice on the
  // server too.)
  it('removes a table only a RESERVATION holds — no refusal, no opt-in', () => {
    // `T2` is held by Reservation A and has nothing placed on it.
    const [t1, t2, ...rest] = catalogueOf(SLAM)
    const reservation = findTournament(SLAM)!.events[0].reservations[0]
    expect(reservation.table_ids).toContain(t2.id)

    const result = updateTournament(SLAM, { details_version: 1,
      table_catalogue: [t1, ...rest].map((t) => ({
        id: t.id,
        label: t.label,
        court: t.court,
      })),
    })

    expect(result.ok).toBe(true)
    expect(catalogueOf(SLAM).map((t) => t.id)).not.toContain(t2.id)
  })

  // The LOUD half. Silently clearing a placement destroys information on an UNRELATED
  // write: the fixture stops being "placed at a table that vanished" and becomes
  // indistinguishable from "nobody ever placed this".
  it('REFUSES removing a table matches are placed at, in the server’s words', () => {
    const { fixtureId, tableId } = placeAFixtureOnT1()
    const before = catalogueOf(SLAM)

    const result = updateTournament(SLAM, { details_version: 1,
      // The rename is the tripwire: a guard that refused AFTER writing would satisfy
      // every assertion about the 409 and still have moved the venue underneath the
      // director.
      name: 'Renamed While Removing',
      table_catalogue: asUpserts(SLAM).filter((t) => t.id !== tableId),
    })

    const { detail } = refusal409(result)
    // Named by LABEL, never by id: an id tells a director looking at a page of named
    // tables nothing to act on.
    expect(detail).toBe(
      '“T1” has 1 match placed at it, so removing it from the catalogue would leave ' +
        'those matches with no table — indistinguishable from matches nobody ever ' +
        'placed. To remove it anyway, send the same edit again with ' +
        '“unplace_fixtures_on_removed_tables”: true, and those matches lose their ' +
        'table, their time and their call and go back to the schedule to be placed ' +
        'again. To keep them where they are, leave the table in the catalogue and ' +
        'move the matches off it first.',
    )
    expect(detail).not.toContain(tableId)

    // NOTHING was written. Not the catalogue…
    expect(catalogueOf(SLAM)).toEqual(before)
    // …not the name that rode along on the same refused request…
    expect(findTournament(SLAM)!.name).toBe('Summer Slam 2026')
    // …and not the placement the refusal was protecting.
    const fixture = fixtureIn(SLAM, fixtureId)
    expect(fixture.table_id).toBe(tableId)
    expect(fixture.scheduled_start).not.toBeNull()
    expect(fixture.pinned_at).not.toBeNull()
  })

  it('the OPT-IN removes the table and leaves those fixtures unplaced', () => {
    const { fixtureId, tableId } = placeAFixtureOnT1()

    const result = updateTournament(SLAM, { details_version: 1,
      name: 'Renamed While Removing',
      table_catalogue: asUpserts(SLAM).filter((t) => t.id !== tableId),
      unplace_fixtures_on_removed_tables: true,
    })

    expect(result.ok).toBe(true)
    expect(catalogueOf(SLAM).map((t) => t.id)).not.toContain(tableId)
    // The rest of the same edit landed too.
    expect(findTournament(SLAM)!.name).toBe('Renamed While Removing')
    // All THREE placement columns go together: a start with no table is a bar on a
    // schedule with nowhere to be, and a pin is a *promise about a table*.
    const fixture = fixtureIn(SLAM, fixtureId)
    expect(fixture.table_id).toBeNull()
    expect(fixture.scheduled_start).toBeNull()
    expect(fixture.pinned_at).toBeNull()
    // And only the fixtures that were on the removed table: nobody else was touched.
    expect(
      fixturesOf(SLAM).filter((f) => f.id !== fixtureId && f.table_id !== null),
    ).toHaveLength(0)
  })

  // The opt-in has ONE affirmative spelling and three ways of not saying it. The field is
  // `bool | None` on the wire rather than `bool = False` because a non-null default is
  // emitted as `"default": false` and `openapi-typescript` promotes any property carrying
  // one to REQUIRED — which would make an opt-in for one destructive action mandatory on
  // every unrelated PATCH. That third wire value must not become a third state.
  it.each([
    ['omitted', {}],
    ['false', { unplace_fixtures_on_removed_tables: false }],
    ['null', { unplace_fixtures_on_removed_tables: null }],
  ] as const)('refuses identically when the opt-in is %s', (_spelling, optIn) => {
    const { fixtureId, tableId } = placeAFixtureOnT1()

    const result = updateTournament(SLAM, { details_version: 1,
      table_catalogue: asUpserts(SLAM).filter((t) => t.id !== tableId),
      ...optIn,
    })

    expect(refusal409(result).detail).toContain('“T1”')
    expect(catalogueOf(SLAM).map((t) => t.id)).toContain(tableId)
    expect(fixtureIn(SLAM, fixtureId).table_id).toBe(tableId)
  })
})
