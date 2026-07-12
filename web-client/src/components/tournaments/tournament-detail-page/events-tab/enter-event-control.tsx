import { LogIn, LogOut } from 'lucide-react'

import { useHasPermission, useSession } from '@/api/session'
import { Button } from '@/components/ui/button'
import { PERM } from '@/lib/permissions'

import { useEnterEvent, useWithdrawEntry } from '../../data/api'
import { entryControlState } from '../../data/lifecycle'
import type { Tournament, TournamentEvent } from '../../data/types'

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
 * - It renders **nothing at all** — not a disabled button — when the player lacks
 *   `tournament.enter`, or when the event is doubles/teams. Both of those requests
 *   can only ever fail server-side (403 / 400), and both are facts about *the
 *   caller* that nothing on this page will change. There is no state to report.
 * - It renders a **designed state** — muted copy, still not a disabled button —
 *   when the tournament is `draft` (registration has not opened), `live` or
 *   `archived` (entries are locked). Those are facts about *the tournament*, and
 *   they change: publishing opens the window, going live shuts it. Rendering
 *   nothing would tell a player the event has no entry at all; rendering Enter
 *   would offer a button whose only possible outcome is a 409.
 *
 * Nothing here is a *capacity* gate: a full event still offers Enter, because
 * capacity is enforced (and refused) server-side later (#783).
 *
 * The entry count on the card is derived from the same `entrants` this reads, and
 * both mutations invalidate the tournament — so the count and the control refresh
 * themselves from the refetched event. This component tracks no count of its own.
 */
export const EnterEventControl = ({
  tournament,
  event,
}: EnterEventControlProps) => {
  const canEnter = useHasPermission(PERM.TOURNAMENT_ENTER)
  // The session carries a username but NO user id, so membership is a join on
  // the username — see `myEntrant`.
  const username = useSession().data?.data.user.username
  const enter = useEnterEvent(tournament.id)
  const withdraw = useWithdrawEntry(tournament.id)

  const state = entryControlState({
    status: tournament.status,
    event,
    canEnter,
    username,
  })
  // One in-flight request at a time: a double-click on Enter must not produce a
  // second entry (the server would 409 it, but the user would see an error for
  // doing nothing wrong).
  const isPending = enter.isPending || withdraw.isPending

  switch (state.kind) {
    case 'unpermitted':
    case 'not-singles':
      return null

    case 'not-open-yet':
    case 'locked':
      return <RegistrationNotice lead={state.lead} reason={state.reason} />

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
      // A seventh state without a branch is a TYPE error here, not a card that
      // silently renders nothing — the failure mode this whole component exists
      // to avoid.
      const exhaustive: never = state
      return exhaustive
    }
  }
}

/** The closed window, in the muted lead-plus-reason voice the roster's own empty
 * states use — deliberately inert text, never a `disabled` button, which would be
 * an unexplained dead end (ADR 0015, rule "hide mutating affordances"). */
const RegistrationNotice = ({
  lead,
  reason,
}: {
  lead: string
  reason: string
}) => (
  <p
    data-testid="registration-notice"
    className="max-w-[190px] text-right text-[12px] leading-snug text-[color:var(--fg-3)]"
  >
    <span className="block font-medium text-[color:var(--fg-2)]">{lead}</span>
    {reason}
  </p>
)
