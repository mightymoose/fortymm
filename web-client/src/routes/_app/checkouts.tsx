import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'

import type { CheckoutAttentionItem } from '@/api/dashboard'
import { api, unwrap } from '@/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { checkoutAttentionCopy } from '@/components/dashboard/checkout-attention'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/_app/checkouts')({
  head: () => ({ meta: [{ title: pageTitle('Checkouts') }] }),
  component: ActionableCheckoutsPage,
})

const actionableCheckoutsSchema = z.object({
  items: z.array(z.object({
    checkout_id: z.string(),
    tournament_id: z.string(),
    tournament_name: z.string(),
    kind: z.enum(['needs_review', 'checking', 'active']),
    payment_state: z.enum(['unavailable', 'preparing', 'ready', 'checking', 'action_required', 'succeeded', 'failed', 'expired', 'canceled']),
    expires_at: z.string(),
    remaining_seconds: z.number().int().nonnegative(),
    support_reference: z.string().nullable(),
    href: z.string(),
  })),
})

function ActionableCheckoutsPage() {
  const query = useQuery({
    queryKey: ['actionable-checkouts'],
    queryFn: async (): Promise<{ items: CheckoutAttentionItem[] }> =>
      actionableCheckoutsSchema.parse(
        unwrap('load open checkouts', await api.GET('/v1/checkouts')),
      ),
    retry: false,
  })
  return (
    <main aria-labelledby="checkouts-title" className="mx-auto w-full max-w-3xl space-y-5 p-4 sm:p-8">
      <div>
        <p className="fortymm-overline">Payments</p>
        <h1 id="checkouts-title" className="font-heading text-3xl font-bold">Your open checkouts</h1>
      </div>
      {query.isPending ? <p>Loading checkouts…</p> : query.isError && query.data === undefined ? (
        <Alert variant="destructive">
          <AlertTitle>We couldn’t load your checkouts</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>Your checkout list is temporarily unavailable.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {query.isFetching ? 'Retrying…' : 'Retry'}
            </Button>
          </AlertDescription>
        </Alert>
      ) : query.data?.items.length ? (
        <ul className="space-y-3">
          {query.data.items.map((item) => (
            <li key={item.checkout_id}>
              <Card>
                <CardHeader><CardTitle>{item.tournament_name}</CardTitle></CardHeader>
                <CardContent className="flex items-center justify-between gap-4">
                  <span>{checkoutAttentionCopy(item)}</span>
                  <Button asChild><Link to={item.href}>Open checkout</Link></Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : <p>You have no checkouts that need attention.</p>}
    </main>
  )
}
