import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'

import { api, unwrap } from './client'

/** The caller's open checkouts across every tournament (#1809). The app-wide
 * open-checkout bar reads this, and a `checkout.changed` hint refreshes it. */
export const OPEN_CHECKOUTS_QUERY_KEY = ['me', 'checkouts', 'open'] as const

const openCheckoutSchema = z.object({
  checkout_id: z.string().uuid(),
  tournament_id: z.string().uuid(),
  tournament_name: z.string(),
  expires_at: z.iso.datetime({ offset: true }),
  payment_state: z.enum([
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
  ]),
  total_cents: z.number().int().nonnegative(),
})

export interface OpenCheckout {
  checkoutId: string
  tournamentId: string
  tournamentName: string
  expiresAt: string
  paymentState: z.infer<typeof openCheckoutSchema>['payment_state']
  totalCents: number
}

/** Parse the list at the boundary (`.claude/rules/parse-at-boundaries.md`). */
export function apiToOpenCheckouts(payload: unknown): OpenCheckout[] {
  return z
    .array(openCheckoutSchema)
    .parse(payload)
    .map((row) => ({
      checkoutId: row.checkout_id,
      tournamentId: row.tournament_id,
      tournamentName: row.tournament_name,
      expiresAt: row.expires_at,
      paymentState: row.payment_state,
      totalCents: row.total_cents,
    }))
}

/** No polling: a `checkout.changed` hint and the bar's own zero-crossing are
 * what refetch it. */
export const openCheckoutsQueryOptions = () =>
  queryOptions({
    queryKey: OPEN_CHECKOUTS_QUERY_KEY,
    queryFn: async () =>
      apiToOpenCheckouts(
        unwrap('load your open checkouts', await api.GET('/v1/me/checkouts/open')),
      ),
    retry: false,
  })
