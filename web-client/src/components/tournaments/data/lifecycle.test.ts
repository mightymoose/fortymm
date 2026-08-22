import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api/client'

import {
  entryControlState,
  lifecycleEdgeFor,
  lifecycleRefusalNotice,
  lifecycleRefusalScope,
  LIFECYCLE_EDGE,
  REGISTRATION_WINDOW,
} from './lifecycle'
import {
  buildDrawnEvent,
  buildEntrant,
  buildEntrants,
  buildEvent,
  buildFullEvent,
  buildIneligibleEvent,
  buildReservation,
  buildScheduleSolve,
  buildTournament,
  UNROUNDED_RATING,
} from './seed.factory'
import type { TournamentStatus } from './types'

describe('LIFECYCLE_EDGE', () => {
  // The three edges the server's `LEGAL_TRANSITIONS` holds, and nothing else. A
  // fourth entry here would be a button the API can only ever refuse.
  it('offers exactly the forward edges the server allows', () => {
    expect(LIFECYCLE_EDGE.draft?.to).toBe('published')
    expect(LIFECYCLE_EDGE.published?.to).toBe('live')
    expect(LIFECYCLE_EDGE.live?.to).toBe('archived')
  })

  // Terminal: there is no edge out of `archived`, so there is no button — not a
  // disabled one, and certainly not one that walks the lifecycle backwards.
  it('offers no edge out of the terminal archived status', () => {
    expect(LIFECYCLE_EDGE.archived).toBeNull()
  })

  // The verb rides on the EDGE, so the failure toast names the thing the user
  // clicked ("Couldn't publish the tournament"). It used to live in a second table
  // in `data/api.ts`, keyed by target status — two tables of one lifecycle, which
  // could disagree about what an edge is.
  it('names each edge in the voice of the person who clicked it', () => {
    expect(LIFECYCLE_EDGE.draft?.verb).toBe('publish the tournament')
    expect(LIFECYCLE_EDGE.published?.verb).toBe('start the tournament')
    expect(LIFECYCLE_EDGE.live?.verb).toBe('end the tournament')
  })
})

describe('REGISTRATION_WINDOW', () => {
  // ADR-0017's table, and the server's `_registration_open` /
  // `_enforce_registration_open` guard: exactly ONE status opens the window. A
  // second open status here would be an Enter button the API answers with a 409.
  it('is open on published, and on published only', () => {
    expect(REGISTRATION_WINDOW.published.state).toBe('open')
    expect(REGISTRATION_WINDOW.draft.state).toBe('not-open-yet')
    expect(REGISTRATION_WINDOW.live.state).toBe('locked')
    expect(REGISTRATION_WINDOW.archived.state).toBe('locked')
  })

  // Locked is locked, but WHY differs — the tournament is under way vs it is
  // over — and a shared string would quietly make one of those sentences a lie.
  it('gives live and archived their own reasons', () => {
    const live = REGISTRATION_WINDOW.live
    const archived = REGISTRATION_WINDOW.archived
    if (live.state === 'open' || archived.state === 'open') {
      throw new Error('locked statuses must not be open')
    }
    expect(live.reason).not.toBe(archived.reason)
  })
})

