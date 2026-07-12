// The tournament lifecycle, as the UI offers it (ADR-0017). Pure data + total
// functions: the component that renders the button (`LifecycleActions`) and the
// header that decides whether to give it a slot at all both read THIS table, so
// "which button?" and "is there a button?" cannot drift apart. The registration
// window lives here too, because a tournament's status *is* the state of its
// registration window — the two tables are the same lifecycle read from two ends.

import { Radio, Rocket, Square, type LucideIcon } from 'lucide-react'

import { myEntrant } from './helpers'
import type { Tournament, TournamentEvent, TournamentStatus } from './types'

/** The button that stands for one edge of the lifecycle. */
export interface LifecycleEdge {
  /** The status this edge moves *to* — the body of the transition request. */
  to: TournamentStatus
  label: string
  icon: LucideIcon
  variant?: 'ghost'
  className?: string
}

/**
 * The forward-only path, one entry per status:
 *
 *     draft ──Publish──▶ published ──Start──▶ live ──End──▶ archived
 *
 * `archived` is terminal — no edge out of it, so `null`: no button, rather than a
 * button whose only possible answer is a 409. The server holds the same table
 * (`LEGAL_TRANSITIONS` in `api/app/tournaments.py`) and is the authority; this one
 * exists so the UI never *offers* an edge the server would refuse. A status picker
 * would offer all four — i.e. mostly illegal jumps — which is why there isn't one.
 */
export const LIFECYCLE_EDGE: Record<TournamentStatus, LifecycleEdge | null> = {
  draft: { to: 'published', label: 'Publish', icon: Rocket },
  published: {
    to: 'live',
    label: 'Start tournament',
    icon: Radio,
    className:
      'border border-[color:rgba(0,226,154,0.35)] bg-[color:rgba(0,226,154,0.1)] text-[color:var(--serve-500)] hover:bg-[color:rgba(0,226,154,0.18)]',
  },
  live: {
    to: 'archived',
    label: 'End tournament',
    icon: Square,
    variant: 'ghost',
  },
  archived: null,
}

/** Whether this tournament offers a lifecycle action at all: an owner, standing
 * on a status that has an edge out of it. The detail header asks *before* it
 * renders its action slot, so a viewer — and an archived tournament — leaves that
 * slot genuinely empty instead of filling it with a wrapper around nothing. */
export function hasLifecycleAction(tournament: Tournament): boolean {
  return tournament.canEdit && LIFECYCLE_EDGE[tournament.status] !== null
}

/**
 * What a status has to say about entering: the registration window, as a sum
 * type, because "closed" is not one state but two and they mean opposite things
 * in time — `not-open-yet` is a door that has not been unlocked, `locked` is one
 * that has been shut. Only `published` is open.
 *
 * The copy is a **lead + reason** pair (the idiom the entrants-list empty states
 * already use): the lead is the state, the reason is why — because "Not open yet"
 * on its own is a fact with no cause, and a player looking at an event they can
 * see but cannot enter is owed the cause.
 */
export type RegistrationWindow =
  | { state: 'open' }
  | { state: 'not-open-yet'; lead: string; reason: string }
  | { state: 'locked'; lead: string; reason: string }

/**
 * The window each status opens, one entry per status — the client's reading of
 * the table in ADR-0017 ("Entering and withdrawing require `published`"), which
 * the server enforces (`_require_open_for_entry` in `api/app/tournaments.py`,
 * 409). This table exists so the card never *offers* an Enter the server would
 * refuse: every non-`published` status is a designed state here, never a button.
 *
 * It sits beside `LIFECYCLE_EDGE` on purpose. Publishing is what opens
 * registration and going live is what locks it, so the edges and the window are
 * one lifecycle: put them in one file and a new status cannot acquire a button
 * without also acquiring an answer to "can I enter?".
 */
export const REGISTRATION_WINDOW: Record<TournamentStatus, RegistrationWindow> =
  {
    draft: {
      state: 'not-open-yet',
      lead: 'Not open yet',
      reason: 'Entry opens when this tournament is published.',
    },
    published: { state: 'open' },
    live: {
      state: 'locked',
      lead: 'Entries locked',
      reason: 'The tournament is under way.',
    },
    archived: {
      state: 'locked',
      lead: 'Entries locked',
      reason: 'The tournament has ended.',
    },
  }

/**
 * Everything the event card's entry control can be, as one discriminated union
 * — the six cases are mutually exclusive, and the ORDER they are decided in is
 * the whole rule:
 *
 * 1. `unpermitted` / `not-singles` — the request could only ever fail *for this
 *    caller* (403 / 400), and no act of the director's will change that on this
 *    page. Both render **nothing**: a fact about you is not a state of the
 *    tournament, and there is nothing to report.
 * 2. `not-open-yet` / `locked` — the registration *window* is shut. That is a
 *    fact about the **tournament**, and it changes: it opens when the director
 *    publishes and shuts again when they start play. So it renders as a state,
 *    not as silence and not as a bare disabled button ("empty is a designed data
 *    state, never a thrown one").
 * 3. `enter` / `withdraw` — the window is open and the only question left is
 *    whether the player is already in.
 *
 * The window is judged BEFORE membership, which is what makes the entered player
 * on a `live` tournament come out `locked` rather than `withdraw`: they are still
 * an entrant (their chip is still on the roster — the field is fixed, that is what
 * going live *means*), they simply cannot take themselves out of it. A Withdraw
 * button there would be a 409 with a nice icon.
 */
export type EntryControlState =
  | { kind: 'unpermitted' }
  | { kind: 'not-singles' }
  | { kind: 'not-open-yet'; lead: string; reason: string }
  | { kind: 'locked'; lead: string; reason: string }
  | { kind: 'enter' }
  /** The player's OWN entry id — an entry is withdrawn by its id, and this is the
   * only place that join (on username, via `myEntrant`) is made. */
  | { kind: 'withdraw'; entryId: string }

export function entryControlState({
  status,
  event,
  canEnter,
  username,
}: {
  status: TournamentStatus
  event: TournamentEvent
  /** Does the viewer hold `tournament.enter`? False while the session is still in
   * flight, which is exactly right: we cannot tell Enter from Withdraw — nor even
   * who "we" are — until it lands. */
  canEnter: boolean
  username: string | null | undefined
}): EntryControlState {
  if (!canEnter) return { kind: 'unpermitted' }
  if (event.format !== 'singles') return { kind: 'not-singles' }

  const registration = REGISTRATION_WINDOW[status]
  if (registration.state !== 'open') {
    const { state, lead, reason } = registration
    return { kind: state, lead, reason }
  }

  const entry = myEntrant(event, username)
  return entry ? { kind: 'withdraw', entryId: entry.id } : { kind: 'enter' }
}
