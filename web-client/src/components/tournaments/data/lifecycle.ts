// The tournament lifecycle, as the UI offers it (ADR-0017). Pure data + total
// functions: the component that renders the button (`LifecycleActions`) and the
// header that decides whether to give it a slot at all both read THIS table, so
// "which button?" and "is there a button?" cannot drift apart. The registration
// window lives here too, because a tournament's status *is* the state of its
// registration window — the two tables are the same lifecycle read from two ends.

import { Radio, Rocket, Square, type LucideIcon } from 'lucide-react'

import { ApiError } from '@/api/client'
import { formatRating } from '@/lib/rating'

import { drawRefusalScope } from './draw'
import { ENTRY_REFUSAL_NOTICE } from './entry-refusal'
import { myEntrant, predicateSentence } from './helpers'
import { fallbackNotice, type Notice } from './notice'
import type {
  EventEntryState,
  Tournament,
  TournamentEvent,
  TournamentStatus,
} from './types'

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
  /** Which consequence the confirm prices before this edge is posted — every edge has
   * one, because the lifecycle is forward-only and none of the three can be walked back
   * (ADR "a confirm prices an irreversible act, a freeze explains an illegal one").
   *
   * It sits on the edge for the same reason `verb` does: everything the UI knows about an
   * edge is on the edge, so a new one cannot acquire a button without also acquiring the
   * question asked before it. A separate table keyed on the target status would need an
   * unreachable `draft` row to stay total, and could disagree with this one.
   *
   * Spelled as bare literals rather than imported from
   * `IrreversibleActConsequence['variant']`: this is the data layer, and it must not
   * depend on the component that renders it. `LifecycleActions` makes the join, and the
   * compiler checks it there. */
  confirm: 'publish-tournament' | 'start-tournament' | 'end-tournament'
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
    confirm: 'publish-tournament',
  },
  published: {
    to: 'live',
    label: 'Start tournament',
    verb: 'start the tournament',
    icon: Radio,
    tone: 'go-live',
    confirm: 'start-tournament',
  },
  live: {
    to: 'archived',
    label: 'End tournament',
    verb: 'end the tournament',
    icon: Square,
    tone: 'ghost',
    confirm: 'end-tournament',
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

// ----- when the move is refused (ADR-0786, ADR-0017) -----------------------

/**
 * Everything a refused transition can be, as a sum type — one case per thing the header
 * can *render*, so a refusal cannot arrive as a bag of booleans (`isConflict`,
 * `isForbidden`, `isOffline`) whose combinations are mostly nonsense. Two of them true
 * at once is unrepresentable here; none of them true — the silent failure — is
 * unrepresentable too, because `lifecycleRefusalNotice` below is **total** and has no
 * `null` arm.
 *
 * The kinds are the outcomes, not the status codes: `refused` is the tournament saying
 * *no, not in this state* (a 409 — ADR-0017 chose 409 over 403 precisely because the
 * caller is allowed to do this, the tournament merely is not ready), while `forbidden`
 * is the server saying *not yours*. Same "it didn't happen", entirely different news.
 */
export type LifecycleRefusalKind =
  /** **409** — the move is legal for this caller, but not from where the tournament
   * stands. Two shapes, and the client cannot (and need not) tell them apart: a **stale
   * view** clicking an edge that no longer exists ("This tournament is already
   * published."), and go-live's **precondition** — no events, or an event with no draw
   * or a stale one, *named* (ADR-0786). Both arrive as a sentence written for the
   * director, and both are shown. */
  | 'refused'
  /** **403** — not the owner. The header offers no lifecycle button to anyone else
   * (ADR-0015), so this means the page is looking at somebody else's tournament. */
  | 'forbidden'
  /** **401** — the session is gone. */
  | 'signed-out'
  /** **5xx** — our fault, not the director's. */
  | 'server-error'
  /** The request never reached the server: no response at all (a dead network, a
   * `TypeError` from `fetch`). */
  | 'unreachable'
  /** Any other status. Reachable — a 404 on a tournament deleted from another tab — and
   * kept as its own case rather than folded into `server-error`, because "we broke" and
   * "something else happened" are not the same claim to make to a user. */
  | 'unexpected'

/** A refused transition, in words the header can render: the case it fell into, plus the
 * `Notice` (client-owned title, server-authored sentence where that sentence is the
 * point) — see `./notice`. */
export interface LifecycleRefusal extends Notice {
  kind: LifecycleRefusalKind
}

/**
 * The facts a lifecycle refusal is **about**, as one string — what `useScopedNotice`
 * pins the header's notice to, so a refusal clears itself once the director fixes the
 * thing it named instead of sitting there contradicting the page (#1049, #1216).
 *
 * It is deliberately **narrow**, and this list is the place to think before adding to it.
 * Only `start` has a precondition (ADR-0786), and the precondition is exactly: there is at
 * least one event, every event's draw still **seats exactly its entrants**, and every
 * event that still needs a cut is one a cut could actually produce (#1300). So the scope
 * is, per event, its identity, its **name**, and everything a *draw* refusal is about —
 * `drawRefusalScope`.
 *
 * ## Why it composes `drawRefusalScope` instead of listing the facts again
 *
 * Since #1300 the go-live guard **dry-runs the cut** for every at-fault event and quotes
 * the planner's own refusal back at the director: "A doubles event cannot be given a
 * draw…", "1 entrant across 1 group would leave a group with fewer than 2 entrants…",
 * "Taking 3 qualifiers from each group is more than the 2 entrants in the smallest group…",
 * "play fewer rounds". Those are the *panel's* sentences, arriving in the *header's*
 * refusal — so the header's scope has to read every fact the panel's does: the format, the
 * draw type and its settings (`drawConfig`), the group ids, and the seating.
 *
 * Restating that list here is the failure mode, not the safe option. Two hand-written
 * copies of "what a draw refusal is about" drift the moment one of them gains a fact —
 * and the drift is silent, because the scope that fell behind still returns a perfectly
 * good string. It just stops moving when the director does the thing the sentence asked,
 * which is #1123 wearing a new sentence. Composing `drawRefusalScope` makes the two the
 * same list by construction: a fifth draw type acquires a setting in one place, and both
 * scopes read it. (It is also a strict superset of the seating this used to read, so
 * every refusal this scope already retired is still retired.)
 *
 * The **name** is here for a different reason from the rest, and it is the one entry that
 * is not about whether the refusal is still *true*. This 409's sentence **quotes the
 * events at fault** ("“Open Singles” has no draw yet"), so a rename leaves the header
 * telling the director to go and cut the draw for an event no longer on the page under
 * that name — the refusal still correct and still unreadable. A sentence that names
 * something is a sentence about that name.
 *
 * The seating is read as identities rather than counts, and that is load-bearing: the
 * third shape of the refusal is "*has a draw that no longer matches its entrants*", which
 * arises when somebody enters and somebody withdraws. That leaves `entered` and
 * `fixtures.length` both unchanged, and re-cutting to fix it leaves them unchanged again —
 * so a scope built from the counts could not see the director doing the very thing the
 * sentence asked them to do.
 *
 * What is **left out** matters as much. The *tournament's* name, its venue, its description
 * and `latestScheduleSolve` are all absent, because no lifecycle refusal quotes or asserts
 * anything about them and this page polls (~3s on the Schedule tab): a scope that moved on
 * a solve tick would blink the director's work list off the screen mid-read. (An event's
 * name is in, and the tournament's is out, for exactly the same test — one is quoted in the
 * sentence and the other is not.)
 *
 * ## The status is left out too, and that one is not an oversight
 *
 * It looks like the obvious first field, and it is the one field that must NOT be here.
 * The other 409 this surface reports is the **stale tab**: the director published from
 * their phone, this page still shows a draft, they click Publish, and the server answers
 * "This tournament is already published." That refusal exists precisely to explain the
 * reconciliation that lands a moment later — the mutation refetches on settle, and the
 * badge and button correct themselves from Draft/Publish to Published/Start *under the
 * notice*.
 *
 * So the status changing is not evidence that the refusal is stale. It is the refusal
 * coming true. A scope carrying `status` would retire the sentence at the exact instant
 * the page did the confusing thing the sentence was there to explain, leaving the director
 * watching the button change with no account of why their click did nothing. (This is not
 * hypothetical: it is what `tournament-lifecycle.spec.ts`'s "the stale view corrects
 * itself" caught.)
 *
 * Nothing is lost by omitting it. Every refusal with a precondition is about the events,
 * which are here; and a status that moves forward legitimately takes its events with it.
 */
export function lifecycleRefusalScope(tournament: Tournament): string {
  return tournament.events
    .map((ev) => `${ev.id}:${ev.name}:${drawRefusalScope(ev)}`)
    .join('|')
}

/**
 * Turn a failed transition into the copy the director reads, beside the button they
 * clicked.
 *
 * **The 409 carries the server's own sentence, verbatim**, and that is the whole design.
 * Going live has a precondition (ADR-0786): every event must have a draw, and every draw
 * must still seat exactly its event's entrants — registration stays open right up to the
 * moment a tournament starts, so a draw cut on Tuesday can be stale by Wednesday. When
 * that precondition fails, the server refuses the start with a 409 whose detail **names
 * the events at fault** ("This tournament cannot start yet: “Open Singles” has no draw
 * yet…"). That naming is the only actionable half of the refusal: a director with ten
 * events, told merely "something isn't ready", is left clicking through all ten. So the
 * client does not paraphrase it — it frames it. The title is ours ("Couldn't start the
 * tournament", named after the edge they clicked, never after the wire call); the
 * sentence beneath is the server's.
 *
 * It is the same 409 that answers a **stale tab** re-asserting an edge that no longer
 * exists, and the two are deliberately NOT told apart: the refusal carries no code
 * (ADR-0968's coded refusals are the entry route's), and string-sniffing the detail to
 * choose a title would be a client re-deriving a judgement the server already made. Both
 * shapes are sentences written for the director, and both are shown under a title that is
 * true of both — the click did not take effect, and here is why.
 *
 * The other arms are designed states, not a shrug: 403, 401, 5xx and a dead network each
 * get words of their own. There is **no `null` arm** — the header surfaces this mutation's
 * errors inline and carries no toast (`web-client/CLAUDE.md`, ## Forms: never both), so a
 * `null` here would be the click that did nothing and said nothing.
 */
export function lifecycleRefusalNotice(
  error: unknown,
  edge: LifecycleEdge,
): LifecycleRefusal {
  const fallback = fallbackNotice(error, edge.verb)
  if (!(error instanceof ApiError)) {
    return {
      kind: 'unreachable',
      title: fallback.title,
      description:
        'The request never reached the server, so nothing was changed. Check your ' +
        'connection and try again.',
    }
  }

  if (error.status >= 500) {
    return {
      kind: 'server-error',
      title: 'Something went wrong on our end',
      // Never the server's sentence here: a 5xx detail is machinery, not copy
      // (`DEFINITION_OF_COMPLETE`: raw API detail strings never reach the UI).
      description: `The tournament was not moved. Try again in a moment — nothing was changed.`,
    }
  }

  switch (error.status) {
    case 409:
      return {
        kind: 'refused',
        title: fallback.title,
        // The server's sentence — it names the events (ADR-0786), or names the status
        // somebody else already moved this tournament to. The fallback exists only for a
        // 409 that somehow arrives without one, and it says the one thing that is true of
        // every shape of it: re-read the page.
        description:
          error.detail ??
          'The tournament is not in a state this move can be made from. Reload the page to see where it stands.',
      }
    case 403:
      return {
        kind: 'forbidden',
        title: "You can't move this tournament",
        description:
          'Only the tournament’s creator can publish, start or end it. Nothing was changed.',
      }
    case 401:
      return {
        kind: 'signed-out',
        title: 'You are signed out',
        description: `Sign in again, then ${edge.verb}. Nothing was changed.`,
      }
    default:
      return { kind: 'unexpected', ...fallback }
  }
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
 * one case per thing the card can *render*, and the ORDER they are decided in is
 * the whole rule:
 *
 * 1. `hidden` — the request could only ever fail *for this caller*: the session
 *    request has not landed yet (we cannot even say who "we" are), or the event
 *    is doubles/teams (400). No act of the director's will change that on this
 *    page, so there is **nothing to report**: a fact about you is not a state of
 *    the tournament. The two reasons are not two cases, because nothing
 *    downstream can tell them apart — both render silence, and neither carries
 *    anything to render. (Entering needs no permission any more — #1092 deleted
 *    `tournament.enter` — so the old 403 case is gone; the in-flight guard it
 *    shared a branch with stays, and is load-bearing.)
 * 2. `closed` — the registration *window* is shut. That is a fact about the
 *    **tournament**, and it changes: it opens when the director publishes and
 *    shuts again when they start play. So it renders as a state — not as silence,
 *    and not as a bare disabled button ("empty is a designed data state, never a
 *    thrown one"). "Not open yet" and "entries locked" are likewise not two cases
 *    but one: the difference between a door not yet unlocked and a door shut again
 *    is carried by the `lead` + `reason` copy (`REGISTRATION_WINDOW` above), which
 *    is the only thing that differed about them.
 * 3. `withdraw` — the player is already in. It is decided BEFORE the event's own
 *    refusals, and that is not a detail: **an entrant in a FULL event must still be
 *    able to leave it.** Judging capacity first would trap every entrant in the
 *    very event they are in — and would do it silently, since a full event is the
 *    normal end state of a popular one. (It is also what the server does: the
 *    capacity count is over *other* people's entries; yours is already counted.)
 * 4. `full` / `ineligible` — the window is open, the player is not in, and the
 *    **event itself** refuses them: it has no room (`event_full`), or their rating
 *    fails one of its rules (`rating_ineligible`). Both render as designed states,
 *    with the same lead+reason voice as `closed` and — again — **never a disabled
 *    Enter button** (ADR-0015: hide the mutating affordance and explain; a dead
 *    button is an unexplained dead end).
 * 5. `enter` — nothing is in the way.
 *
 * Cases 4 and 5 are simply what `event.entry_state` says (`EventEntryState`,
 * `./types`). They are **not re-derived** from `entered` / `maxPlayers` / the raw
 * `predicates` JSON: eligibility is computed in exactly one place, server-side
 * (ADR-0783), and a second rule engine in a second language would drift from it.
 * That includes the server's own precedence — an ineligible player looking at a
 * full event is told they are ineligible — which arrives already decided, in the
 * one tag.
 */
export type EntryControlState =
  | { kind: 'hidden' }
  | { kind: 'closed'; lead: string; reason: string }
  | { kind: 'full'; lead: string; reason: string }
  | { kind: 'ineligible'; lead: string; reason: string }
  | { kind: 'enter' }
  /** The player's OWN entry id — an entry is withdrawn by its id, and this is the
   * only place that join (on username, via `myEntrant`) is made. */
  | { kind: 'withdraw'; entryId: string }

/** Why a rating-ineligible player is refused, **in this event's own words**: the
 * rule that refused them, read back through `predicateSentence` — the same
 * formatter the read-only event panel uses (ADR-0015 rule 4: "rows that are
 * sentences render as sentences") — followed by the rating they were judged on.
 *
 * "Rating is less than 1500. Your rating is 1662." Both halves are needed: the
 * rule alone does not say why *you* failed it, and the rating alone does not say
 * what it failed.
 *
 * The rating is printed through **`formatRating`** (`@/lib/rating`) — the app's
 * one rating formatter — and not by dropping the raw number into the template.
 * What the server sends is a Glicko float: interpolating it printed *"Your rating
 * is 1662.3108939062977."* on a page where every other surface said `1662`,
 * because a fixture of `1650` makes `${1650}` and `${Math.round(1650)}` the same
 * string and the round number hid the bug. `formatRating` renders `null` as an
 * em-dash; `rating` is a `number` in this arm of the union, so that cannot arise
 * from a well-formed payload — but a malformed one degrades to "Your rating is
 * —." rather than crashing the card.
 *
 * `predicate_id` addresses a rule in the event's own `predicates`, so the payload
 * does not re-send the rule (a field and its own derivation could disagree). If
 * the id resolves to nothing — a rule edited out from under a stale page — the
 * generic copy from the refusal table is the honest degrade, never a half-built
 * sentence. */
function ineligibleReason(
  event: TournamentEvent,
  state: Extract<EventEntryState, { state: 'rating_ineligible' }>,
): string {
  const rule = event.predicates.find((p) => p.id === state.predicateId)
  if (!rule) return ENTRY_REFUSAL_NOTICE.rating_ineligible.description
  return `${predicateSentence(rule)}. Your rating is ${formatRating(state.rating)}.`
}

export function entryControlState({
  status,
  event,
  sessionLoaded,
  username,
}: {
  status: TournamentStatus
  event: TournamentEvent
  /** Has the session request settled? False while it is still in flight, which
   * is exactly the load-bearing guard it replaced: we cannot tell Enter from
   * Withdraw — nor even who "we" are — until it lands. Entering needs no
   * permission any more (#1092), so there is nothing left to check membership
   * of; what must stay is the in-flight gate, or an entered player would
   * briefly see Enter instead of Withdraw and a click in that window would
   * double-submit into a 409 for doing nothing wrong. */
  sessionLoaded: boolean
  username: string | null | undefined
}): EntryControlState {
  // 1. Facts about the CALLER — nothing to report, in any status.
  if (!sessionLoaded) return { kind: 'hidden' }
  if (event.format !== 'singles') return { kind: 'hidden' }

  // 2. The window, BEFORE membership — this is the ordering the whole type exists
  //    to enforce: an entered player on a `live` tournament is `closed`, not
  //    `withdraw`.
  const registration = REGISTRATION_WINDOW[status]
  if (registration.state !== 'open') {
    const { lead, reason } = registration
    return { kind: 'closed', lead, reason }
  }

  // 3. Already in? Then the only act left is leaving — and it stays available even
  //    when the event is FULL (a full event is exactly the one you'd want out of)
  //    or when its rules no longer admit you. Membership therefore outranks the
  //    event's refusals below; the reverse order would lock every entrant in.
  const entry = myEntrant(event, username)
  if (entry) return { kind: 'withdraw', entryId: entry.id }

  // 4. What the EVENT says about this caller entering it — the server's judgement,
  //    rendered, never recomputed (ADR-0783). The copy is the refusal table's
  //    (`./entry-refusal`), which is the same table the 409 on `POST …/entries`
  //    reads: one refusal, one set of words, whichever way we learned it.
  const notice = ENTRY_REFUSAL_NOTICE
  const entryState = event.entryState
  switch (entryState.state) {
    case 'open':
      return { kind: 'enter' }
    case 'event_full':
      return {
        kind: 'full',
        lead: notice.event_full.title,
        reason: notice.event_full.description,
      }
    case 'rating_ineligible':
      return {
        kind: 'ineligible',
        lead: notice.rating_ineligible.title,
        reason: ineligibleReason(event, entryState),
      }
    default: {
      // A state the API grew and this client has not: a TYPE error here. At
      // runtime it cannot happen — `apiToEntryState` (`./api`) already degraded
      // any unknown tag to `open` at the wire boundary — but the compiler is what
      // makes the next refusal (#784) impossible to forget.
      const exhaustive: never = entryState
      void exhaustive
      return { kind: 'enter' }
    }
  }
}
