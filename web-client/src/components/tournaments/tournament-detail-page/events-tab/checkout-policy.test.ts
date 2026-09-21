import { buildEvent, buildTournament } from '../../data/seed.factory'
import {
  isCheckoutEventEligible,
  MAX_CHECKOUT_EVENTS,
  toggleCheckoutEvent,
} from './checkout-policy'

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

it('rejects subminimum and newly ineligible checkout events', () => {
  const tournament = buildTournament()

  expect(
    isCheckoutEventEligible(tournament, buildEvent({ entryFee: 0.25 })),
  ).toBe(false)
  expect(
    isCheckoutEventEligible(tournament, buildEvent({ entryFee: 20, format: 'doubles' })),
  ).toBe(false)
  expect(
    isCheckoutEventEligible(tournament, buildEvent({ entryFee: 20 })),
  ).toBe(true)
})
