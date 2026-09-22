import { http, HttpResponse } from 'msw'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/mocks/server'
import { renderWithRouterContext } from '@/test/router'
import { cardPaymentElementOptions } from './checkout-payment-options'
import {
  CheckoutPage,
  type CheckoutBrowserPaymentAdapter,
} from './checkout-page'
import { checkoutPage as page } from './checkout-page.page'

const checkout = {
  id: 'checkout-1770',
  request_id: 'request-1770',
  tournament_id: 'tournament-1770',
  tournament_name: 'Autumn Open',
  registration_generation: 1,
  status: 'active',
  payment_state: 'ready',
  currency: 'USD',
  total_cents: 3750,
  created_at: '2030-04-20T14:00:00Z',
  expires_at: '2030-04-20T14:10:00Z',
  remaining_seconds: 600,
  lines: [
    { event_id: 'open', event_name: 'Open Singles', price_cents: 2500 },
    { event_id: 'doubles', event_name: 'Open Doubles', price_cents: 1250 },
  ],
}

const payment = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  checkout_id: 'checkout-1770',
  payment_state: 'ready',
  client_secret: 'pi_1770_secret_browser_only',
  receipt_email: 'payer@example.com',
  support_reference: null,
  lines: [
    { event_id: 'open', amount_cents: 2500, outcome: null, refund_amount_cents: 0 },
    { event_id: 'doubles', amount_cents: 1250, outcome: null, refund_amount_cents: 0 },
  ],
  ...overrides,
})

function adapter(
  result: Awaited<ReturnType<CheckoutBrowserPaymentAdapter['confirmPayment']>> = {
    kind: 'submitted',
  },
): CheckoutBrowserPaymentAdapter {
  return {
    element: <label>Card details<input aria-label="Card details" /></label>,
    confirmPayment: vi.fn().mockResolvedValue(result),
  }
}

function CheckoutNavigationHarness({
  paymentAdapter,
}: {
  paymentAdapter: CheckoutBrowserPaymentAdapter
}) {
  const [checkoutId, setCheckoutId] = useState('checkout-a')
  return (
    <>
      <button type="button" onClick={() => setCheckoutId('checkout-b')}>
        Open checkout B
      </button>
      <CheckoutPage
        tournamentId="tournament-1770"
        checkoutId={checkoutId}
        paymentAdapter={paymentAdapter}
        now={() => new Date('2030-04-20T14:00:05Z').getTime()}
      />
    </>
  )
}

function serve({
  prepared = payment(),
  statuses = [prepared],
}: {
  prepared?: Record<string, unknown>
  statuses?: Record<string, unknown>[]
} = {}) {
  let statusRead = 0
  server.use(
    http.get('*/v1/tournaments/:tournamentId/checkouts/:checkoutId', () =>
      HttpResponse.json(checkout),
    ),
    http.post(
      '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
      () => HttpResponse.json(prepared),
    ),
    http.get(
      '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
      () => HttpResponse.json(statuses[Math.min(statusRead++, statuses.length - 1)]),
    ),
  )
  return { statusReads: () => statusRead }
}

beforeEach(() => vi.useRealTimers())

