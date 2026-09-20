import { Clock3, ShieldCheck, ShoppingBasket } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import type { TournamentCheckout } from '../../data/api'
import type { TournamentEvent } from '../../data/types'
import { MAX_CHECKOUT_EVENTS } from './checkout-policy'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

function Countdown({ expiresAt, onExpired }: { expiresAt: string; onExpired: () => void }) {
  const deadline = Date.parse(expiresAt)
  const [now, setNow] = useState(() => Date.now())
  const notified = useRef(false)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1_000))
  useEffect(() => {
    notified.current = false
  }, [expiresAt])
  useEffect(() => {
    if (seconds === 0 && !notified.current) {
      notified.current = true
      onExpired()
    }
  }, [onExpired, seconds])
  const value = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return (
    <div className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-center">
      <div className="mb-1 flex items-center justify-center gap-1.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        <Clock3 size={13} /> Places held
      </div>
      <div className="font-mono text-3xl font-semibold tabular-nums" aria-label={`${value} remaining`}>
        {value}
      </div>
    </div>
  )
}
export function CheckoutSummary({
  selection,
  checkout,
  pending,
  onHold,
  onCancel,
  onChange,
  onExpired,
  onRemoveSelection,
}: {
  selection: TournamentEvent[]
  checkout: TournamentCheckout | null
  pending: boolean
  onHold: () => void
  onCancel: () => void
  onChange: () => void
  onExpired: () => void
  onRemoveSelection: (eventId: string) => void
}) {
  if (!checkout && selection.length === 0) return null
  const lines = checkout?.lines ?? selection.map((event) => ({
    eventId: event.id,
    eventName: event.name,
    priceCents: Math.round(event.entryFee * 100),
  }))
  const total = checkout?.totalCents ?? lines.reduce((sum, line) => sum + line.priceCents, 0)

  return (
    <Card asChild className="mb-5 border-l-4 border-l-primary">
      <section aria-labelledby="checkout-title">
        <CardHeader className="border-b">
          <div className="flex items-center gap-2 text-primary"><ShoppingBasket size={18} /></div>
          <CardTitle id="checkout-title">{checkout ? 'Your held places' : 'Entry summary'}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 pt-1 md:grid-cols-[1fr_190px]">
          <div>
            <ul className="divide-y divide-border/70">
              {lines.map((line) => (
                <li key={line.eventId} className="flex items-center justify-between gap-4 py-2.5">
                  <span className="font-medium">{line.eventName}</span>
                  <span className="ml-auto tabular-nums">{usd.format(line.priceCents / 100)}</span>
                  {!checkout && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${line.eventName} from entry summary`}
                      disabled={pending}
                      onClick={() => onRemoveSelection(line.eventId)}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-between border-t pt-3 text-base font-semibold">
              <span>Total</span><span className="tabular-nums">{usd.format(total / 100)}</span>
            </div>
            {!checkout && selection.length === MAX_CHECKOUT_EVENTS && (
              <p className="mt-3 text-sm text-muted-foreground" role="status">
                You can hold up to {MAX_CHECKOUT_EVENTS} events in one checkout.
              </p>
            )}
            {checkout && (
              <p className="mt-3 flex gap-2 text-sm text-muted-foreground">
                <ShieldCheck className="mt-0.5 shrink-0" size={15} />
                Payment collection isn’t available yet. Your places stay held until the timer ends.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-3">
            {checkout ? (
              <>
                <Countdown
                  key={checkout.id}
                  expiresAt={checkout.expiresAt}
                  onExpired={onExpired}
                />
                <AlertDialog>
                  <AlertDialogTrigger asChild><Button variant="outline" disabled={pending}>Change selection</Button></AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Release these places?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Changing your selection releases this checkout hold. Your new choices will be checked again and receive a new hold.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep hold</AlertDialogCancel>
                      <AlertDialogAction onClick={onChange}>Release and change</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <Button variant="ghost" disabled={pending} onClick={onCancel}>Release hold</Button>
              </>
            ) : (
              <Button disabled={pending} onClick={onHold}>
                Hold {selection.length} {selection.length === 1 ? 'place' : 'places'}
              </Button>
            )}
          </div>
        </CardContent>
      </section>
    </Card>
  )
}