describe('entryControlState', () => {
  const ENTERED = 'rita.kovac'
  const myEntry = buildEntrant({ id: 'entry-me', username: ENTERED })
  const enteredEvent = buildEvent({ entrants: [myEntry] })
  const emptyEvent = buildEvent({ entrants: [] })

  const state = (over: {
    status?: TournamentStatus
    event?: ReturnType<typeof buildEvent>
    canEnter?: boolean
    username?: string | null
  }) =>
    entryControlState({
      status: 'published',
      event: emptyEvent,
      canEnter: true,
      username: ENTERED,
      ...over,
    })

  // The open window, which is the only one that has controls in it at all.
  it('offers enter to a permitted player who is not in the event', () => {
    expect(state({ event: emptyEvent })).toEqual({ kind: 'enter' })
  })

  it("offers withdraw, addressed to the player's OWN entry id, once they are in", () => {
    expect(state({ event: enteredEvent })).toEqual({
      kind: 'withdraw',
      entryId: 'entry-me',
    })
  })

  // Facts about the CALLER, decided before the window: they render nothing, and
  // they do so in every status — an unpermitted viewer of a draft is told nothing
  // about a registration window they could never have used. The missing permission
  // and the un-enterable format are ONE case (`hidden`), because nothing
  // downstream can tell them apart: both are silence.
  it.each(['draft', 'published', 'live', 'archived'] as const)(
    'is hidden on a %s tournament for a player without tournament.enter',
    (status) => {
      expect(state({ status, canEnter: false })).toEqual({ kind: 'hidden' })
    },
  )

  it.each(['doubles', 'teams'] as const)(
    'is hidden for a %s event, whatever the status',
    (format) => {
      expect(state({ event: buildEvent({ format }), status: 'draft' })).toEqual({
        kind: 'hidden',
      })
    },
  )

  // The window, decided before membership — the crux of this slice. `closed` is one
  // case; the difference between a door not yet unlocked and a door shut again is
  // carried by the copy, which is the only place it was ever carried.
  it('reports the shut window on a draft tournament instead of offering enter', () => {
    expect(state({ status: 'draft', event: emptyEvent })).toEqual({
      kind: 'closed',
      lead: 'Not open yet',
      reason: 'Entry opens when this tournament is published.',
    })
  })

  it.each([
    { status: 'live', reason: 'The tournament is under way.' },
    { status: 'archived', reason: 'The tournament has ended.' },
  ] as const)(
    'reports entries locked on a $status tournament instead of offering enter',
    ({ status, reason }) => {
      expect(state({ status, event: emptyEvent })).toEqual({
        kind: 'closed',
        lead: 'Entries locked',
        // …and says WHICH lock it is: "under way" and "has ended" are not the same
        // news to a player who has just arrived.
        reason,
      })
    },
  )

  // The one the ordering exists for: an entered player on a live tournament is
  // still an entrant (the roster still shows their chip — the field is fixed),
  // but they cannot pull themselves out of a draw cut from it. A Withdraw button
  // here is a 409 with a nice icon.
  it.each(['live', 'archived'] as const)(
    'locks an ENTERED player out of withdrawing on a %s tournament',
    (status) => {
      expect(state({ status, event: enteredEvent })).toMatchObject({
        kind: 'closed',
        lead: 'Entries locked',
      })
    },
  )

  it('does not offer withdraw to an entered player before publication either', () => {
    expect(state({ status: 'draft', event: enteredEvent })).toMatchObject({
      kind: 'closed',
      lead: 'Not open yet',
    })
  })

  // ----- what the EVENT itself says (#783, ADR-0783) ------------------------

  // A full event explains itself. It does NOT offer Enter — #783's own text asked
  // for a *disabled* button and we are deliberately not giving it one: ADR-0015
  // hides the affordance and puts the reason where it was.
  it('reports a FULL event instead of offering an Enter that could only 409', () => {
    expect(state({ event: buildFullEvent() })).toEqual({
      kind: 'full',
      lead: 'Event full',
      reason: 'Every place in this event has been taken.',
    })
  })

  // ⚠️ THE TRAP. An entrant in a full event must still be able to LEAVE it —
  // membership is judged before the event's refusals. Get this backwards and the
  // full event (the normal end state of a popular one) locks in everyone already
  // inside it, silently, with a notice where their Withdraw button used to be.
  it('still offers WITHDRAW to a player who already holds an entry in a FULL event', () => {
    const fullWithMe = buildFullEvent({
      maxPlayers: 4,
      entrants: [...buildEntrants(3), myEntry],
    })

    // Full by the server's own reckoning — 4 of 4 — and yet:
    expect(fullWithMe.entryState).toEqual({ state: 'event_full' })
    expect(state({ event: fullWithMe })).toEqual({
      kind: 'withdraw',
      entryId: 'entry-me',
    })
  })

  // The rules are the server's to judge (ADR-0783 — the client never re-derives
  // them from the raw `predicates` JSON), but the WORDS are the client's, and they
  // are specific: the rule that refused you, read back out of the event's own
  // predicates by id, and the rating you were judged on. "Not eligible" alone is a
  // fact nobody can act on.
  it('names the rule that refused an INELIGIBLE player, and the rating it judged', () => {
    expect(state({ event: buildIneligibleEvent() })).toEqual({
      kind: 'ineligible',
      lead: 'Not eligible',
      reason: 'Rating is less than 1500. Your rating is 1662.',
    })
  })

  // …and it prints that rating the way every OTHER surface in the app prints one:
  // rounded (`formatRating`). The fixture is the point of this test — a raw Glicko
  // float, thirteen decimals, exactly what the server sends. Its predecessor used a
  // round 1650, which made `${state.rating}` and `${Math.round(state.rating)}` the
  // same string: the assertion could not tell the fix from the bug, and the bug
  // shipped ("Your rating is 1662.3108939062977."). A round-number fixture here
  // re-creates the blind spot.
  it('ROUNDS the raw Glicko float it was judged on — never 13 decimal places', () => {
    const ineligible = buildIneligibleEvent()
    // The payload really is the unrounded float, so what follows is a claim about
    // the formatter and not about a fixture that pre-rounded it for us.
    expect(ineligible.entryState).toMatchObject({ rating: UNROUNDED_RATING })
    expect(String(UNROUNDED_RATING)).toContain('.')

    expect(state({ event: ineligible })).toMatchObject({
      reason: 'Rating is less than 1500. Your rating is 1662.',
    })
    // …and not a decimal in sight: the whole point is the tail that used to be here.
    expect(state({ event: ineligible })).toMatchObject({
      reason: expect.not.stringContaining('1662.3'),
    })
  })

  // The rule the refusal points at was edited away under a stale page. Falling back
  // to the generic copy is the honest degrade; half a sentence ("Rating is . Your
  // rating is 1662.") would not be.
  it('falls back to generic copy when the refusing rule is not on the event', () => {
    const stale = buildIneligibleEvent({ predicates: [] })

    expect(state({ event: stale })).toEqual({
      kind: 'ineligible',
      lead: 'Not eligible',
      reason: "Your rating doesn't meet this event's eligibility rules.",
    })
  })

  // Both refusals are facts about the EVENT + the caller — they say nothing about
  // the window, which is judged first. A shut tournament is still shut, and that is
  // the reason a player is shown, because it is the one that will change first.
  it.each([
    { kind: 'full', event: buildFullEvent() },
    { kind: 'ineligible', event: buildIneligibleEvent() },
  ] as const)(
    'reports the shut WINDOW ahead of $kind — the tournament outranks the event',
    ({ event }) => {
      expect(state({ status: 'draft', event })).toMatchObject({ kind: 'closed' })
    },
  )

  // …and the caller-level facts still outrank everything: a viewer without
  // `tournament.enter` is told nothing about a full event they could never enter.
  it.each([
    { kind: 'full', event: buildFullEvent() },
    { kind: 'ineligible', event: buildIneligibleEvent() },
  ] as const)('stays hidden for an unpermitted viewer of a $kind event', ({ event }) => {
    expect(state({ event, canEnter: false })).toEqual({ kind: 'hidden' })
  })
})

