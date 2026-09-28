import { ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import { useSession } from '@/api/session'
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
import { Card, CardContent } from '@/components/ui/card'

import type { TournamentCheckout } from '../../data/api'
import {
  checkoutReturnUrl,
  isSettled,
  usePaymentStatus,
  usePreparedPayment,
  useSaveReceiptAddress,
} from '../../data/payments'
import { CheckoutCountdown } from './checkout-countdown'
import { PaymentForm } from './payment-form'
import { PaymentChecking, PaymentResult } from './payment-result'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export interface CheckoutPanelProps {
  checkout: TournamentCheckout
  /** The countdown reached zero: re-read the checkout from the server. */
  onExpired: () => void
  /** A confirm is about to start: keep the checkout in the URL (`?checkout=`)
   * so a reload or a 3-D Secure return lands back on it. */
  onConfirmStarted: () => void
  /** Cancel the checkout and return to the list with the same events ticked. */
  onChangeSelection: () => void
  /** Cancel the checkout and return to the list. */
  onCancel: () => void
  /** Leave an ended checkout: back to the list with its events ticked, with
   * fresh prices and availability. */
  onReviewAvailability: () => void
  /** A cancel or change is in flight. */
  pending: boolean
  /** The panel opened from `?checkout=` (a reload or a 3-D Secure return): the
   * status read decides what shows before anything is prepared. */
  resumed: boolean
  /** Leave a settled payment's result. */
  onDone: () => void
}

/**
 * The checkout panel (#1809). While a checkout is open it replaces the event
 * list: the summary on the left and payment on the right, one column on a
 * phone. Every state it shows comes from the server.
 */
export function CheckoutPanel({
  checkout,
  onExpired,
  onConfirmStarted,
  onChangeSelection,
  onCancel,
  onReviewAvailability,
  pending,
  resumed,
  onDone,
}: CheckoutPanelProps) {
  const session = useSession()
  const user = session.data?.data.user
  const accountEmail = user?.confirmed_at ? (user.email ?? '') : ''
  const [confirmAttempted, setConfirmAttempted] = useState(false)
  const [declined, setDeclined] = useState(false)

  // Decided once, when the panel opens. The panel writes `?checkout=` itself
  // just before a confirm; reading that as a resume would swap the card form
  // out while Stripe is still confirming.
  const [resumedOnOpen] = useState(resumed)
  const statusEnabled = resumedOnOpen || confirmAttempted
  const status = usePaymentStatus(checkout.tournamentId, checkout.id, statusEnabled)
  // Prepare (the only read with the client secret) only while there is still
  // something to pay. After a reload or a return, wait for the status first.
  const payable =
    !statusEnabled ||
    status.isError ||
    (status.data !== undefined &&
      !isSettled(status.data) &&
      status.data.state !== 'checking')
  const prepared = usePreparedPayment(
    checkout.tournamentId,
    checkout.id,
    checkout.status === 'active' && payable,
  )
  const saveReceipt = useSaveReceiptAddress(checkout.tournamentId, checkout.id)
  const preparedPayment = prepared.data
  const payment = status.data ?? preparedPayment
  const checking = payment?.state === 'checking'
  const active = checkout.status === 'active'

  let paymentArea: React.ReactNode
  if (payment && isSettled(payment)) {
    paymentArea = <PaymentResult payment={payment} onDone={onDone} />
  } else if (checking) {
    paymentArea = <PaymentChecking />
  } else if (statusEnabled && status.isPending && !preparedPayment?.clientSecret) {
    // Only before there is a card form. After a confirm, the form stays
    // mounted while the status re-reads, so the player's card details and
    // Stripe's own inline messages survive a retryable decline.
    paymentArea = <p role="status">Checking your checkout…</p>
  } else if (!active) {
    paymentArea = (
      <div className="flex flex-col items-start gap-3">
        <h3 className="text-base font-semibold">
          {checkout.status === 'expired' ? 'Your hold ended' : 'Your checkout ended'}
        </h3>
        <p className="text-sm text-muted-foreground">
          Your places are no longer held. Check what’s still available and check out again.
        </p>
        <Button onClick={onReviewAvailability}>Review availability</Button>
      </div>
    )
  } else if (prepared.isError && !prepared.isFetching) {
    paymentArea = (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="text-sm">
          We couldn’t start your payment. Your places are still held.
        </p>
        <Button variant="outline" onClick={() => void prepared.refetch()}>
          Try again
        </Button>
      </div>
    )
  } else if (
    preparedPayment &&
    !preparedPayment.clientSecret &&
    (preparedPayment.state === 'failed' ||
      preparedPayment.state === 'expired' ||
      preparedPayment.state === 'cancelled')
  ) {
    // Terminal: asking again would get the same answer.
    paymentArea = (
      <p role="alert" className="text-sm">
        This payment couldn’t be set up. Cancel this checkout and check out again.
      </p>
    )
  } else if (!preparedPayment?.clientSecret) {
    paymentArea = <p role="status">Preparing payment…</p>
  } else {
    paymentArea = (
      <PaymentForm
        publishableKey={preparedPayment.publishableKey}
        clientSecret={preparedPayment.clientSecret}
        totalCents={checkout.totalCents}
        returnUrl={checkoutReturnUrl(checkout.tournamentId, checkout.id)}
        defaultReceiptAddress={preparedPayment.receiptAddress ?? accountEmail}
        receiptOptional={accountEmail === ''}
        lastErrorCode={status.data?.lastErrorCode ?? null}
        // Wait for the server's safe code rather than flash a guessed message.
        declined={declined && !status.isFetching}
        saveReceiptAddress={(address) => saveReceipt.mutateAsync(address)}
        onConfirmStarted={() => {
          setDeclined(false)
          onConfirmStarted()
        }}
        onConfirmSettled={(outcome) => {
          setConfirmAttempted(true)
          setDeclined(outcome === 'declined')
          void status.refetch()
        }}
      />
    )
  }

  return (
    <Card asChild className="border-l-4 border-l-primary">
      <section aria-label="Checkout">
        <CardContent className="grid gap-6 py-5 md:grid-cols-2">
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Your entries</h2>
            <ul className="divide-y divide-border/70">
              {checkout.lines.map((line) => (
                <li key={line.eventId} className="flex items-baseline justify-between gap-4 py-2.5">
                  <span className="min-w-0 break-words font-medium">{line.eventName}</span>
                  <span className="shrink-0 tabular-nums">{usd.format(line.priceCents / 100)}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-between border-t pt-3 text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{usd.format(checkout.totalCents / 100)}</span>
            </div>
            {active && !checking && !(payment && isSettled(payment)) && (
              <CheckoutCountdown key={checkout.id} expiresAt={checkout.expiresAt} onExpired={onExpired} />
            )}
            <p className="flex gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="mt-0.5 shrink-0" size={15} aria-hidden />
              <span>
                Withdraw before registration closes for a full refund of that event’s fee.{' '}
                <a
                  href="/refund-terms"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary underline underline-offset-4"
                >
                  Refund terms
                </a>
              </span>
            </p>
            {active && !(payment && isSettled(payment)) && (
              <div className="flex flex-wrap gap-2">
                {!checking && (
                  <ConfirmButton
                    label="Change selection"
                    title="Change your selection?"
                    description="Changing your selection releases the places this checkout holds. Your new choices are checked again and get a new hold."
                    keepLabel="Keep checkout"
                    confirmLabel="Release and change"
                    pending={pending}
                    onConfirm={onChangeSelection}
                  />
                )}
                <ConfirmButton
                  label="Cancel checkout"
                  title="Cancel this checkout?"
                  description={
                    checking
                      ? 'We’re still checking your payment. If the charge goes through, we refund it in full.'
                      : 'This releases the places this checkout holds.'
                  }
                  keepLabel="Keep checkout"
                  confirmLabel="Cancel checkout"
                  pending={pending}
                  onConfirm={onCancel}
                />
              </div>
            )}
          </div>
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Payment</h2>
            {paymentArea}
          </div>
        </CardContent>
      </section>
    </Card>
  )
}

function ConfirmButton({
  label,
  title,
  description,
  keepLabel,
  confirmLabel,
  pending,
  onConfirm,
}: {
  label: string
  title: string
  description: string
  keepLabel: string
  confirmLabel: string
  pending: boolean
  onConfirm: () => void
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={pending}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{keepLabel}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
