import { http, HttpResponse } from 'msw'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/mocks/server'
import { cardPaymentElementOptions } from './checkout-payment-options'
import type { CheckoutBrowserPaymentAdapter } from './checkout-page'
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

  it('treats browser success as a claim and refetches authoritative status', async () => {
    const reads = serve({ statuses: [payment({ payment_state: 'checking', client_secret: null })] })
    const stripe = adapter({ kind: 'submitted' })
    page.render(stripe)
    await userEvent.setup().click(await screen.findByRole('button', { name: /pay/i }))

    expect(await screen.findByText('Payment is still being confirmed')).toBeInTheDocument()
    expect(reads.statusReads()).toBe(1)
    expect(screen.queryByText(/entry confirmed/i)).not.toBeInTheDocument()
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
