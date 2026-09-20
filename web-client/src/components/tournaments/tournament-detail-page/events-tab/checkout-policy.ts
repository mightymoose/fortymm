import type { Tournament, TournamentEvent } from '../../data/types'

export const MAX_CHECKOUT_EVENTS = 100
export const MIN_CHECKOUT_FEE = 0.5

export function isCheckoutEventEligible(
  tournament: Tournament,
  event: TournamentEvent,
  username?: string,
) {
  return (
    tournament.checkoutAvailable &&
    tournament.status === 'published' &&
    tournament.registrationOpen !== false &&
    event.format === 'singles' &&
    event.lifecycleState !== 'cancelled' &&
    event.entryFee >= MIN_CHECKOUT_FEE &&
    event.entryState.state === 'open' &&
    !event.entrants.some((entrant) => entrant.username === username)
  )
}

export function toggleCheckoutEvent(current: Set<string>, eventId: string) {
  const next = new Set(current)
  if (next.has(eventId)) next.delete(eventId)
  else if (next.size < MAX_CHECKOUT_EVENTS) next.add(eventId)
  return next
}
