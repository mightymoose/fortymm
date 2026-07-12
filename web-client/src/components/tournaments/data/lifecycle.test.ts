import { describe, expect, it } from 'vitest'

import {
  entryControlState,
  lifecycleEdgeFor,
  LIFECYCLE_EDGE,
  REGISTRATION_WINDOW,
} from './lifecycle'
import { buildEntrant, buildEvent, buildTournament } from './seed.factory'
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
