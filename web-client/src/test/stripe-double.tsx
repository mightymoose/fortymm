/* eslint-disable react-hooks/immutability -- a test double records the props
   it renders with, so a test can assert what the panel handed to Stripe. */
import type { ReactNode } from 'react'
import { vi } from 'vitest'

/**
 * A test double for the Stripe browser SDK — the one external system the
 * checkout panel talks to that MSW cannot intercept (Stripe.js runs in an
 * iframe and posts to Stripe directly). Install it at the module boundary:
 *
 * ```ts
 * vi.mock('@stripe/stripe-js', () => import('@/test/stripe-double'))
 * vi.mock('@stripe/react-stripe-js', () => import('@/test/stripe-double'))
 * ```
 *
 * Then drive and observe it through `stripeDouble`. `resetStripeDouble()` runs
 * in `beforeEach` so every test starts from "the card confirms".
 */
export const stripeDouble = {
  /** Every publishable key `loadStripe` was called with. */
  loadedKeys: [] as string[],
  /** The `options` the most recent `<Elements>` rendered with. */
  elementsOptions: undefined as unknown,
  /** The `options` the most recent `<PaymentElement>` rendered with. */
  paymentElementOptions: undefined as unknown,
  confirmPayment: vi.fn(),
}

export function resetStripeDouble() {
  stripeDouble.loadedKeys = []
  stripeDouble.elementsOptions = undefined
  stripeDouble.paymentElementOptions = undefined
  stripeDouble.confirmPayment.mockReset()
  stripeDouble.confirmPayment.mockResolvedValue({
    paymentIntent: { status: 'succeeded' },
  })
}

const fakeStripe = {
  confirmPayment: (...args: unknown[]) => stripeDouble.confirmPayment(...args),
}
const fakeElements = { submit: async () => ({}) }

// ----- @stripe/stripe-js ----------------------------------------------------

export function loadStripe(key: string) {
  stripeDouble.loadedKeys.push(key)
  return Promise.resolve(fakeStripe)
}

// ----- @stripe/react-stripe-js ----------------------------------------------

export function Elements({ options, children }: { options?: unknown; children: ReactNode }) {
  stripeDouble.elementsOptions = options
  return <>{children}</>
}

export function PaymentElement({ options }: { options?: unknown }) {
  stripeDouble.paymentElementOptions = options
  return <div data-testid="stripe-payment-element">Card details</div>
}

export const useStripe = () => fakeStripe
export const useElements = () => fakeElements
