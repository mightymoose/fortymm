import { describe, expect, it } from 'vitest'

import {
  entryControlState,
  hasLifecycleAction,
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
})

describe('REGISTRATION_WINDOW', () => {
  // ADR-0017's table, and the server's `_require_open_for_entry` guard: exactly
  // ONE status opens the window. A second open status here would be an Enter
  // button the API answers with a 409.
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
  // about a registration window they could never have used.
  it.each(['draft', 'published', 'live', 'archived'] as const)(
    'is unpermitted on a %s tournament for a player without tournament.enter',
    (status) => {
      expect(state({ status, canEnter: false })).toEqual({
        kind: 'unpermitted',
      })
    },
  )

  it.each(['doubles', 'teams'] as const)(
    'is not-singles for a %s event, whatever the status',
    (format) => {
      expect(state({ event: buildEvent({ format }), status: 'draft' })).toEqual({
        kind: 'not-singles',
      })
    },
  )

  // The window, decided before membership — the crux of this slice.
  it('reports the shut window on a draft tournament instead of offering enter', () => {
    expect(state({ status: 'draft', event: emptyEvent })).toMatchObject({
      kind: 'not-open-yet',
      lead: 'Not open yet',
    })
  })

  it.each(['live', 'archived'] as const)(
    'reports entries locked on a %s tournament instead of offering enter',
    (status) => {
      expect(state({ status, event: emptyEvent })).toMatchObject({
        kind: 'locked',
        lead: 'Entries locked',
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
        kind: 'locked',
      })
    },
  )

  it('does not offer withdraw to an entered player before publication either', () => {
    expect(state({ status: 'draft', event: enteredEvent })).toMatchObject({
      kind: 'not-open-yet',
    })
  })
})

describe('hasLifecycleAction', () => {
  // What the header asks BEFORE it renders its action slot, so a viewer (and an
  // archived tournament) leaves that slot genuinely empty rather than filling it
  // with a wrapper around a component that renders nothing.
  it.each([
    { status: 'draft', canEdit: true, expected: true },
    { status: 'published', canEdit: true, expected: true },
    { status: 'live', canEdit: true, expected: true },
    { status: 'archived', canEdit: true, expected: false },
    { status: 'draft', canEdit: false, expected: false },
    { status: 'published', canEdit: false, expected: false },
    { status: 'live', canEdit: false, expected: false },
    { status: 'archived', canEdit: false, expected: false },
  ] as const)(
    'is $expected for a $status tournament with canEdit=$canEdit',
    ({ status, canEdit, expected }) => {
      expect(hasLifecycleAction(buildTournament({ status, canEdit }))).toBe(
        expected,
      )
    },
  )
})
