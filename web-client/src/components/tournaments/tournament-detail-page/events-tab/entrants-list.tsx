import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

import { myEntrant } from '../../data/helpers'
import { FORMAT_OPTIONS } from '../../data/options'
import type { Entrant, TournamentEvent } from '../../data/types'
import { LeadReason } from './lead-reason'

/**
 * How many entrants a card lists before it collapses the rest into a "+N more"
 * tail.
 *
 * An event can hold up to `max_players` people (the dev store seeds one with 52,
 * and a 64-slot draw is normal), and the card is a *summary row* in a list of
 * events — a 64-chip roster would push the next card off the screen and bury the
 * card's own controls. So the card shows the first few and says, honestly, how
 * many it is not showing. The full roster belongs to the event view / draw sheet
 * that seeding (#785) brings with it, not to a row card.
 *
 * The tail is deliberately **text, not a "show more" button**: the card is
 * covered by a stretched open-target overlay, so any control here would be a
 * second interactive element competing with it — and a scroll box instead would
 * trip axe's `scrollable-region-focusable` rule and swallow the wheel under that
 * same overlay.
 */
const MAX_VISIBLE = 8

/**
 * What the roster has to say — as a sum type, because "no entrants" is not one
 * state but two, and they mean opposite things:
 *
 * - `empty` — an event you *can* enter, that nobody has entered yet. An
 *   invitation: be the first.
 * - `entry-closed` — a doubles or teams event. Nobody can enter it **at all**: one
 *   entry row cannot express a pairing, so the API rejects entry and the card
 *   offers no Enter control (ADR-0016). "No one has entered yet" would be a lie
 *   here — it promises a door that does not exist.
 *
 * Collapsing the two into `entrants.length === 0` is the client-side twin of a
 * tri-state boolean: it makes one optimistic sentence cover a case where it is
 * false. Hence the discriminated union — the renderer switches on it, and a
 * fourth state (a full event, say) becomes a compiler error rather than a
 * silently wrong sentence.
 */
type RosterState =
  | {
      kind: 'listed'
      visible: Entrant[]
      hidden: number
      /** The signed-in player's own entry id, when they are one of the entrants
       * — the chip to mark as theirs. `null` for a signed-out viewer, or one who
       * is not in this event. */
      myEntryId: string | null
    }
  | { kind: 'empty' }
  | { kind: 'entry-closed'; formatLabel: string }

function rosterState(
  event: TournamentEvent,
  username: string | null | undefined,
): RosterState {
  // Entrants first, whatever the format: the roster renders what the server gives
  // it. A non-singles event cannot accrue entrants *today*, but if director-entry
  // (#784) ever puts people in one, listing them beats insisting it is closed.
  if (event.entrants.length > 0) {
    const mine = myEntrant(event, username)
    // The signed-in player's own chip is PINNED to the front of the visible slice
    // (#781). The server lists entrants oldest-entry-first, so entering an event
    // that already has `MAX_VISIBLE` people appends you past the truncation
    // cut-off: the count ticked up, the control flipped to Withdraw — and a plain
    // `slice(0, MAX_VISIBLE)` then showed you a roster you were not in. Being told
    // you are in and shown a list you are not in is the one thing this component
    // must never do.
    //
    // Hoisting REORDERS the roster; it adds nobody and drops nobody (self is
    // deduped by entry id), so everyone else stays oldest-first behind you.
    const ordered = mine
      ? [mine, ...event.entrants.filter((e) => e.id !== mine.id)]
      : event.entrants
    const visible = ordered.slice(0, MAX_VISIBLE)
    return {
      kind: 'listed',
      visible,
      // Derived from what is actually SHOWN, never from `MAX_VISIBLE`: that is
      // what keeps the tail exact whether or not self was pulled out of it, with
      // no off-by-one to get wrong.
      hidden: event.entrants.length - visible.length,
      myEntryId: mine?.id ?? null,
    }
  }
  if (event.format !== 'singles') {
    const formatLabel =
      FORMAT_OPTIONS.find((f) => f.value === event.format)?.label ?? event.format
    return { kind: 'entry-closed', formatLabel }
  }
  return { kind: 'empty' }
}

export interface EntrantsListProps {
  event: TournamentEvent
  /**
   * The signed-in player's username — the join key for "which of these entrants
   * is me" (`myEntrant`: the session carries a username but no user id). Absent
   * for a signed-out viewer, or while the session is still in flight; then the
   * roster is simply the server's order, with nobody marked.
   */
  username?: string | null
}