describe('lifecycleEdgeFor', () => {
  // The ONE accessor: what the header asks before it renders its action slot (so a
  // viewer — and an archived tournament — leaves that slot genuinely empty rather
  // than filling it with a wrapper around a component that renders nothing), AND
  // what `LifecycleActions` renders and posts. One read of the table, not two.
  it.each([
    { status: 'draft', canEdit: true, expected: 'published' },
    { status: 'published', canEdit: true, expected: 'live' },
    { status: 'live', canEdit: true, expected: 'archived' },
    // Terminal: an owner standing on `archived` has nowhere to go.
    { status: 'archived', canEdit: true, expected: null },
    // A viewer is offered nothing, in any status — transitions are owner-only
    // (403) server-side, so a button here would be one the API refuses.
    { status: 'draft', canEdit: false, expected: null },
    { status: 'published', canEdit: false, expected: null },
    { status: 'live', canEdit: false, expected: null },
    { status: 'archived', canEdit: false, expected: null },
  ] as const)(
    'offers $expected for a $status tournament with canEdit=$canEdit',
    ({ status, canEdit, expected }) => {
      const edge = lifecycleEdgeFor(buildTournament({ status, canEdit }))

      expect(edge?.to ?? null).toBe(expected)
    },
  )

  // It returns the EDGE, not a boolean — which is what lets the component render
  // and post from one lookup instead of re-reading the table behind the predicate.
  it('hands back the whole edge — label, verb and target together', () => {
    expect(
      lifecycleEdgeFor(buildTournament({ status: 'published', canEdit: true })),
    ).toMatchObject({
      to: 'live',
      label: 'Start tournament',
      verb: 'start the tournament',
    })
  })
})

