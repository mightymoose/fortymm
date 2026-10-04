import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import { api, unwrap } from '@/api/client'

/**
 * The itemized receipt of a succeeded payment (#1810). The server owns every
 * fact here: only the payer and the merchant account can read it, and it
 * exists only after the payment succeeded.
 */

const receiptSchema = z.object({
  id: z.string().uuid(),
  reference: z.string().regex(/^PAY-[0-9A-Z]{8}$/),
  amount_cents: z.number().int().positive(),
  currency: z.literal('USD'),
  created_at: z.iso.datetime({ offset: true }),
  // Only the payer ever sees their address. It is `null` for the merchant.
  receipt_address: z.string().nullable(),
  lines: z.array(
    z.object({
      event_id: z.string().uuid(),
      event_name: z.string(),
      price_cents: z.number().int().positive(),
      outcome: z.enum(['pending', 'admitted', 'refund_pending']),
    }),
  ),
})

export function apiToReceipt(payload: unknown) {
  const receipt = receiptSchema.parse(payload)
  return {
    id: receipt.id,
    reference: receipt.reference,
    totalCents: receipt.amount_cents,
    paidAt: receipt.created_at,
    receiptAddress: receipt.receipt_address,
    lines: receipt.lines.map((line) => ({
      eventId: line.event_id,
      eventName: line.event_name,
      priceCents: line.price_cents,
      outcome: line.outcome,
    })),
  }
}

export type Receipt = ReturnType<typeof apiToReceipt>

export const receiptKey = (paymentId: string) => ['payment-receipt', paymentId] as const

export function usePaymentReceipt(paymentId: string) {
  return useQuery({
    queryKey: receiptKey(paymentId),
    queryFn: async () =>
      apiToReceipt(
        unwrap(
          'load your receipt',
          await api.GET('/v1/payments/{payment_id}/receipt', {
            params: { path: { payment_id: paymentId } },
          }),
        ),
      ),
    retry: false,
  })
}

/** Erase the receipt address the payment holds, at once. The server also
 * erases the checkout's copy and never fills it again. The page shows a failure
 * inline, so this mutation reports nothing itself. */
export function useEraseReceiptAddress(paymentId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () =>
      unwrap(
        'remove your email',
        await api.DELETE('/v1/payments/{payment_id}/receipt-address', {
          params: { path: { payment_id: paymentId } },
        }),
        { allowEmpty: true },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: receiptKey(paymentId) }),
  })
}

const paymentSummarySchema = z.object({
  id: z.string().uuid(),
  reference: z.string().regex(/^PAY-[0-9A-Z]{8}$/),
  amount_cents: z.number().int().positive(),
  created_at: z.iso.datetime({ offset: true }),
  event_names: z.array(z.string()),
})

export function apiToPaymentSummaries(payload: unknown) {
  return z.array(paymentSummarySchema).parse(payload).map((payment) => ({
    id: payment.id,
    reference: payment.reference,
    totalCents: payment.amount_cents,
    eventNames: payment.event_names,
  }))
}

export const myPaymentsKey = (tournamentId: string) =>
  ['tournament-my-payments', tournamentId] as const

/** The caller's own succeeded payments in one tournament, so a payer who left
 * before success can still reach each receipt. A failed read shows nothing:
 * the receipts are a convenience, never a reason to break the Events tab. */
export function useMyTournamentPayments(tournamentId: string) {
  return useQuery({
    queryKey: myPaymentsKey(tournamentId),
    queryFn: async () =>
      apiToPaymentSummaries(
        unwrap(
          'load your receipts',
          await api.GET('/v1/tournaments/{tournament_id}/payments', {
            params: { path: { tournament_id: tournamentId } },
          }),
        ),
      ),
    retry: false,
  })
}
