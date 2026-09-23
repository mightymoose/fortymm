import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { loadStripe } from '@stripe/stripe-js'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useLocation } from '@tanstack/react-router'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cardPaymentElementOptions } from './checkout-payment-options'
import { receiptMutationErrorMessage } from './checkout-receipt-errors'

type Checkout = components['schemas']['TournamentCheckoutRead'] & {
  tournament_name?: string
}
type Payment = components['schemas']['TournamentPaymentRead']

const checkoutWireSchema = z.object({
  id: z.string(),
  request_id: z.string(),
  tournament_id: z.string(),
  tournament_name: z.string().optional(),
  registration_generation: z.number().int().nonnegative(),
  status: z.enum(['active', 'cancelled', 'expired', 'invalidated']),
  payment_state: z.enum(['unavailable', 'preparing', 'ready', 'checking', 'action_required', 'succeeded', 'failed', 'expired', 'canceled']),
  currency: z.string().length(3),
  total_cents: z.number().int().positive(),
  created_at: z.string(),
  expires_at: z.string(),
  remaining_seconds: z.number().int().nonnegative(),
  lines: z.array(z.object({
    event_id: z.string(),
    event_name: z.string(),
    price_cents: z.number().int().positive(),
  })),
})

const paymentWireSchema = z.object({
  checkout_id: z.string(),
  payment_state: z.enum(['unavailable', 'preparing', 'ready', 'checking', 'action_required', 'succeeded', 'failed', 'expired', 'canceled']),
  client_secret: z.string().nullable(),
  receipt_email: z.string().nullable(),
  receipt_editable: z.boolean().default(true),
  support_reference: z.string().nullable().optional(),
  lines: z.array(z.object({
    event_id: z.string(),
    amount_cents: z.number().int().positive(),
    outcome: z.enum(['confirmed', 'refund_pending']).nullable(),
    refund_amount_cents: z.number().int().nonnegative(),
  })),
})

const receiptDestinationSchema = z.object({
  receiptEmail: z.string().trim().max(320).refine(
    (value) => value === '' || z.email().safeParse(value).success,
    'Enter a valid email address or leave this blank.',
  ),
})
type ReceiptDestination = z.infer<typeof receiptDestinationSchema>

function parsePayment(value: Payment): Payment {
  return paymentWireSchema.parse(value) as Payment
}

export interface CheckoutBrowserPaymentAdapter {
  element: ReactNode
  confirmPayment(args: {
    clientSecret: string
    returnUrl: string
  }): Promise<
    | { kind: 'submitted' }
    | { kind: 'declined'; message: string }
    | { kind: 'failed'; message: string }
  >
}

interface CheckoutPageProps {
  tournamentId: string
  checkoutId: string
  paymentAdapter?: CheckoutBrowserPaymentAdapter
  now?: () => number
}

const stripeKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined
const stripePromise = stripeKey ? loadStripe(stripeKey) : Promise.resolve(null)
function money(cents: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(cents / 100)
}

function paymentPath(tournamentId: string, checkoutId: string) {
  return {
    tournament_id: tournamentId,
    checkout_id: checkoutId,
  }
}

function StripeAdapterBridge({
  onReady,
}: {
  onReady: (adapter: CheckoutBrowserPaymentAdapter | null) => void
}) {
  const stripe = useStripe()
  const elements = useElements()

  useEffect(() => {
    if (!stripe || !elements) {
      onReady(null)
      return
    }
    onReady({
      element: <PaymentElement options={cardPaymentElementOptions} />,
      confirmPayment: async ({ returnUrl }) => {
        const result = await stripe.confirmPayment({
          elements,
          confirmParams: { return_url: returnUrl },
          redirect: 'if_required',
        })
        if (!result.error) return { kind: 'submitted' }
        if (result.error.type === 'card_error') {
          return {
            kind: 'declined',
            message: 'Your card was declined.',
          }
        }
        return {
          kind: 'failed',
          message: 'We could not submit that payment. Try again.',
        }
      },
    })
    return () => onReady(null)
  }, [elements, onReady, stripe])
  return null
}

export function CheckoutPage(props: CheckoutPageProps) {
  return (
    <CheckoutPageContent
      key={`${props.tournamentId}:${props.checkoutId}`}
      {...props}
    />
  )
}

