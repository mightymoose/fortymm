import { Link } from '@tanstack/react-router'

import type { CheckoutAttentionItem } from '@/api/dashboard'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { checkoutAttentionCopy } from '@/components/dashboard/checkout-attention'

export function CheckoutAttentionPanel({
  items,
  totalCount,
}: {
  items: CheckoutAttentionItem[]
  totalCount: number
}) {
  if (items.length === 0) return null
  return (
    <Card asChild className="mb-5 border border-[color:var(--ball-500)]/25">
      <section aria-label="Payment attention">
        <CardHeader>
          <CardTitle>Payment attention</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <li key={item.checkout_id} className="flex items-center justify-between gap-4 py-3">
                <span>
                  <span className="block font-medium">{checkoutAttentionCopy(item)}</span>
                  <span className="block text-sm text-muted-foreground">
                    {item.tournament_name}
                    {item.support_reference ? ` · ${item.support_reference}` : ''}
                  </span>
                </span>
                <Button asChild size="sm" variant={item.kind === 'active' ? 'default' : 'outline'}>
                  <Link to={item.href}>{checkoutAttentionCopy(item)}</Link>
                </Button>
              </li>
            ))}
          </ul>
          {totalCount > items.length && (
            <Button asChild variant="link" className="mt-3">
              <Link to="/checkouts">View all checkouts</Link>
            </Button>
          )}
        </CardContent>
      </section>
    </Card>
  )
}