describe('tournament checkout page', () => {
  it('limits the Payment Element to card and disables browser wallets', () => {
    expect(cardPaymentElementOptions).toEqual({
      layout: 'tabs',
      paymentMethodOrder: ['card'],
      wallets: { applePay: 'never', googlePay: 'never' },
    })
  })

  it('shows the server quote, receipt destination, card element, and server deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-04-20T14:00:05Z'))
    serve()
    const stripe = adapter()
    page.render(stripe)

    const main = await screen.findByRole('main', { name: /checkout/i })
    expect(within(main).getByText('Open Singles').parentElement).toHaveTextContent('$25.00')
    expect(within(main).getByText('Open Doubles').parentElement).toHaveTextContent('$12.50')
    expect(within(main).getByText('Total').parentElement).toHaveTextContent('$37.50')
    expect(screen.getByLabelText('09:55 remaining')).toBeInTheDocument()
    expect(page.getReceiptEmail()).toHaveValue('payer@example.com')
    expect(screen.getByRole('textbox', { name: /card details/i })).toBeInTheDocument()
    expect(page.getCardAction()).toBeEnabled()
  })

  it.each([
    ['checkout', '*/v1/tournaments/:tournamentId/checkouts/:checkoutId'],
    ['payment', '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment'],
  ])('replaces loading with an actionable error when the initial %s request fails', async (_request, url) => {
    serve()
    server.use(
      http.get(url, () => HttpResponse.json({ detail: 'Unavailable.' }, { status: 503 })),
      http.post(url, () => HttpResponse.json({ detail: 'Unavailable.' }, { status: 503 })),
    )

    page.render(adapter())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not load this checkout. Try again.',
    )
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(screen.queryByText('Loading checkout…')).not.toBeInTheDocument()
  })

  it.each([
    ['preparing', 'Preparing your payment'],
    ['checking', 'Payment is still being confirmed'],
    ['action_required', 'Finish card authentication'],
    ['expired', 'Checkout expired'],
    ['failed', 'Payment needs review'],
  ])('renders the safe %s state', async (paymentState, copy) => {
    serve({ prepared: payment({ payment_state: paymentState, client_secret: null, support_reference: paymentState === 'failed' ? 'PAY-1770' : null }) })
    page.render(adapter())
    expect(await screen.findByText(copy)).toBeInTheDocument()
    if (paymentState === 'failed') {
      expect(screen.getByText(/PAY-1770/)).toBeInTheDocument()
      expect(document.body).not.toHaveTextContent('pi_1770_secret_browser_only')
    }
  })

  it.each([
    ['failed', 'Payment needs review'],
    ['canceled', 'Checkout canceled'],
    ['expired', 'Checkout expired'],
  ])('does not offer receipt edits after a %s payment is terminal', async (paymentState, copy) => {
    serve({
      prepared: payment({
        payment_state: paymentState,
        client_secret: null,
        support_reference: paymentState === 'failed' ? 'PAY-1770' : null,
      }),
    })
    page.render(adapter())

    expect(await screen.findByText(copy)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /receipt email/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save receipt email/i })).not.toBeInTheDocument()
  })

  it('offers receipt edits while a nonterminal checking payment still accepts updates', async () => {
    serve({
      prepared: payment({ payment_state: 'checking', client_secret: null }),
    })
    page.render(adapter())

    expect(await screen.findByText('Payment is still being confirmed')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /receipt email/i })).toHaveValue('payer@example.com')
    expect(screen.getByRole('button', { name: /save receipt email/i })).toBeEnabled()
  })

  it('keeps a decline retryable against the same checkout and payment', async () => {
    serve()
    const stripe = adapter({ kind: 'declined', message: 'Your card was declined.' })
    page.render(stripe)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /pay/i }))

    expect(await screen.findByText('Your card was declined.')).toBeInTheDocument()
    expect(page.getCardAction()).toHaveAccessibleName(/try card again/i)
    await user.click(page.getCardAction())
    expect(stripe.confirmPayment).toHaveBeenCalledTimes(2)
    expect(stripe.confirmPayment).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientSecret: 'pi_1770_secret_browser_only' }),
    )
  })

  it('sends an edited or cleared receipt destination before card confirmation', async () => {
    let submittedBody: unknown
    serve()
    server.use(
      http.post(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
        async ({ request }) => {
          submittedBody = await request.json()
          return HttpResponse.json(payment({ receipt_email: null }))
        },
      ),
    )
    const stripe = adapter()
    page.render(stripe)
    const user = userEvent.setup()
    const email = await screen.findByRole('textbox', { name: /receipt email/i })
    await user.clear(email)
    await user.click(page.getCardAction())

    expect(submittedBody).toEqual({ receipt_email: null })
    expect(stripe.confirmPayment).toHaveBeenCalledOnce()
  })

  it.each([409, 422])('maps a %s receipt mutation refusal onto the field', async (status) => {
    serve()
    let calls = 0
    server.use(
      http.post(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
        () => {
          calls += 1
          if (calls === 1) return HttpResponse.json(payment())
          return HttpResponse.json(
            { detail: status === 409 ? { code: 'closed', message: 'Closed.' } : [] },
            { status },
          )
        },
      ),
    )
    const stripe = adapter()
    page.render(stripe)

    await userEvent.setup().click(await screen.findByRole('button', { name: /pay/i }))

    expect(await screen.findByText(
      status === 409
        ? 'This receipt destination can no longer be changed.'
        : 'Enter a valid email address or leave this blank.',
    )).toBeInTheDocument()
    expect(stripe.confirmPayment).not.toHaveBeenCalled()
  })

  it('renders an authoritative terminal response returned when Pay refreshes preparation', async () => {
    let prepares = 0
    serve()
    server.use(
      http.post(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
        () => {
          prepares += 1
          if (prepares === 1) return HttpResponse.json(payment())
          return HttpResponse.json(payment({
            payment_state: 'failed',
            client_secret: null,
            support_reference: 'PAY-TERMINAL',
          }))
        },
      ),
    )
    const stripe = adapter()
    page.render(stripe)

    await userEvent.setup().click(await screen.findByRole('button', { name: /pay/i }))

    expect(await screen.findByText('Payment needs review')).toBeInTheDocument()
    expect(screen.getByText(/PAY-TERMINAL/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument()
    expect(stripe.confirmPayment).not.toHaveBeenCalled()
  })

  it.each(['ready', 'action_required'])(
    'lets a terminal Pay refresh replace a prior authoritative %s result',
    async (authoritativeState) => {
      let prepares = 0
      server.use(
        http.get('*/v1/tournaments/:tournamentId/checkouts/:checkoutId', () =>
          HttpResponse.json(checkout),
        ),
        http.post(
          '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
          () => {
            prepares += 1
            if (prepares < 3) return HttpResponse.json(payment())
            return HttpResponse.json(payment({
              payment_state: 'failed',
              client_secret: null,
              support_reference: 'PAY-AUTHORITATIVE-TERMINAL',
            }))
          },
        ),
        http.get(
          '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
          () => HttpResponse.json(payment({ payment_state: authoritativeState })),
        ),
      )
      const stripe = adapter({ kind: 'submitted' })
      page.render(stripe)
      const user = userEvent.setup()

      await user.click(await screen.findByRole('button', { name: /pay/i }))
      expect(await screen.findByRole('button', { name: /pay|authentication/i })).toBeEnabled()
      await user.click(screen.getByRole('button', { name: /pay|authentication/i }))

      expect(await screen.findByText('Payment needs review')).toBeInTheDocument()
      expect(screen.getByText(/PAY-AUTHORITATIVE-TERMINAL/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /pay|authentication/i })).not.toBeInTheDocument()
      expect(stripe.confirmPayment).toHaveBeenCalledOnce()
    },
  )

  it.each([
    ['failed', 'Payment needs review'],
    ['canceled', 'Checkout canceled'],
    ['succeeded', 'Payment confirmed'],
  ])(
    'lets a terminal %s receipt-save response replace prior authoritative checking',
    async (terminalState, terminalCopy) => {
      let statusReads = 0
      let prepares = 0
      server.use(
        http.get('*/v1/tournaments/:tournamentId/checkouts/:checkoutId', () =>
          HttpResponse.json(checkout),
        ),
        http.get(
          '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
          () => {
            statusReads += 1
            return HttpResponse.json(
              statusReads === 1
                ? payment()
                : payment({ payment_state: 'checking', client_secret: null }),
            )
          },
        ),
        http.post(
          '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
          () => {
            prepares += 1
            if (prepares < 3) return HttpResponse.json(payment())
            return HttpResponse.json(payment({
              payment_state: terminalState,
              client_secret: null,
              support_reference: terminalState === 'failed' ? 'PAY-RECEIPT-TERMINAL' : null,
            }))
          },
        ),
      )
      const stripe = adapter({ kind: 'submitted' })
      page.render(stripe)
      const user = userEvent.setup()

      await user.click(await screen.findByRole('button', { name: /pay/i }))
      expect(await screen.findByText('Payment is still being confirmed')).toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: /receipt email/i })).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /save receipt email/i }))

      expect(await screen.findByText(terminalCopy)).toBeInTheDocument()
      expect(screen.queryByRole('textbox', { name: /receipt email/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /save receipt email/i })).not.toBeInTheDocument()
      expect(stripe.confirmPayment).toHaveBeenCalledOnce()
    },
  )

  it('treats browser success as a claim and refetches authoritative status', async () => {
    const reads = serve({
      statuses: [
        payment(),
        payment({ payment_state: 'checking', client_secret: null }),
      ],
    })
    const stripe = adapter({ kind: 'submitted' })
    page.render(stripe)
    await userEvent.setup().click(await screen.findByRole('button', { name: /pay/i }))

    expect(await screen.findByText('Payment is still being confirmed')).toBeInTheDocument()
    expect(reads.statusReads()).toBe(2)
    expect(screen.queryByText(/entry confirmed/i)).not.toBeInTheDocument()
  })

  it('does not carry checkout A settlement into checkout B during client-side navigation', async () => {
    const checkoutFor = (checkoutId: string) => ({
      ...checkout,
      id: checkoutId,
      request_id: `request-${checkoutId}`,
      tournament_name: checkoutId === 'checkout-a' ? 'Autumn Open' : 'Spring Open',
      lines: [
        {
          event_id: 'open',
          event_name: checkoutId === 'checkout-a' ? 'Autumn Singles' : 'Spring Singles',
          price_cents: 3750,
        },
      ],
    })
    const paymentFor = (checkoutId: string, overrides: Record<string, unknown> = {}) =>
      payment({
        checkout_id: checkoutId,
        lines: [
          {
            event_id: 'open',
            amount_cents: 3750,
            outcome: null,
            refund_amount_cents: 0,
          },
        ],
        ...overrides,
      })
    const statusReads = new Map<string, number>()

    server.use(
      http.get(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId',
        ({ params }) => HttpResponse.json(checkoutFor(String(params.checkoutId))),
      ),
      http.post(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
        ({ params }) => HttpResponse.json(paymentFor(String(params.checkoutId))),
      ),
      http.get(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
        ({ params }) => {
          const checkoutId = String(params.checkoutId)
          const read = statusReads.get(checkoutId) ?? 0
          statusReads.set(checkoutId, read + 1)
          if (read === 0) return HttpResponse.json(paymentFor(checkoutId))
          return HttpResponse.json(paymentFor(checkoutId, {
            payment_state: 'succeeded',
            client_secret: null,
            lines: [
              {
                event_id: 'open',
                amount_cents: 3750,
                outcome: 'confirmed',
                refund_amount_cents: 0,
              },
            ],
          }))
        },
      ),
    )

    renderWithRouterContext(
      <CheckoutNavigationHarness paymentAdapter={adapter()} />,
      {
        initialEntries: [
          '/tournaments/tournament-1770/checkouts/checkout-a',
        ],
      },
    )
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /pay/i }))
    expect(await screen.findByText('Payment confirmed')).toBeInTheDocument()
    expect(screen.getByText('Autumn Singles').parentElement).toHaveTextContent(
      'Entry confirmed',
    )

    await user.click(screen.getByRole('button', { name: 'Open checkout B' }))

    const springEntry = await screen.findByText('Spring Singles')
    expect(screen.getByRole('heading', { name: 'Spring Open' })).toBeInTheDocument()
    expect(springEntry.parentElement).not.toHaveTextContent('Entry confirmed')
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /pay/i })).toBeEnabled()
  })

  it('ignores redirect claims and renders only the refetched server result', async () => {
    const reads = serve({ statuses: [payment({ payment_state: 'checking', client_secret: null })] })
    page.render(
      adapter(),
      '/tournaments/tournament-1770/checkouts/checkout-1770?redirect_status=succeeded&payment_intent=pi_fake',
    )

    expect(await screen.findByText('Payment is still being confirmed')).toBeInTheDocument()
    expect(reads.statusReads()).toBe(1)
    expect(screen.queryByText(/entry confirmed/i)).not.toBeInTheDocument()
  })

  it('loads retained payment status before attempting preparation from a dashboard link', async () => {
    let statusReads = 0
    let prepares = 0
    server.use(
      http.get('*/v1/tournaments/:tournamentId/checkouts/:checkoutId', () =>
        HttpResponse.json({ ...checkout, status: 'invalidated' }),
      ),
      http.get(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
        () => {
          statusReads += 1
          return HttpResponse.json(payment({
            payment_state: 'checking',
            client_secret: null,
          }))
        },
      ),
      http.post(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
        () => {
          prepares += 1
          return HttpResponse.json({ detail: 'Not found.' }, { status: 404 })
        },
      ),
    )

    page.render(adapter())

    expect(await screen.findByText('Payment is still being confirmed')).toBeInTheDocument()
    expect(statusReads).toBe(1)
    expect(prepares).toBe(0)
    expect(screen.queryByText('We could not load this checkout. Try again.')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /receipt email/i })).not.toBeInTheDocument()
  })

  it('loads an active retained checking payment before attempting preparation', async () => {
    let statusReads = 0
    let prepares = 0
    server.use(
      http.get('*/v1/tournaments/:tournamentId/checkouts/:checkoutId', () =>
        HttpResponse.json(checkout),
      ),
      http.get(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
        () => {
          statusReads += 1
          return HttpResponse.json(payment({
            payment_state: 'checking',
            client_secret: null,
          }))
        },
      ),
      http.post(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
        () => {
          prepares += 1
          return HttpResponse.json({ detail: 'Preparation is no longer authorized.' }, { status: 404 })
        },
      ),
    )

    page.render(adapter())

    expect(await screen.findByText('Payment is still being confirmed')).toBeInTheDocument()
    expect(statusReads).toBe(1)
    expect(prepares).toBe(0)
  })

  it('does not prepare an abandoned checkout after its delayed route load resolves', async () => {
    let releaseCheckoutA!: () => void
    let markCheckoutAStarted!: () => void
    let markCheckoutAResponded!: () => void
    let markAbandonedPrepare!: () => void
    const checkoutARelease = new Promise<void>((resolve) => { releaseCheckoutA = resolve })
    const checkoutAStarted = new Promise<void>((resolve) => { markCheckoutAStarted = resolve })
    const checkoutAResponded = new Promise<void>((resolve) => { markCheckoutAResponded = resolve })
    const abandonedPrepare = new Promise<boolean>((resolve) => {
      markAbandonedPrepare = () => resolve(true)
    })
    const checkoutFor = (checkoutId: string) => ({
      ...checkout,
      id: checkoutId,
      request_id: `request-${checkoutId}`,
      tournament_name: checkoutId === 'checkout-a' ? 'Autumn Open' : 'Spring Open',
    })

    server.use(
      http.get(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId',
        async ({ params }) => {
          const checkoutId = String(params.checkoutId)
          if (checkoutId === 'checkout-a') {
            markCheckoutAStarted()
            await checkoutARelease
            markCheckoutAResponded()
          }
          return HttpResponse.json(checkoutFor(checkoutId))
        },
      ),
      http.get(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
        ({ params }) => HttpResponse.json(payment({
          checkout_id: String(params.checkoutId),
          payment_state: 'checking',
          client_secret: null,
        })),
      ),
      http.post(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
        ({ params }) => {
          const checkoutId = String(params.checkoutId)
          if (checkoutId === 'checkout-a') markAbandonedPrepare()
          return HttpResponse.json(payment({ checkout_id: checkoutId }))
        },
      ),
    )

    renderWithRouterContext(
      <CheckoutNavigationHarness paymentAdapter={adapter()} />,
      { initialEntries: ['/tournaments/tournament-1770/checkouts/checkout-a'] },
    )
    await checkoutAStarted
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open checkout B' }))
    expect(await screen.findByRole('heading', { name: 'Spring Open' })).toBeInTheDocument()

    releaseCheckoutA()
    await checkoutAResponded
    const preparedAfterCleanup = await Promise.race([
      abandonedPrepare,
      new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 50)),
    ])

    expect(preparedAfterCleanup).toBe(false)
  })

  it('shows successful and mixed event outcomes without flattening them', async () => {
    serve({
      prepared: payment({
        payment_state: 'succeeded',
        client_secret: null,
        lines: [
          { event_id: 'open', amount_cents: 2500, outcome: 'confirmed', refund_amount_cents: 0 },
          { event_id: 'doubles', amount_cents: 1250, outcome: 'refund_pending', refund_amount_cents: 1250 },
        ],
      }),
    })
    page.render(adapter())

    const main = await screen.findByRole('main', { name: /checkout/i })
    expect(within(main).getByText('Open Singles').parentElement).toHaveTextContent('Entry confirmed')
    expect(within(main).getByText('Open Doubles').parentElement).toHaveTextContent('Not admitted — refund pending')
    expect(within(main).getByText('Open Doubles').parentElement).toHaveTextContent('$12.50')
  })

  it('shows every confirmed event after authoritative success', async () => {
    serve({
      prepared: payment({
        payment_state: 'succeeded',
        client_secret: null,
        lines: [
          { event_id: 'open', amount_cents: 2500, outcome: 'confirmed', refund_amount_cents: 0 },
          { event_id: 'doubles', amount_cents: 1250, outcome: 'confirmed', refund_amount_cents: 0 },
        ],
      }),
    })
    page.render(adapter())

    expect(await screen.findByText('Payment confirmed')).toBeInTheDocument()
    expect(screen.getAllByText('Entry confirmed')).toHaveLength(2)
  })

  it('expires a ready checkout locally when its displayed countdown elapses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-04-20T14:10:01Z'))
    serve()
    page.render(adapter())

    expect(await screen.findByText('Checkout expired')).toBeInTheDocument()
    expect(screen.getByLabelText('00:00 remaining')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /card details/i })).not.toBeInTheDocument()
  })

  it('counts the final partial second and removes Pay at the exact local deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-04-20T14:09:59.500Z'))
    serve()
    renderWithRouterContext(
      <CheckoutPage
        tournamentId="tournament-1770"
        checkoutId="checkout-1770"
        paymentAdapter={adapter()}
      />,
      { initialEntries: ['/tournaments/tournament-1770/checkouts/checkout-1770'] },
    )
    await act(async () => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve()
    })

    expect(screen.getByLabelText('00:01 remaining')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /pay/i })).toBeEnabled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499)
    })
    expect(screen.getByRole('button', { name: /pay/i })).toBeEnabled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByText('Checkout expired')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /pay/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /card details/i })).not.toBeInTheDocument()
  })

  it('preserves a terminal payment result after the local checkout deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-04-20T14:10:01Z'))
    serve({
      prepared: payment({
        payment_state: 'succeeded',
        client_secret: null,
        lines: [
          { event_id: 'open', amount_cents: 2500, outcome: 'confirmed', refund_amount_cents: 0 },
          { event_id: 'doubles', amount_cents: 1250, outcome: 'refund_pending', refund_amount_cents: 1250 },
        ],
      }),
    })
    page.render(adapter())

    expect(await screen.findByText('Payment confirmed')).toBeInTheDocument()
    expect(screen.getByText('Open Singles').parentElement).toHaveTextContent('Entry confirmed')
    expect(screen.getByText('Open Doubles').parentElement).toHaveTextContent('Not admitted — refund pending')
    expect(screen.queryByText('Checkout expired')).not.toBeInTheDocument()
  })

  it('reloads or another device into the same prepared payment', async () => {
    let prepares = 0
    serve()
    server.use(
      http.post(
        '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
        () => {
          prepares += 1
          return HttpResponse.json(payment())
        },
      ),
    )
    const first = adapter()
    const firstView = page.render(first)
    await screen.findByRole('textbox', { name: /card details/i })
    firstView.unmount()

    const resumed = adapter()
    page.render(resumed)
    await screen.findByRole('textbox', { name: /card details/i })
    expect(prepares).toBe(2)
    await userEvent.setup().click(page.getCardAction())
    expect(resumed.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: 'pi_1770_secret_browser_only' }),
    )
  })
})