/**
 * The roster on an event card: who is *actually* in this event.
 *
 * The list is exactly the people in `event.entrants` — nobody added, nobody
 * dropped; only the ORDER is the component's own (see `rosterState`: the
 * signed-in player's chip is pinned to the front, so a truncated roster can
 * never hide you from yourself). Withdrawn players are already absent from the
 * payload — the server derives both the list and the `entered` count from the
 * ACTIVE entries only (ADR-0016) — so there is nothing to filter here, and
 * filtering would be a second, drift-prone copy of that rule.
 *
 * Having no entrants is a **data state, not a gap**: it renders designed copy
 * rather than an empty `<ul>` — and *which* copy depends on whether the event can
 * be entered at all (see `RosterState`). Nothing is ever hidden: a blank card
 * section is precisely the failure the empty-state rule exists to prevent, so the
 * non-singles case gets honest copy rather than silence.
 *
 * Entering and withdrawing move a name in and out of this list for free — both
 * mutations invalidate the tournament, so the card re-renders from the refetched
 * event. This component owns no state and no controls: it is inert, which is what
 * lets it sit under the card's stretched open-target overlay.
 *
 * Seeds (`Entrant.seed`) are not shown: nothing assigns them until draw
 * generation (#785), so today they are uniformly `null`.
 */
export const EntrantsList = ({ event, username }: EntrantsListProps) => {
  const state = rosterState(event, username)

  return (
    <div className="border-t border-[color:var(--border-subtle)] px-[18px] py-3">
      <div className="text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">
        Entrants
      </div>
      <RosterBody state={state} eventName={event.name} />
    </div>
  )
}

const RosterBody = ({
  state,
  eventName,
}: {
  state: RosterState
  eventName: string
}) => {
  switch (state.kind) {
    case 'listed':
      return (
        // Named per event, not merely "Entrants": a tab holds many cards, and a
        // screen reader running the list rotor needs to tell one roster from the
        // next.
        <ul
          aria-label={`Entrants in ${eventName}`}
          className="mt-2 flex flex-wrap items-center gap-1.5"
        >
          {state.visible.map((entrant) => {
            const isMe = entrant.id === state.myEntryId
            return (
              <Badge
                key={entrant.id}
                asChild
                variant="ghost"
                className={cn(
                  'border-[color:var(--border-subtle)]',
                  // Your own chip carries the accent treatment the card uses for
                  // its "Rated" badge — the pinned chip is a *reorder*, so it has
                  // to say why it jumped the queue.
                  isMe &&
                    'border-[color:rgba(255,122,26,0.3)] bg-[color:var(--bg-accent-soft)] text-[color:var(--ball-500)]',
                )}
              >
                {/* Rendered as the <li> itself (`asChild`), so the list stays a
                    list: <ul> may only parent <li>. The username is its own
                    element, so the "(you)" tag reads as a separate word to a
                    screen reader instead of fusing into the name. */}
                <li>
                  <span>{entrant.username}</span>
                  {isMe && <span className="opacity-80">(you)</span>}
                </li>
              </Badge>
            )
          })}
          {state.hidden > 0 && (
            <li className="text-[12px] text-[color:var(--fg-3)]">
              +{state.hidden} more
            </li>
          )}
        </ul>
      )

    case 'empty':
      return (
        <LeadReason
          className="mt-1.5"
          lead="No one has entered yet."
          reason="Players who enter this event will be listed here."
        />
      )

    case 'entry-closed':
      return (
        <LeadReason
          className="mt-1.5"
          // A straight apostrophe, as the JSX `&apos;` this replaced rendered: the
          // roster copy is asserted verbatim (`entrants-list.page.tsx`, and the
          // e2e spec), and a typographic ’ would be a different string.
          lead={`${state.formatLabel} events can't be entered yet.`}
          reason="Entry is open for singles only, so no one can sign up for this event."
        />
      )

    default: {
      // Adding a state to `RosterState` without giving it copy is a TYPE error
      // here, not a blank card section: without this, an unhandled variant would
      // fall out of the switch as `undefined`, which React renders as nothing —
      // silently, and green.
      const exhaustive: never = state
      return exhaustive
    }
  }
}