// The words a refused transition is reported in — the header shows them inline and
// carries no toast, so this function is the *only* thing standing between a failed click
// and silence.
describe('lifecycleRefusalScope', () => {
  // The three moves that resolve a start refusal. Each is something the director does
  // *because* the refusal told them to, so each must retire the sentence that asked.
  it('moves when an event is added — the fix for "this tournament has no events"', () => {
    const before = buildTournament({ events: [] })

    expect(lifecycleRefusalScope(before)).not.toBe(
      lifecycleRefusalScope(buildTournament({ events: [buildEvent()] })),
    )
  })

  it('moves when an event acquires a draw — the fix for "has no draw yet"', () => {
    const undrawn = buildTournament({ events: [buildEvent({ id: 'ev-1' })] })
    const drawn = buildTournament({ events: [buildDrawnEvent({ id: 'ev-1' })] })

    expect(lifecycleRefusalScope(undrawn)).not.toBe(lifecycleRefusalScope(drawn))
  })

  it('moves when somebody enters — the fix for a draw that no longer seats its entrants', () => {
    // The scope reads entrant *ids*, not the count — so a test moves the list.
    const before = buildTournament({
      events: [buildEvent({ id: 'ev-1', entrants: buildEntrants(4) })],
    })
    const after = buildTournament({
      events: [buildEvent({ id: 'ev-1', entrants: buildEntrants(5) })],
    })

    expect(lifecycleRefusalScope(before)).not.toBe(lifecycleRefusalScope(after))
  })

  /**
   * The refusal's **third** shape — "has a draw that no longer matches its entrants" —
   * and the one the counts could not see.
   *
   * Registration stays open right up to go-live, so the way a draw goes stale is that
   * somebody enters and somebody withdraws. The field is the same SIZE throughout, and
   * re-cutting over it produces the same NUMBER of fixtures — so a scope built from
   * `entered` and `fixtures.length` is byte-identical before the swap, after the swap and
   * after the re-cut. The refusal telling the director to re-cut would have survived their
   * re-cutting, which is the bug in its most confusing form: the fix appears not to work.
   */
  it('moves when a stale draw is re-cut over a field of the same size', () => {
    const before = buildDrawnEvent({ id: 'ev-1', entrants: buildEntrants(4) })
    // A cut is wholesale: the server deletes every fixture for the event and plans a
    // fresh set, so a re-cut mints new ids. Same field, same number of fixtures — only
    // the identities move, which is the whole point.
    const after = {
      ...before,
      fixtures: before.fixtures.map((fixture, i) => ({
        ...fixture,
        id: `recut-fx-${i}`,
      })),
    }

    expect(before.entered).toBe(after.entered)
    expect(before.fixtures).toHaveLength(after.fixtures.length)
    expect(
      lifecycleRefusalScope(buildTournament({ events: [before] })),
    ).not.toBe(lifecycleRefusalScope(buildTournament({ events: [after] })))
  })

  /**
   * The live-play case, and the reason the draw half is read as fixture **ids** rather
   * than as the entry ids seated in them.
   *
   * A knockout side is `null` until the fixture feeding it is decided, so every completed
   * match during live play fills one in. Reading the seated sides made the scope move on
   * each of those — and the header polls every ~15s while a tournament is live, so a
   * director reading an End-tournament refusal lost it the moment a bracket slot
   * resolved. Nothing about that resolution is something a lifecycle refusal asserts.
   */
  it('does NOT move when a knockout slot resolves during play', () => {
    const before = buildDrawnEvent({ id: 'ev-1', entrants: buildEntrants(4) })
    const [first, ...rest] = before.fixtures
    // The feeding match finished: this fixture's sides are known now. Same fixture, same
    // id, same field.
    const after = {
      ...before,
      fixtures: [{ ...first, entryAId: 'entry-1', entryBId: 'entry-2' }, ...rest],
    }

    expect(lifecycleRefusalScope(buildTournament({ events: [before] }))).toBe(
      lifecycleRefusalScope(buildTournament({ events: [after] })),
    )
  })

  /** The other half of the same case: the swap itself, which is what makes the draw
   * stale. One player out, one player in, and the count never moves. */
  it('moves when one entrant is swapped for another', () => {
    const before = buildEvent({ id: 'ev-1', entrants: buildEntrants(4) })
    const after = {
      ...before,
      entrants: [
        ...before.entrants.slice(0, 3),
        buildEntrant({ id: 'entry-late', username: 'late.arrival' }),
      ],
    }

    expect(before.entered).toBe(after.entered)
    expect(
      lifecycleRefusalScope(buildTournament({ events: [before] })),
    ).not.toBe(lifecycleRefusalScope(buildTournament({ events: [after] })))
  })

  /**
   * The status is the one field that must NOT be in the scope, and the reason is the
   * **stale-tab** 409.
   *
   * The director published from their phone; this page still shows a draft; they click
   * Publish and are told "This tournament is already published." That sentence exists to
   * explain the reconciliation that lands a moment later, when the badge and button
   * correct themselves under the notice. If the status were in the scope, the refusal
   * would be retired at the exact instant the page did the confusing thing it was there
   * to explain.
   */
  /**
   * Found by the QA pass (Quinn), and it is the one entry in this scope that is not about
   * whether the refusal is still *true*.
   *
   * The go-live 409 **quotes the events at fault** — "“Bracket Cup” has no draw yet". Rename
   * that event and the refusal is still perfectly correct and completely unreadable: it
   * tells the director to cut the draw for an event that is not on the page under that
   * name, while the card below it, its Edit button and its Generate button all read the new
   * one. That is the same header-contradicts-the-page failure as #1216, landing on the name
   * instead of the count.
   */
  it('moves when a named event is renamed — the 409 quotes those names', () => {
    const before = buildTournament({
      events: [buildEvent({ id: 'ev-1', name: 'Bracket Cup' })],
    })
    const after = buildTournament({
      events: [buildEvent({ id: 'ev-1', name: 'Cup Of Renaming' })],
    })

    expect(lifecycleRefusalScope(before)).not.toBe(lifecycleRefusalScope(after))
  })

  /** The *tournament's* own name is still out — no lifecycle refusal quotes it. The test
   * is "is it in the sentence", not "is it a name". */
  it('does NOT move when the tournament itself is renamed', () => {
    const base = buildTournament()

    expect(lifecycleRefusalScope({ ...base, name: 'Renamed Open 2026' })).toBe(
      lifecycleRefusalScope(base),
    )
  })

  it('does NOT move when the status does — the stale-tab refusal explains that very change', () => {
    expect(lifecycleRefusalScope(buildTournament({ status: 'draft' }))).toBe(
      lifecycleRefusalScope(buildTournament({ status: 'published' })),
    )
  })

  // ----- the moves the UNDRAWABLE refusal asks for (#1300) ------------------
  //
  // Since #1300 the go-live refusal quotes the *planner's* sentences — "A doubles event
  // cannot be given a draw", "1 entrant across 1 group would leave a group with fewer than
  // 2 entrants", "play fewer rounds" — so the header's scope has to read every fact those
  // sentences name, which is exactly `drawRefusalScope`'s set. Each test below is one of
  // the four moves the acceptance criteria name, and each is something a director does
  // *because* the sentence told them to. A move the scope cannot see is #1123 shipping
  // again inside a new sentence, so these are asserted one move at a time rather than as
  // a single "the scope is wide" test.
  //
  // (Adding an entrant is the fifth, and it is already covered above — "moves when
  // somebody enters" — because the seating half of the scope predates this ticket.)

  it('moves when a reservation is added — the fix for "a round-robin draw needs at least one group"', () => {
    const before = buildTournament({
      events: [buildEvent({ id: 'ev-1', reservations: [] })],
    })
    const after = buildTournament({
      events: [buildEvent({ id: 'ev-1', reservations: [buildReservation({ id: 'p-new' })] })],
    })

    expect(lifecycleRefusalScope(before)).not.toBe(lifecycleRefusalScope(after))
  })

  // Swiss deliberately: `drawConfig` reads `rounds` only for a swiss event, because only
  // a swiss draw has a round count to refuse over. The same edit on a round-robin event
  // must NOT move the scope, and the pair is asserted together so neither half can drift
  // into being vacuous.
  it('moves when a swiss round count is lowered — the fix for "play fewer rounds"', () => {
    const atSeven = buildTournament({
      events: [buildEvent({ id: 'ev-1', drawType: 'swiss', rounds: 7 })],
    })
    const atThree = buildTournament({
      events: [buildEvent({ id: 'ev-1', drawType: 'swiss', rounds: 3 })],
    })

    expect(lifecycleRefusalScope(atSeven)).not.toBe(
      lifecycleRefusalScope(atThree),
    )
  })

  it('moves when the event’s FORMAT changes — the fix a doubles refusal names is removal', () => {
    // Not a move a director can make on the tournament page today, and read anyway: the
    // sentence "A doubles event cannot be given a draw" is *about* the format, so a scope
    // blind to it would be blind to the fact the refusal turns on.
    const doubles = buildTournament({
      events: [buildEvent({ id: 'ev-1', format: 'doubles' })],
    })
    const singles = buildTournament({
      events: [buildEvent({ id: 'ev-1', format: 'singles' })],
    })

    expect(lifecycleRefusalScope(doubles)).not.toBe(
      lifecycleRefusalScope(singles),
    )
  })

  it('moves when the named event is REMOVED — the fix every undrawable refusal offers', () => {
    // "Remove the event" is the *only* fix a non-singles event has, and one of the two a
    // short field has, so the notice must not survive it.
    const before = buildTournament({
      events: [buildEvent({ id: 'ev-1' }), buildEvent({ id: 'ev-2' })],
    })
    const after = buildTournament({ events: [buildEvent({ id: 'ev-1' })] })

    expect(lifecycleRefusalScope(before)).not.toBe(lifecycleRefusalScope(after))
  })

  /**
   * The half that makes the scope a *design* rather than a `JSON.stringify`.
   *
   * This page polls (~3s on the Schedule tab), and a refused start hands the director a
   * work list they read *while* going to fix it. A scope that moved on anything at all
   * would blink that list off the screen mid-read — so everything no lifecycle refusal
   * asserts over has to leave it unchanged. `latestScheduleSolve` is the sharp case: it
   * rewrites itself on every solve tick.
   */
  it('does NOT move for state no lifecycle refusal is about', () => {
    const base = buildTournament()
    const scope = lifecycleRefusalScope(base)

    expect(lifecycleRefusalScope({ ...base, latestScheduleSolve: buildScheduleSolve() })).toBe(scope)
    expect(lifecycleRefusalScope({ ...base, name: 'Renamed Open 2026' })).toBe(scope)
    expect(lifecycleRefusalScope({ ...base, address: null })).toBe(scope)
    expect(lifecycleRefusalScope({ ...base, description: 'Reworded.' })).toBe(scope)
  })

  it('is stable across a refetch that changed nothing', () => {
    expect(lifecycleRefusalScope(buildTournament())).toBe(
      lifecycleRefusalScope(buildTournament()),
    )
  })
})

