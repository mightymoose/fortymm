export const MAX_CHECKOUT_EVENTS = 100

export function toggleCheckoutEvent(current: Set<string>, eventId: string) {
  const next = new Set(current)
  if (next.has(eventId)) next.delete(eventId)
  else if (next.size < MAX_CHECKOUT_EVENTS) next.add(eventId)
  return next
}
