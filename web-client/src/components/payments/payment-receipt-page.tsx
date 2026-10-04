import { Receipt as ReceiptIcon } from 'lucide-react'

import { ApiError } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import { useEraseReceiptAddress, usePaymentReceipt } from './receipt'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

const OUTCOME_TEXT = {
  admitted: 'Entry confirmed',
  refund_pending: 'Not admitted — refund pending',
  pending: 'Under review',
} as const

/**
 * The durable itemized receipt of a paid checkout (#1810): each event's price
 * and result, the total and the support reference. It answers 404 to anyone but
 * the payer and the merchant account, and to a payment that has not succeeded.
 */
export function PaymentReceiptPage({ paymentId }: { paymentId: string }) {
  const receipt = usePaymentReceipt(paymentId)
  const erase = useEraseReceiptAddress(paymentId)

  if (receipt.isPending) {
    return (
      <div className="mx-auto max-w-[680px] px-4 py-8 sm:px-8">
        <p role="status" className="text-muted-foreground">Loading your receipt…</p>
      </div>
    )
  }
  if (receipt.isError) {
    const notFound = receipt.error instanceof ApiError && receipt.error.status === 404
    return (
      <div className="mx-auto max-w-[680px] px-4 py-8 sm:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">Receipt</h1>
        <p role="alert" className="mt-3 text-muted-foreground">
          {notFound
            ? 'We couldn’t find this receipt.'
            : 'We couldn’t load this receipt. Try again in a moment.'}
        </p>
      </div>
    )
  }

  const { lines, totalCents, reference, receiptAddress } = receipt.data
  return (
    <div className="mx-auto max-w-[680px] px-4 py-8 sm:px-8">
      <h1 className="text-2xl font-semibold tracking-tight">Receipt</h1>
      <Card className="mt-6">
        <CardHeader className="border-b">
          <div className="flex items-center gap-2 text-primary">
            <ReceiptIcon size={18} aria-hidden />
          </div>
          <CardTitle>Your entries</CardTitle>
        </CardHeader>
        <CardContent className="pt-1">
          <ul aria-label="Events" className="divide-y divide-border/70">
            {lines.map((line) => (
              <li
                key={line.eventId}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5"
              >
                <span className="min-w-0 break-words font-medium">{line.eventName}</span>
                <span className="ml-auto tabular-nums">{usd.format(line.priceCents / 100)}</span>
                <span className="w-full text-sm text-muted-foreground sm:w-auto">
                  {OUTCOME_TEXT[line.outcome]}
                </span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 flex items-baseline justify-between gap-4 border-t pt-3">
            <dt className="font-semibold">Total</dt>
            <dd className="tabular-nums font-semibold">{usd.format(totalCents / 100)}</dd>
          </dl>
          <p className="mt-4 text-sm text-muted-foreground">Support reference {reference}</p>
          {receiptAddress !== null && (
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-4 text-sm">
              <span className="text-muted-foreground">Receipt email</span>
              <span className="break-all font-medium">{receiptAddress}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={erase.isPending}
                onClick={() => erase.mutate()}
              >
                Remove my email
              </Button>
              {erase.isError && (
                <p role="alert" className="w-full text-xs text-[color:var(--loss)]">
                  We couldn’t remove your email. Try again in a moment.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
