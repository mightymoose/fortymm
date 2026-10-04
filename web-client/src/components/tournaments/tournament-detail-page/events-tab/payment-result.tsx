import { CircleCheck, Info } from 'lucide-react'

import { Button } from '@/components/ui/button'

import type { Payment } from '../../data/payments'

const OUTCOME_TEXT = {
  admitted: 'Entry confirmed',
  refund_pending: 'Not admitted — refund pending',
  pending: 'Under review',
} as const

/**
 * Each event's result after a payment settles (#1809). Only an all-admitted
 * payment gets the success tone: a mixed outcome and a payment under review
 * stay neutral. Every result carries words, never color alone.
 */
export function PaymentResult({
  payment,
  onDone,
  onViewReceipt,
}: {
  payment: Payment
  onDone: () => void
  /** Open the receipt page, offered once the payment succeeded (#1810). */
  onViewReceipt?: (paymentId: string, options?: { replace?: boolean }) => void
}) {
  const review = payment.state === 'needs_review'
  const allAdmitted = !review && payment.lines.every((line) => line.outcome === 'admitted')
  return (
    <div className="flex flex-col gap-4">
      <div role="status" className="flex gap-2">
        {allAdmitted ? (
          <CircleCheck className="mt-0.5 shrink-0 text-[color:var(--win)]" size={18} aria-hidden />
        ) : (
          <Info className="mt-0.5 shrink-0 text-muted-foreground" size={18} aria-hidden />
        )}
        <div>
          <h3 className="text-base font-semibold">
            {review
              ? 'Your payment needs review'
              : allAdmitted
                ? 'You’re entered'
                : 'Some entries weren’t admitted'}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {review
              ? 'We’re checking this payment before we confirm your entries. Quote the support reference if you contact us.'
              : allAdmitted
                ? 'Your payment went through.'
                : 'Each event that couldn’t admit you is refunded in full.'}
          </p>
        </div>
      </div>
      <ul aria-label="Results" className="divide-y divide-border/70">
        {payment.lines.map((line) => (
          <li key={line.eventId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
            <span data-part="event" className="min-w-0 break-words font-medium">{line.eventName}</span>
            <span data-part="result" className="text-sm">{OUTCOME_TEXT[line.outcome]}</span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">Support reference {payment.reference}</p>
      <div className="flex flex-wrap gap-2 self-start">
        <Button onClick={onDone}>Done</Button>
        {payment.state === 'succeeded' && onViewReceipt && (
          <Button variant="outline" onClick={() => onViewReceipt(payment.id)}>
            View receipt
          </Button>
        )}
      </div>
    </div>
  )
}

/** A payment the server is still confirming. The player can leave: the result
 * waits for them here and in the open-checkout bar. */
export function PaymentChecking() {
  return (
    <div role="status" className="flex flex-col gap-1">
      <h3 className="text-base font-semibold">Checking your payment</h3>
      <p className="text-sm text-muted-foreground">
        This can take a moment. You can leave this page and come back.
      </p>
    </div>
  )
}
