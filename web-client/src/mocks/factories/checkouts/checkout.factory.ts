import type { components } from '@/api/schema'
import { mockUuid } from '@/mocks/mock-uuid'

type Schemas = components['schemas']
export type CheckoutRead = Schemas['TournamentCheckoutRead']
export type PaymentRead = Schemas['TournamentPaymentRead']
export type PaymentPrepared = Schemas['TournamentPaymentPrepared']
export type PaymentReceipt = Schemas['TournamentPaymentReceiptRead']
export type PaymentLineRead = Schemas['TournamentPaymentLineRead']

export const CHECKOUT_TOURNAMENT_ID = mockUuid('checkout-tournament')
export const CHECKOUT_ID = mockUuid('checkout')
export const OPEN_SINGLES_ID = mockUuid('checkout-open-singles')
export const U1500_ID = mockUuid('checkout-u1500')

/** Two paid events, $45 + $30: the default selection every checkout builder
 * below agrees on. */
export const CHECKOUT_LINES = [
  { event_id: OPEN_SINGLES_ID, event_name: 'Open Singles', price_cents: 4_500 },
  { event_id: U1500_ID, event_name: 'U1500', price_cents: 3_000 },
]

/** An active ten-minute hold on both default events. */
export function buildCheckoutRead(overrides: Partial<CheckoutRead> = {}): CheckoutRead {
  return {
    id: CHECKOUT_ID,
    request_id: mockUuid('checkout-request'),
    tournament_id: CHECKOUT_TOURNAMENT_ID,
    registration_generation: 0,
    status: 'active',
    payment_state: 'unavailable',
    currency: 'USD',
    total_cents: 7_500,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    remaining_seconds: 600,
    lines: CHECKOUT_LINES,
    ...overrides,
  }
}

/** A payment for the default checkout, ready for the card, every line pending. */
export function buildPaymentRead(overrides: Partial<PaymentRead> = {}): PaymentRead {
  return {
    id: mockUuid('payment'),
    checkout_id: CHECKOUT_ID,
    reference: 'PAY-7K3M9QX2',
    payment_state: 'ready',
    last_error_code: null,
    amount_cents: 7_500,
    currency: 'USD',
    created_at: new Date().toISOString(),
    lines: CHECKOUT_LINES.map((line) => ({ ...line, outcome: 'pending' as const })),
    ...overrides,
  }
}

/** The prepare/resume response: the read plus the payer-only fields. */
export function buildPaymentPrepared(
  overrides: Partial<PaymentPrepared> = {},
): PaymentPrepared {
  return {
    ...buildPaymentRead(),
    client_secret: 'pi_test_123_secret_abc',
    publishable_key: 'pk_test_fortymm',
    receipt_address: null,
    ...overrides,
  }
}

/** Every line of the default checkout with one outcome. */
export function paymentLines(
  outcome: PaymentLineRead['outcome'],
): PaymentLineRead[] {
  return CHECKOUT_LINES.map((line) => ({ ...line, outcome }))
}

/** The receipt of a succeeded payment on the two default events, both admitted. */
export function buildPaymentReceipt(
  overrides: Partial<PaymentReceipt> = {},
): PaymentReceipt {
  return {
    ...buildPaymentRead({ payment_state: 'succeeded', lines: paymentLines('admitted') }),
    receipt_address: null,
    ...overrides,
  }
}
