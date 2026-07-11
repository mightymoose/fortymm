import { Badge } from '@/components/ui/badge'

import { FORMAT_OPTIONS } from '../../data/options'
import type { Entrant, TournamentEvent } from '../../data/types'

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
  | { kind: 'listed'; visible: Entrant[]; hidden: number }
  | { kind: 'empty' }
  | { kind: 'entry-closed'; formatLabel: string }

function rosterState(event: TournamentEvent): RosterState {
  // Entrants first, whatever the format: the roster renders what the server gives
  // it. A non-singles event cannot accrue entrants *today*, but if director-entry
  // (#784) ever puts people in one, listing them beats insisting it is closed.
  if (event.entrants.length > 0) {
    const visible = event.entrants.slice(0, MAX_VISIBLE)
    return {
      kind: 'listed',
      visible,
      hidden: event.entrants.length - visible.length,
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
}

/**
 * The roster on an event card: who is *actually* in this event.
 *
 * The list is exactly `event.entrants`. Withdrawn players are already absent from
 * it — the server derives both the list and the `entered` count from the ACTIVE
 * entries only (ADR-0016) — so there is nothing to filter here, and filtering
 * would be a second, drift-prone copy of that rule.
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
export const EntrantsList = ({ event }: EntrantsListProps) => {
  const state = rosterState(event)

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
          {state.visible.map((entrant) => (
            <Badge
              key={entrant.id}
              asChild
              variant="ghost"
              className="border-[color:var(--border-subtle)]"
            >
              {/* Rendered as the <li> itself (`asChild`), so the list stays a
                  list: <ul> may only parent <li>. */}
              <li>{entrant.username}</li>
            </Badge>
          ))}
          {state.hidden > 0 && (
            <li className="text-[12px] text-[color:var(--fg-3)]">
              +{state.hidden} more
            </li>
          )}
        </ul>
      )

    case 'empty':
      return (
        <p className="mt-1.5 text-[13px] text-[color:var(--fg-3)]">
          <span className="font-medium text-[color:var(--fg-2)]">
            No one has entered yet.
          </span>{' '}
          Players who enter this event will be listed here.
        </p>
      )

    case 'entry-closed':
      return (
        <p className="mt-1.5 text-[13px] text-[color:var(--fg-3)]">
          <span className="font-medium text-[color:var(--fg-2)]">
            {state.formatLabel} events can&apos;t be entered yet.
          </span>{' '}
          Entry is open for singles only, so no one can sign up for this event.
        </p>
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
