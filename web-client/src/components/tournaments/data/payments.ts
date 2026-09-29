import { useMutation, useQuery } from '@tanstack/react-query'
import { z } from 'zod'

import { api, unwrap } from '@/api/client'

import {
  apiToCheckout,
  TOURNAMENT_CHECKOUT_QUERY_KEY_PREFIX,
  TOURNAMENT_PAYMENT_QUERY_KEY_PREFIX,
} from './api'

/**
 * Card payment for a tournament checkout (#1809). The server owns every fact
 * here: the total, the per-event outcomes and the payment state. The client
 * confirms the card with Stripe and then only ever reads the result back.
 */

export const PAYMENT_STATES = [
  'unavailable',
  'preparing',
  'ready',
  'checking',
  'action_required',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
  'needs_review',
] as const
export type PaymentState = (typeof PAYMENT_STATES)[number]

const paymentReadSchema = z.object({
  id: z.string().uuid(),
  checkout_id: z.string().uuid(),
  reference: z.string().regex(/^PAY-[0-9A-Z]{8}$/),
  payment_state: z.enum(PAYMENT_STATES),
  // Parsed as a plain string: an unknown code maps to the generic decline
  // message rather than failing the whole read.
  last_error_code: z.string().nullable(),
  amount_cents: z.number().int().positive(),
  currency: z.literal('USD'),
  created_at: z.iso.datetime({ offset: true }),
  lines: z.array(
    z.object({
      event_id: z.string().uuid(),
      event_name: z.string(),
      price_cents: z.number().int().positive(),
      outcome: z.enum(['pending', 'admitted', 'refund_pending']),
    }),
  ),
})

const paymentPreparedSchema = paymentReadSchema.extend({
  client_secret: z.string().min(1).nullable(),
  publishable_key: z.string().regex(/^pk_(test|live)_/),
  receipt_address: z.string().nullable(),
})

function toPayment(payment: z.infer<typeof paymentReadSchema>) {
  return {
    id: payment.id,
    checkoutId: payment.checkout_id,
    reference: payment.reference,
    state: payment.payment_state,
    lastErrorCode: payment.last_error_code,
    amountCents: payment.amount_cents,
    lines: payment.lines.map((line) => ({
      eventId: line.event_id,
      eventName: line.event_name,
      priceCents: line.price_cents,
      outcome: line.outcome,
    })),
  }
}

export type Payment = ReturnType<typeof toPayment>
export type PreparedPayment = Payment & {
  clientSecret: string | null
  publishableKey: string
  receiptAddress: string | null
}

/** A payment is settled for the player once it succeeded, went to review, or
 * any of its events has an outcome. */
export function isSettled(payment: Payment) {
  return (
    payment.state === 'succeeded' ||
    payment.state === 'needs_review' ||
    payment.lines.some((line) => line.outcome !== 'pending')
  )
}

/** Where Stripe sends the player back after a 3-D Secure redirect. The page
 * reads only the payment's status there, never Stripe's added params. */
export function checkoutReturnUrl(tournamentId: string, checkoutId: string) {
  return `${window.location.origin}/tournaments/${tournamentId}?tab=events&checkout=${checkoutId}`
}

export function apiToPayment(payload: unknown): Payment {
  return toPayment(paymentReadSchema.parse(payload))
}

export function apiToPreparedPayment(payload: unknown): PreparedPayment {
  const prepared = paymentPreparedSchema.parse(payload)
  return {
    ...toPayment(prepared),
    clientSecret: prepared.client_secret,
    publishableKey: prepared.publishable_key,
    receiptAddress: prepared.receipt_address,
  }
}

const paymentPath = '/v1/tournaments/{tournament_id}/checkouts/{checkout_id}/payment'
const pathParams = (tournamentId: string, checkoutId: string) => ({
  params: { path: { tournament_id: tournamentId, checkout_id: checkoutId } },
})

/** While the server is still creating the PaymentIntent, ask again after 2 s,
 * then 5 s, then every 10 s. The hold's own deadline ends the wait. */
export function preparingRetryDelay(attemptsSoFar: number): number {
  if (attemptsSoFar <= 1) return 2_000
  if (attemptsSoFar === 2) return 5_000
  return 10_000
}

export const preparedPaymentKey = (checkoutId: string) =>
  [...TOURNAMENT_PAYMENT_QUERY_KEY_PREFIX, checkoutId, 'prepared'] as const
export const paymentStatusKey = (checkoutId: string) =>
  [...TOURNAMENT_PAYMENT_QUERY_KEY_PREFIX, checkoutId, 'status'] as const

/** Prepare, or resume, this checkout's payment. It is the only response that
 * carries the client secret. Calling it again resumes the same PaymentIntent,
 * on this device or another one. */
export function usePreparedPayment(
  tournamentId: string,
  checkoutId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: preparedPaymentKey(checkoutId),
    queryFn: async () =>
      apiToPreparedPayment(
        unwrap(
          'prepare your payment',
          await api.POST(paymentPath, pathParams(tournamentId, checkoutId)),
        ),
      ),
    enabled,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === 'preparing'
        ? preparingRetryDelay(query.state.dataUpdateCount)
        : false,
  })
}

/** Read the payment's status. The server refreshes it against Stripe first,
 * so this read, never a Stripe callback, decides what the player sees. */
export function usePaymentStatus(
  tournamentId: string,
  checkoutId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: paymentStatusKey(checkoutId),
    queryFn: async () =>
      apiToPayment(
        unwrap(
          'check your payment',
          await api.GET(paymentPath, pathParams(tournamentId, checkoutId)),
        ),
      ),
    enabled,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === 'checking' ||
      query.state.data?.state === 'action_required'
        ? 5_000
        : false,
  })
}

/** One checkout by id, whatever its status. The panel keeps showing a checkout
 * after its hold ends, and `?checkout=` names one after it completes. */
export function useCheckoutById(
  tournamentId: string,
  checkoutId: string | undefined,
) {
  return useQuery({
    queryKey: [...TOURNAMENT_CHECKOUT_QUERY_KEY_PREFIX, tournamentId, 'by-id', checkoutId],
    queryFn: async () =>
      apiToCheckout(
        unwrap(
          'load your checkout',
          await api.GET(
            '/v1/tournaments/{tournament_id}/checkouts/{checkout_id}',
            pathParams(tournamentId, checkoutId!),
          ),
        ),
      ),
    enabled: checkoutId !== undefined,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.status === 'active' ? 5_000 : false,
  })
}

/** Save, or clear with `null`, the checkout's receipt address. The panel
 * surfaces a failure inline, so this mutation reports nothing itself. */
export function useSaveReceiptAddress(tournamentId: string, checkoutId: string) {
  return useMutation({
    mutationFn: async (receiptAddress: string | null) =>
      unwrap(
        'save your receipt address',
        await api.PATCH(
          '/v1/tournaments/{tournament_id}/checkouts/{checkout_id}',
          {
            ...pathParams(tournamentId, checkoutId),
            body: { receipt_address: receiptAddress },
          },
        ),
      ),
  })
}
