// The tournament lifecycle, as the UI offers it (ADR-0017). Pure data + total
// functions: the component that renders the button (`LifecycleActions`) and the
// header that decides whether to give it a slot at all both read THIS table, so
// "which button?" and "is there a button?" cannot drift apart. The registration
// window lives here too, because a tournament's status *is* the state of its
// registration window — the two tables are the same lifecycle read from two ends.

import { Radio, Rocket, Square, type LucideIcon } from 'lucide-react'

import { myEntrant } from './helpers'
import type { Tournament, TournamentEvent, TournamentStatus } from './types'

/**
 * What an edge MEANS, visually — not how it looks. Going live is the one edge
 * that changes the state of the world for everyone watching (the field is fixed,
 * the draw is cut from it), and it is toned to say so; ending is a quiet,
 * receding act. The class strings that cash these out live with the component
 * that renders them (`LifecycleActions`), so this table stays a table of
 * lifecycle facts rather than a place style leaks into the data layer.
 */
export type LifecycleTone = 'default' | 'go-live' | 'ghost'

/** The button that stands for one edge of the lifecycle. */
export interface LifecycleEdge {
  /** The status this edge moves *to* — the body of the transition request. */
  to: TournamentStatus
  /** What the button says. */
  label: string
  /** How the edge is *named* to the person who asked for it, so a failure reads
   * as the thing they clicked ("Couldn't publish the tournament") rather than as
   * the wire ("Couldn't POST a transition"). It sits on the edge, next to the
   * label, because it is the same fact in another voice: a second table keyed by
   * the target status could disagree with this one about what an edge is. */
  verb: string
  icon: LucideIcon
  tone: LifecycleTone
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
 *
 * Everything the UI knows about an edge is on the edge: where it goes, what the
 * button says, what the *failure* says, and what it means. `draft` appears here as
 * a source, never as a target — nothing un-publishes (ADR-0017) — which is why the
 * mutation takes the edge itself rather than a bare target status: a lookup keyed
 * by "where it lands" would need an unreachable `draft` row to stay total.
 */
export const LIFECYCLE_EDGE: Record<TournamentStatus, LifecycleEdge | null> = {
  draft: {
    to: 'published',
    label: 'Publish',
    verb: 'publish the tournament',
    icon: Rocket,
    tone: 'default',
  },
  published: {
    to: 'live',
    label: 'Start tournament',
    verb: 'start the tournament',
    icon: Radio,
    tone: 'go-live',
  },
  live: {
    to: 'archived',
    label: 'End tournament',
    verb: 'end the tournament',
    icon: Square,
    tone: 'ghost',
  },
  archived: null,
}

/** The lifecycle action this tournament offers — the one edge legal from where it
 * stands — or `null` when it offers none: a viewer (transitions are owner-only,
 * 403 server-side), or the terminal `archived`.
 *
 * One accessor, asked by both the detail header (which needs to know whether to
 * give the action slot to anything at all, since `PageHeading` wraps a truthy
 * action in a spacing div) and by `LifecycleActions` (which needs the edge to
 * render and to post). A predicate would answer the first question but leave the
 * second to a second lookup — two reads of one table, which can disagree. */
export function lifecycleEdgeFor(tournament: Tournament): LifecycleEdge | null {
  return tournament.canEdit ? LIFECYCLE_EDGE[tournament.status] : null
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
 * the server owns (`_registration_open` decides; `_enforce_registration_open`
 * turns a refusal into the 409 and its words — `api/app/tournaments.py`). This
 * table exists so the card never *offers* an Enter the server would refuse: every
 * non-`published` status is a designed state here, never a button.
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
 * Everything the event card's entry control can be, as one discriminated union —
 * four cases, one per thing the card can *render*, and the ORDER they are decided
 * in is the whole rule:
 *
 * 1. `hidden` — the request could only ever fail *for this caller*: they lack
 *    `tournament.enter` (403), or the event is doubles/teams (400). No act of the
 *    director's will change that on this page, so there is **nothing to report**:
 *    a fact about you is not a state of the tournament. The two reasons are not
 *    two cases, because nothing downstream can tell them apart — both render
 *    silence, and neither carries anything to render.
 * 2. `closed` — the registration *window* is shut. That is a fact about the
 *    **tournament**, and it changes: it opens when the director publishes and
 *    shuts again when they start play. So it renders as a state — not as silence,
 *    and not as a bare disabled button ("empty is a designed data state, never a
 *    thrown one"). "Not open yet" and "entries locked" are likewise not two cases
 *    but one: the difference between a door not yet unlocked and a door shut again
 *    is carried by the `lead` + `reason` copy (`REGISTRATION_WINDOW` above), which
 *    is the only thing that differed about them.
 * 3. `enter` / `withdraw` — the window is open and the only question left is
 *    whether the player is already in.
 *
 * The window is judged BEFORE membership, which is what makes the entered player
 * on a `live` tournament come out `closed` rather than `withdraw`: they are still
 * an entrant (their chip is still on the roster — the field is fixed, that is what
 * going live *means*), they simply cannot take themselves out of it. A Withdraw
 * button there would be a 409 with a nice icon.
 */
export type EntryControlState =
  | { kind: 'hidden' }
  | { kind: 'closed'; lead: string; reason: string }
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
  // 1. Facts about the CALLER — nothing to report, in any status.
  if (!canEnter) return { kind: 'hidden' }
  if (event.format !== 'singles') return { kind: 'hidden' }

  // 2. The window, BEFORE membership — this is the ordering the whole type exists
  //    to enforce: an entered player on a `live` tournament is `closed`, not
  //    `withdraw`.
  const registration = REGISTRATION_WINDOW[status]
  if (registration.state !== 'open') {
    const { lead, reason } = registration
    return { kind: 'closed', lead, reason }
  }

  // 3. Open: the only question left is whether they are already in.
  const entry = myEntrant(event, username)
  return entry ? { kind: 'withdraw', entryId: entry.id } : { kind: 'enter' }
}
