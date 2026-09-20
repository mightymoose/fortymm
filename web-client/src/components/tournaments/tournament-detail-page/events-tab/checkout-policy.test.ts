import { MAX_CHECKOUT_EVENTS, toggleCheckoutEvent } from './checkout-policy'

it('refuses a 101st checkout event while still allowing removal', () => {
  const full = new Set(
    Array.from({ length: MAX_CHECKOUT_EVENTS }, (_, index) => `event-${index}`),
  )

  const unchanged = toggleCheckoutEvent(full, 'event-100')
  expect(unchanged).toEqual(full)
  expect(unchanged).not.toBe(full)

  const removed = toggleCheckoutEvent(full, 'event-0')
  expect(removed.size).toBe(MAX_CHECKOUT_EVENTS - 1)
  expect(removed.has('event-0')).toBe(false)
})
