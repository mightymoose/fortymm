import { LogIn, LogOut } from 'lucide-react'

import { useHasPermission, useSession } from '@/api/session'
import { Button } from '@/components/ui/button'
import { PERM } from '@/lib/permissions'

import { useEnterEvent, useWithdrawEntry } from '../../data/api'
import { myEntrant } from '../../data/helpers'
import type { TournamentEvent } from '../../data/types'

export interface EnterEventControlProps {
  tournamentId: string
  event: TournamentEvent
}

/**
 * The event card's self-registration control: **Enter** when the signed-in
 * player is not in the event, **Withdraw** when they are (ADR-0016).
 *
 * It renders **nothing at all** — not a disabled button — when the player lacks
 * `tournament.enter`, or when the event is doubles/teams. Both of those requests
 * can only ever fail server-side (403 / 400), so offering a control that cannot
 * work would be a lie. Nothing here is a *capacity* gate: a full event still
 * offers Enter, because capacity is enforced (and refused) server-side later
 * (#783).
 *
 * The entry count on the card is derived from the same `entrants` this reads, and
 * both mutations invalidate the tournament — so the count and the control refresh
 * themselves from the refetched event. This component tracks no count of its own.
 */
export const EnterEventControl = ({
  tournamentId,
  event,
}: EnterEventControlProps) => {
  const canEnter = useHasPermission(PERM.TOURNAMENT_ENTER)
  // The session carries a username but NO user id, so membership is a join on
  // the username — see `myEntrant`.
  const username = useSession().data?.data.user.username
  const enter = useEnterEvent(tournamentId)
  const withdraw = useWithdrawEntry(tournamentId)

  // `useHasPermission` is false while the session is in flight, so this also
  // holds the control back until we know who the player is — which is what we
  // want: we can't tell Enter from Withdraw without them.
  if (!canEnter || event.format !== 'singles') return null

  const entry = myEntrant(event, username)
  // One in-flight request at a time: a double-click on Enter must not produce a
  // second entry (the server would 409 it, but the user would see an error for
  // doing nothing wrong).
  const isPending = enter.isPending || withdraw.isPending

  if (entry) {
    return (
      <Button
        variant="outline"
        size="sm"
        aria-label={`Withdraw from ${event.name}`}
        disabled={isPending}
        onClick={() =>
          withdraw.mutate({ eventId: event.id, entryId: entry.id })
        }
      >
        <LogOut size={14} />
        Withdraw
      </Button>
    )
  }

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
}