function CheckoutPageContent({
  tournamentId,
  checkoutId,
  paymentAdapter: injectedAdapter,
  now: injectedNow,
}: CheckoutPageProps) {
  const search = useLocation({ select: (location) => location.searchStr })
  const redirected = new URLSearchParams(search).has('redirect_status')
  const [stripeAdapter, setStripeAdapter] = useState<CheckoutBrowserPaymentAdapter | null>(null)
  const receiptForm = useForm<ReceiptDestination>({
    resolver: zodResolver(receiptDestinationSchema),
    defaultValues: { receiptEmail: '' },
  })
  const [localError, setLocalError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [checkout, setCheckout] = useState<Checkout | null>(null)
  const [payment, setPayment] = useState<Payment | null>(null)
  const [failedLoadKey, setFailedLoadKey] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [authoritativePayment, setAuthoritativePayment] = useState<Payment | null>(null)
  const [statusUncertain, setStatusUncertain] = useState(false)
  const [now, setNow] = useState(() => (injectedNow ?? Date.now)())
  const adapter = injectedAdapter ?? stripeAdapter
  const loadKey = `${tournamentId}:${checkoutId}:${redirected}:${loadAttempt}`

  useEffect(() => {
    let current = true
    const preparePayment = async (): Promise<Payment> =>
      parsePayment(unwrap(
        'prepare payment',
        await api.POST(
          '/v1/tournaments/{tournament_id}/checkouts/{checkout_id}/payment',
          {
            params: { path: paymentPath(tournamentId, checkoutId) },
            body: {},
          },
        ),
      ))

    void api.GET('/v1/tournaments/{tournament_id}/checkouts/{checkout_id}', {
      params: { path: paymentPath(tournamentId, checkoutId) },
    })
      .then(async (checkoutResult) => {
        const loadedCheckout = checkoutWireSchema.parse(
          unwrap('load checkout', checkoutResult),
        ) as Checkout
        if (!current) return
        const paymentResult = await api.GET(
          '/v1/tournaments/{tournament_id}/checkouts/{checkout_id}/payment',
          { params: { path: paymentPath(tournamentId, checkoutId) } },
        )
        if (!current) return
        let loadedPayment: Payment
        if (paymentResult.response.status === 404) {
          if (loadedCheckout.status !== 'active') {
            // Older terminal checkouts may predate a durable payment row. The
            // checkout projection is still authoritative history: render it
            // without retrying preparation or turning a terminal state into a
            // generic load failure.
            loadedPayment = parsePayment({
              checkout_id: loadedCheckout.id,
              payment_state: loadedCheckout.payment_state,
              client_secret: null,
              receipt_email: null,
              receipt_editable: false,
              support_reference: null,
              lines: loadedCheckout.lines.map((line) => ({
                event_id: line.event_id,
                amount_cents: line.price_cents,
                outcome: null,
                refund_amount_cents: 0,
              })),
            })
          } else {
            loadedPayment = await preparePayment()
          }
        } else {
          const status = parsePayment(unwrap('check payment', paymentResult))
          loadedPayment =
            loadedCheckout.status === 'active' &&
            (status.payment_state === 'ready' ||
              status.payment_state === 'action_required')
              ? await preparePayment()
              : status
        }
        if (!current) return
        setCheckout(loadedCheckout)
        receiptForm.reset({ receiptEmail: loadedPayment.receipt_email ?? '' })
        setPayment(loadedPayment)
      })
      .catch(() => {
        if (current) setFailedLoadKey(loadKey)
      })
    return () => { current = false }
  }, [checkoutId, loadAttempt, loadKey, receiptForm, redirected, tournamentId])

  useEffect(() => {
    if (injectedNow) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [injectedNow])

  useEffect(() => {
    if (injectedNow || !checkout) return
    const expiresAt = new Date(checkout.expires_at).getTime()
    const delay = Math.max(0, expiresAt - Date.now())
    const timer = window.setTimeout(() => setNow(Date.now()), delay)
    return () => window.clearTimeout(timer)
  }, [checkout, injectedNow])

  const confirm = receiptForm.handleSubmit(async ({ receiptEmail }) => {
      if (!adapter || !payment?.client_secret) return
      let paymentSubmitted = false
      setSubmitting(true)
      setLocalError(null)
      setStatusUncertain(false)
      try {
        const prepared = parsePayment(unwrap(
          'update receipt destination',
          await api.POST(
            '/v1/tournaments/{tournament_id}/checkouts/{checkout_id}/payment',
            {
              params: { path: paymentPath(tournamentId, checkoutId) },
              body: { receipt_email: receiptEmail.trim() || null },
            },
          ),
        ))
        setAuthoritativePayment(null)
        setPayment(prepared)
        if (!prepared.client_secret) return
        const result = await adapter.confirmPayment({
          clientSecret: prepared.client_secret,
          returnUrl: `${window.location.origin}/tournaments/${tournamentId}/checkouts/${checkoutId}`,
        })
        if (result.kind !== 'submitted') {
          setLocalError(result.message)
          return
        }
        paymentSubmitted = true
        flushSync(() => {
          setAuthoritativePayment({
            ...prepared,
            payment_state: 'checking',
            client_secret: null,
          })
        })
        const status = parsePayment(unwrap(
          'check payment',
          await api.GET(
            '/v1/tournaments/{tournament_id}/checkouts/{checkout_id}/payment',
            { params: { path: paymentPath(tournamentId, checkoutId) } },
          ),
        ))
        setAuthoritativePayment(status)
      } catch (error) {
        if (paymentSubmitted) {
          setStatusUncertain(true)
          return
        }
        const message = receiptMutationErrorMessage(error)
        if (message) {
          receiptForm.setError('receiptEmail', {
            type: 'server',
            message,
          })
          return
        }
        setLocalError('We could not submit that payment. Try again.')
      } finally {
        setSubmitting(false)
      }
  })

  const remainingSeconds = checkout
    ? Math.max(0, Math.ceil((new Date(checkout.expires_at).getTime() - now) / 1000))
    : 0
  const deadline = `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')} remaining`
  const displayedPayment = authoritativePayment ?? payment
  const state = displayedPayment?.payment_state ?? 'preparing'
  const paymentIsTerminal =
    state === 'succeeded' ||
    state === 'failed' ||
    state === 'expired' ||
    state === 'canceled'
  const locallyExpired =
    !!checkout &&
    new Date(checkout.expires_at).getTime() <= now &&
    !paymentIsTerminal
  const receiptIsEditable =
    displayedPayment?.receipt_editable !== false &&
    checkout?.status === 'active' && !locallyExpired && !paymentIsTerminal
  const lineOutcomes = useMemo(
    () => new Map(displayedPayment?.lines.map((line) => [line.event_id, line])),
    [displayedPayment?.lines],
  )
  const canPay =
    !locallyExpired &&
    (state === 'ready' || state === 'action_required') &&
    !!payment?.client_secret &&
    !!adapter
  const title = checkout?.tournament_name ?? 'Tournament checkout'

  const saveReceiptDestination = receiptForm.handleSubmit(async ({ receiptEmail }) => {
    setSubmitting(true)
    setLocalError(null)
    try {
      const prepared = parsePayment(unwrap(
        'update receipt destination',
        await api.POST(
          '/v1/tournaments/{tournament_id}/checkouts/{checkout_id}/payment',
          {
            params: { path: paymentPath(tournamentId, checkoutId) },
            body: { receipt_email: receiptEmail.trim() || null },
          },
        ),
      ))
      setAuthoritativePayment(null)
      setPayment(prepared)
    } catch (error) {
      const message = receiptMutationErrorMessage(error)
      if (message) {
        receiptForm.setError('receiptEmail', {
          type: 'server',
          message,
        })
        return
      }
      setLocalError('We could not save that receipt email. Try again.')
    } finally {
      setSubmitting(false)
    }
  })

  if (failedLoadKey === loadKey) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 p-6">
        <p role="alert">We could not load this checkout. Try again.</p>
        <Button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
          Try again
        </Button>
      </div>
    )
  }

  if (!checkout || !payment) {
    return <div role="status" className="mx-auto max-w-2xl p-6">Loading checkout…</div>
  }

  return (
    <main aria-label="Checkout" className="mx-auto w-full max-w-2xl space-y-5 p-4 sm:p-8">
      <div>
        <p className="fortymm-overline">Secure checkout</p>
        <h1 className="font-heading text-3xl font-bold">{title}</h1>
        {state !== 'succeeded' && (
          <p aria-label={deadline} className="mt-2 font-mono text-sm text-muted-foreground">
            {deadline}
          </p>
        )}
      </div>

      <Card>
        <CardHeader><CardTitle>Your events</CardTitle></CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {checkout.lines.map((line) => {
              const result = lineOutcomes.get(line.event_id)
              return (
                <li key={line.event_id} className="flex items-start justify-between gap-4 py-3">
                  <span className="flex w-full items-start justify-between gap-4">
                    <span className="block font-medium">{line.event_name}</span>
                    {result?.outcome === 'confirmed' && <span className="text-sm text-[color:var(--win)]">Entry confirmed</span>}
                    {result?.outcome === 'refund_pending' && <span className="text-sm text-[color:var(--warning)]">Not admitted — refund pending</span>}
                    <span className="font-mono">{money(result?.refund_amount_cents || line.price_cents, checkout.currency)}</span>
                  </span>
                </li>
              )
            })}
            <li className="flex justify-between py-3 font-semibold">
              <span>Total</span>
              <span className="font-mono">{money(checkout.total_cents, checkout.currency)}</span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            If an event cannot admit you after payment, its full entry fee is
            marked for refund.
          </p>
        </CardContent>
      </Card>

      {receiptIsEditable && (
        <Card>
          <CardHeader><CardTitle>Receipt destination</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="receipt-email">Receipt email (optional)</Label>
              <Input
                id="receipt-email"
                type="email"
                aria-invalid={!!receiptForm.formState.errors.receiptEmail}
                {...receiptForm.register('receiptEmail')}
              />
              {receiptForm.formState.errors.receiptEmail && (
                <p className="text-xs text-destructive">{receiptForm.formState.errors.receiptEmail.message}</p>
              )}
              <p className="text-xs text-muted-foreground">Stripe sends the financial receipt to this address. This does not change your account email.</p>
            </div>
            {state !== 'ready' && state !== 'action_required' && (
              <Button type="button" variant="outline" onClick={() => void saveReceiptDestination()} disabled={submitting}>
                Save receipt email
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {state === 'succeeded' ? (
        <section aria-live="polite" className="rounded-xl border border-[color:var(--win)]/30 bg-[color:var(--win)]/10 p-4">
          <h2 className="font-heading text-lg font-semibold">Payment confirmed</h2>
          <p className="text-sm text-muted-foreground">Your confirmed entries are shown above.</p>
          <Button asChild variant="outline" className="mt-3">
            <a href={`/tournaments/${checkout.tournament_id}`}>Return to tournament</a>
          </Button>
        </section>
      ) : locallyExpired ? (
        <StateMessage title="Checkout expired" body="Your reservation has ended. Start a new checkout from the tournament." />
      ) : state === 'checking' ? (
        <StateMessage
          title="Payment is still being confirmed"
          body={statusUncertain
            ? 'Payment confirmation status is uncertain. You can safely leave this page and check your dashboard later.'
            : 'You can safely leave this page and check your dashboard later.'}
        />
      ) : state === 'action_required' && !displayedPayment?.client_secret ? (
        <StateMessage title="Finish card authentication" body="Complete the verification requested by your card issuer." />
      ) : state === 'expired' || checkout.status === 'expired' ? (
        <StateMessage title="Checkout expired" body="Your reservation has ended. Start a new checkout from the tournament." />
      ) : state === 'failed' ? (
        <StateMessage title="Payment needs review" body={`No further action is needed right now.${displayedPayment?.support_reference ? ` Support reference: ${displayedPayment.support_reference}` : ''}`} />
      ) : state === 'canceled' ? (
        <StateMessage title="Checkout canceled" body="No payment action is available for this checkout." />
      ) : state === 'preparing' ? (
        <StateMessage title="Preparing your payment" body="This usually takes only a moment. You can safely return later." />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {state === 'action_required' ? 'Finish card authentication' : 'Pay by card'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {injectedAdapter ? injectedAdapter.element : payment.client_secret && stripeKey ? (
              <Elements stripe={stripePromise} options={{ clientSecret: payment.client_secret }}>
                <PaymentElement options={cardPaymentElementOptions} />
                <StripeAdapterBridge onReady={setStripeAdapter} />
              </Elements>
            ) : (
              <p className="text-sm text-muted-foreground">Card entry is temporarily unavailable.</p>
            )}
            {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
            <Button aria-label={localError ? 'Try card again — pay' : undefined} onClick={() => void confirm()} disabled={!canPay || submitting}>
              {localError
                ? 'Try card again'
                : state === 'action_required'
                  ? 'Continue authentication'
                  : `Pay ${money(checkout.total_cents, checkout.currency)}`}
            </Button>
          </CardContent>
        </Card>
      )}
    </main>
  )
}

function StateMessage({ title, body }: { title: string; body: string }) {
  return (
    <section aria-live="polite" className="rounded-xl border border-border bg-card p-4">
      <h2 className="font-heading text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </section>
  )
}
