import { ShoppingBasket } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import type { TournamentEvent } from '../../data/types'
import { MAX_CHECKOUT_EVENTS } from './checkout-policy'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/** The paid events the player has ticked, before a checkout exists. One
 * "Check out" press creates the checkout and opens the card form (#1809). */
export function CheckoutSummary({
  selection,
  pending,
  onCheckout,
  onRemoveSelection,
}: {
  selection: TournamentEvent[]
  pending: boolean
  onCheckout: () => void
  onRemoveSelection: (eventId: string) => void
}) {
  if (selection.length === 0) return null
  const lines = selection.map((event) => ({
    eventId: event.id,
    eventName: event.name,
    priceCents: Math.round(event.entryFee * 100),
  }))
  const total = lines.reduce((sum, line) => sum + line.priceCents, 0)

  return (
    <Card asChild className="mb-5 border-l-4 border-l-primary">
      <section aria-labelledby="checkout-title">
        <CardHeader className="border-b">
          <div className="flex items-center gap-2 text-primary"><ShoppingBasket size={18} aria-hidden /></div>
          <CardTitle id="checkout-title">Entry summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 pt-1 md:grid-cols-[1fr_190px]">
          <div>
            <ul className="divide-y divide-border/70">
              {lines.map((line) => (
                <li key={line.eventId} className="flex items-center justify-between gap-4 py-2.5">
                  <span className="min-w-0 break-words font-medium">{line.eventName}</span>
                  <span className="ml-auto tabular-nums">{usd.format(line.priceCents / 100)}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${line.eventName} from entry summary`}
                    disabled={pending}
                    onClick={() => onRemoveSelection(line.eventId)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-between border-t pt-3 text-base font-semibold">
              <span>Total</span><span className="tabular-nums">{usd.format(total / 100)}</span>
            </div>
            {selection.length === MAX_CHECKOUT_EVENTS && (
              <p className="mt-3 text-sm text-muted-foreground" role="status">
                You can hold up to {MAX_CHECKOUT_EVENTS} events in one checkout.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-3">
            <Button disabled={pending} onClick={onCheckout}>
              Check out · {usd.format(total / 100)}
            </Button>
          </div>
        </CardContent>
      </section>
    </Card>
  )
}