describe('lifecycleRefusalNotice', () => {
  const START = LIFECYCLE_EDGE.published!
  const PUBLISH = LIFECYCLE_EDGE.draft!

  // The go-live precondition's 409 (ADR-0786). The server's sentence is kept WHOLE,
  // because it names the events the director has to go and fix — the one half of the
  // refusal they can act on, authored where the events are.
  it.each([
    'This tournament has no events, so there is nothing to start. Add an event and cut its draw, then start the tournament.',
    'This tournament cannot start yet: “Open Singles” has no draw yet. A draw is cut from the field as it stands at the time…',
    'This tournament cannot start yet: “Under 1200” has a draw that no longer matches its entrants. …',
    'This tournament cannot start yet: “Under 1200” has no draw yet; and “Over 40s” has a draw that no longer matches their entrants. …',
  ])('carries the server’s 409 sentence verbatim: %s', (detail) => {
    const notice = lifecycleRefusalNotice(
      new ApiError(409, detail, 'move the tournament'),
      START,
    )

    expect(notice.kind).toBe('refused')
    expect(notice.description).toBe(detail)
    // The title is the CLIENT's, and it names the edge that was clicked — not the wire
    // call that carried it.
    expect(notice.title).toBe("Couldn't start the tournament")
  })

  // The same 409 answers a stale tab (a re-asserted edge). It carries no code, so the
  // client does not try to tell the two apart — it shows the sentence, which is written
  // for exactly that reader.
  it('shows the stale-tab 409 the same way', () => {
    const notice = lifecycleRefusalNotice(
      new ApiError(409, 'This tournament is already published.', 'move the tournament'),
      PUBLISH,
    )

    expect(notice.kind).toBe('refused')
    expect(notice.title).toBe("Couldn't publish the tournament")
    expect(notice.description).toBe('This tournament is already published.')
  })

  it('has words of its own for a 403 — and does not blame the director', () => {
    const notice = lifecycleRefusalNotice(
      new ApiError(403, 'Only the creator can move this tournament.', 'move'),
      START,
    )

    expect(notice.kind).toBe('forbidden')
    expect(notice.title).toBe("You can't move this tournament")
    expect(notice.description).toContain('Nothing was changed')
  })

  it('names the edge’s verb when the session has gone (401)', () => {
    const notice = lifecycleRefusalNotice(new ApiError(401, null, 'move'), START)

    expect(notice.kind).toBe('signed-out')
    expect(notice.description).toContain('start the tournament')
  })

  // A 5xx detail is machinery ("Internal Server Error", a stack-shaped string): the
  // client owns this one entirely (`DEFINITION_OF_COMPLETE` — raw API detail strings
  // never reach the UI).
  it.each([500, 502, 503])('owns the copy for a %d', (status) => {
    const notice = lifecycleRefusalNotice(
      new ApiError(status, 'Internal Server Error', 'move'),
      START,
    )

    expect(notice.kind).toBe('server-error')
    expect(notice.description).not.toContain('Internal Server Error')
    expect(notice.description).toContain('nothing was changed')
  })

  // No response at all — a dead network. There is no server sentence to show, and
  // pretending there is ("the server rejected the request") would send the director
  // looking for a fault that is not there.
  it('says the request never got there when there was no response', () => {
    const notice = lifecycleRefusalNotice(new TypeError('Failed to fetch'), START)

    expect(notice.kind).toBe('unreachable')
    expect(notice.description).toContain('never reached the server')
    expect(notice.description).toContain('nothing was changed')
  })

  // The catch-all — a 404 on a tournament deleted in another tab. It is a designed case,
  // not a hole: there is no `null` arm anywhere in this function, because the header has
  // no toast to fall back on.
  it('still has something to say about an unexpected status', () => {
    const notice = lifecycleRefusalNotice(
      new ApiError(404, 'Tournament not found.', 'move'),
      START,
    )

    expect(notice.kind).toBe('unexpected')
    expect(notice.title).toBe("Couldn't start the tournament")
    expect(notice.description).toBe('Tournament not found.')
  })
})
