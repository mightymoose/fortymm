import { LogIn, LogOut } from 'lucide-react'

import { useSession } from '@/api/session'
import { Button } from '@/components/ui/button'

import { useEnterEvent, useWithdrawEntry } from '../../data/api'
import { entryControlState } from '../../data/lifecycle'
import type { Tournament, TournamentEvent } from '../../data/types'
import { LeadReason } from './lead-reason'

export interface EnterEventControlProps {
  /** The whole tournament, not just its id: the control needs its **status** to
   * know whether registration is open (ADR-0017), and taking the two separately
   * is how they come apart. */
  tournament: Tournament
  event: TournamentEvent
}

/**
 * The event card's self-registration control: **Enter** when the signed-in
 * player is not in the event, **Withdraw** when they are (ADR-0016) — but only
 * while the tournament's registration window is open, which is to say only while
 * it is `published` (ADR-0017).
 *
 * What it renders is `entryControlState` (`../../data/lifecycle`) and nothing
 * else; the two halves of that sum type deserve their difference stated, because
 * they look alike from here and are not:
 *
 * - It renders **nothing at all** — not a disabled button — while the session
 *   request is still in flight, or when the event is doubles/teams. Both of
 *   those silences are facts about *the caller* that nothing on this page will
 *   change (entering needs no permission any more — #1092 deleted
 *   `tournament.enter`). There is no state to report.
 * - It renders a **designed state** — muted copy, still not a disabled button —
 *   when the tournament is `draft` (registration has not opened), `live` or
 *   `archived` (entries are locked), when the event is **full**, and when the
 *   player's rating makes them **ineligible** for it. Those are facts about *the
 *   tournament* and *the event*, and they change: publishing opens the window,
 *   going live shuts it, a withdrawal frees a place. Rendering nothing would tell
 *   a player the event has no entry at all; rendering Enter would offer a button
 *   whose only possible outcome is a 409.
 *
 * Issue #783 asked for the Enter button to be *disabled* on a full or ineligible
 * event. It is not: ADR-0015 is the house rule, and a disabled button is an
 * unexplained dead end — the affordance is hidden and the reason takes its place,
 * which is the path the closed window already took. The words come from the entry
 * refusal table (`data/entry-refusal.ts`) — the same words the 409 on Enter would
 * have produced, because it is the same refusal, learned earlier.
 *
 * The entry count on the card is derived from the same `entrants` this reads, and
 * both mutations invalidate the tournament — so the count and the control refresh
 * themselves from the refetched event. This component tracks no count of its own.
 */
export const EnterEventControl = ({
  tournament,
  event,
}: EnterEventControlProps) => {
  // Entering needs no permission (#1092) — what the control waits on is the
  // session itself settling: `username` is undefined while it is in flight, so
  // membership can't be judged, and rendering Enter before it lands would let an
  // entered player double-submit into a 409.
  const session = useSession()
  const sessionLoaded = session.isSuccess
  // The session carries a username but NO user id, so membership is a join on
  // the username — see `myEntrant`.
  const username = session.data?.data.user.username
  const enter = useEnterEvent(tournament.id)
  const withdraw = useWithdrawEntry(tournament.id)

  const state = entryControlState({
    status: tournament.status,
    event,
    sessionLoaded,
    username,
  })
  // One in-flight request at a time: a double-click on Enter must not produce a
  // second entry (the server would 409 it, but the user would see an error for
  // doing nothing wrong).
  const isPending = enter.isPending || withdraw.isPending

  switch (state.kind) {
    case 'hidden':
      return null

    case 'closed':
      // Inert text where the button was — never a `disabled` button, which would
      // be an unexplained dead end (ADR 0015, "hide mutating affordances"). The
      // same lead-plus-reason voice the roster's own empty states use.
      return (
        <LeadReason
          testId="registration-notice"
          layout="stacked"
          lead={state.lead}
          reason={state.reason}
          className="max-w-[190px] text-right"
        />
      )

    // The event's own refusals (#783), told the same way and for the same reason:
    // there is no button, because there is no request this page could make that
    // would succeed — only a reason, in the words the refusal table owns. They get
    // test ids of their own because they are different *states*, and a test that
    // could not tell "full" from "ineligible" could not prove either.
    case 'full':
      return (
        <LeadReason
          testId="event-full-notice"
          layout="stacked"
          lead={state.lead}
          reason={state.reason}
          className="max-w-[190px] text-right"
        />
      )

    case 'ineligible':
      return (
        <LeadReason
          testId="ineligible-notice"
          layout="stacked"
          lead={state.lead}
          reason={state.reason}
          className="max-w-[190px] text-right"
        />
      )

    case 'withdraw':
      return (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Withdraw from ${event.name}`}
          disabled={isPending}
          onClick={() =>
            withdraw.mutate({ eventId: event.id, entryId: state.entryId })
          }
        >
          <LogOut size={14} />
          Withdraw
        </Button>
      )

    case 'enter':
      return (
        <Button
          size="sm"
          aria-label={`Enter ${event.name}`}
          disabled={isPending}
          onClick={() => enter.mutate(event.id)}
        >
          <LogIn size={14} />
          Enter
        </Button>
      )

    default: {
      // A new state without a branch is a TYPE error here, not a card that
      // silently renders nothing — the failure mode this whole component exists
      // to avoid.
      const exhaustive: never = state
      return exhaustive
    }
  }
}
