import userEvent from '@testing-library/user-event'
import { useState } from 'react'

import {
  buildCheckoutRead,
  buildPaymentPrepared,
  buildPaymentRead,
  CHECKOUT_ID,
  CHECKOUT_TOURNAMENT_ID,
  OPEN_SINGLES_ID,
  paymentLines,
  U1500_ID,
} from '@/mocks/factories/checkouts/checkout.factory'
import { http, HttpResponse } from 'msw'

import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { resetStripeDouble, stripeDouble } from '@/test/stripe-double'
import { act, fireEvent, render, screen, waitFor, within } from '@/test/utilities'

import { buildEvent, buildTournament } from '../data/seed.factory'
import { EventsTab } from './events-tab'
import { buildEventsTabProps } from './events-tab.factory'
import { mockCheckoutWorld } from './events-tab/checkout-world'
import { eventsTabPage } from './events-tab.page'

vi.mock('@stripe/stripe-js', () => import('@/test/stripe-double'))
vi.mock('@stripe/react-stripe-js', () => import('@/test/stripe-double'))

beforeEach(() => {
  resetStripeDouble()
})

const tournament = () =>
  buildTournament({
    id: CHECKOUT_TOURNAMENT_ID,
    events: [
      buildEvent({ id: OPEN_SINGLES_ID, name: 'Open Singles', entryFee: 45 }),
      buildEvent({ id: U1500_ID, name: 'U1500', entryFee: 30 }),
    ],
  })

/**
 * Render the Events tab with `?checkout=` held in state, the way the route
 * holds it in the URL. `param()` reads its current value.
 */
function renderCheckoutTab({ checkoutParam }: { checkoutParam?: string } = {}) {
  const url = { param: checkoutParam }
  function Harness() {
    const [param, setParam] = useState(checkoutParam)
    url.param = param
    return (
      <EventsTab
        {...buildEventsTabProps({ tournament: tournament(), canEdit: false })}
        checkoutParam={param}
        onCheckoutParamChange={setParam}
      />
    )
  }
  render(<Harness />)
  return { param: () => url.param }
}

const panel = () => screen.findByRole('region', { name: 'Checkout' })

describe('EventsTab checkout and payment (#1809)', () => {
  it('checks out the selection in one step and shows the card form', async () => {
    const world = mockCheckoutWorld()
    const user = userEvent.setup()
    renderCheckoutTab()

    await user.click(await eventsTabPage.findSelectButton('Open Singles'))
    await user.click(await eventsTabPage.findSelectButton('U1500'))
    await user.click(screen.getByRole('button', { name: 'Check out · $75.00' }))

    const checkout = await panel()
    expect(await within(checkout).findByTestId('stripe-payment-element')).toBeInTheDocument()
    expect(world.calls.createdEventIds).toEqual([[OPEN_SINGLES_ID, U1500_ID]])
    expect(world.calls.log).toEqual(['create', 'prepare'])
    expect(stripeDouble.loadedKeys).toEqual(['pk_test_fortymm'])
    expect(stripeDouble.elementsOptions).toMatchObject({
      clientSecret: 'pi_test_123_secret_abc',
    })
    expect(stripeDouble.paymentElementOptions).toMatchObject({
      wallets: { applePay: 'never', googlePay: 'never' },
    })
    expect(within(checkout).getByRole('button', { name: 'Pay $75.00' })).toBeEnabled()
    // The panel replaces the event list while the checkout is active.
    expect(eventsTabPage.querySelectButton('Open Singles')).not.toBeInTheDocument()
  })

  it('names an event that became unavailable, keeps the player on the list, and lets them remove it', async () => {
    const world = mockCheckoutWorld({
      created: {
        status: 409,
        body: {
          detail: {
            code: 'event_full',
            message: 'This event is full.',
            event_id: U1500_ID,
          },
        },
      },
    })
    const user = userEvent.setup()
    renderCheckoutTab()

    await user.click(await eventsTabPage.findSelectButton('Open Singles'))
    await user.click(await eventsTabPage.findSelectButton('U1500'))
    await user.click(screen.getByRole('button', { name: 'Check out · $75.00' }))

    const refusal = await screen.findByRole('alert')
    expect(refusal).toHaveTextContent('U1500 is no longer available.')
    expect(screen.queryByRole('region', { name: 'Checkout' })).toBeNull()
    // Nothing is dropped silently: both events are still selected.
    expect(screen.getByRole('button', { name: 'Check out · $75.00' })).toBeInTheDocument()

    await user.click(within(refusal).getByRole('button', { name: 'Remove U1500' }))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Check out · $45.00' })).toBeInTheDocument()
    expect(world.calls.createdEventIds).toEqual([[OPEN_SINGLES_ID, U1500_ID]])
  })

  it('names the checkout it shows in the URL, so the bar can leave exactly that one out', async () => {
    mockCheckoutWorld({ current: buildCheckoutRead() })
    const url = renderCheckoutTab()

    await panel()
    await waitFor(() => expect(url.param()).toBe(CHECKOUT_ID))
  })

  it('keeps preparing, with the hold counting down, and asks again until the payment is ready', async () => {
    const world = mockCheckoutWorld({
      current: buildCheckoutRead(),
      prepared: [
        buildPaymentPrepared({ payment_state: 'preparing', client_secret: null }),
        buildPaymentPrepared(),
      ],
    })
    renderCheckoutTab()

    const checkout = await panel()
    expect(await within(checkout).findByText('Preparing payment…')).toBeInTheDocument()
    expect(within(checkout).getByLabelText(/remaining$/)).toBeInTheDocument()
    expect(
      await within(checkout).findByTestId('stripe-payment-element', {}, { timeout: 3_500 }),
    ).toBeInTheDocument()
    expect(world.calls.prepare).toBe(2)
  })

  it('says when the payment cannot start, and tries again on request', async () => {
    const world = mockCheckoutWorld({
      current: buildCheckoutRead(),
      prepared: [
        { status: 409, body: { detail: 'This checkout cannot take a payment right now.' } },
        buildPaymentPrepared(),
      ],
    })
    const user = userEvent.setup()
    renderCheckoutTab()

    const checkout = await panel()
    expect(await within(checkout).findByRole('alert')).toHaveTextContent(
      'We couldn’t start your payment. Your places are still held.',
    )
    expect(within(checkout).queryByText('Preparing payment…')).toBeNull()
    await user.click(within(checkout).getByRole('button', { name: 'Try again' }))

    expect(await within(checkout).findByTestId('stripe-payment-element')).toBeInTheDocument()
    expect(world.calls.prepare).toBe(2)
  })

  it.each(['failed', 'expired', 'cancelled'] as const)(
    'says a %s payment could not be set up, instead of preparing forever',
    async (state) => {
      mockCheckoutWorld({
        current: buildCheckoutRead(),
        prepared: [buildPaymentPrepared({ payment_state: state, client_secret: null })],
      })
      renderCheckoutTab()

      const checkout = await panel()
      expect(await within(checkout).findByRole('alert')).toHaveTextContent(
        'This payment couldn’t be set up. Cancel this checkout and check out again.',
      )
      expect(within(checkout).queryByText('Preparing payment…')).toBeNull()
      expect(within(checkout).getByRole('button', { name: 'Cancel checkout' })).toBeInTheDocument()
    },
  )

  it('lets the player dismiss a payment under review while its checkout is still active', async () => {
    mockCheckoutWorld({
      // A quarantine leaves the checkout itself active.
      current: buildCheckoutRead(),
      prepared: [
        buildPaymentPrepared({
          payment_state: 'needs_review',
          client_secret: null,
          lines: paymentLines('refund_pending'),
        }),
      ],
    })
    const user = userEvent.setup()
    renderCheckoutTab()

    const checkout = await panel()
    await within(checkout).findByRole('heading', { name: 'Your payment needs review' })
    await user.click(within(checkout).getByRole('button', { name: 'Done' }))

    expect(screen.queryByRole('region', { name: 'Checkout' })).toBeNull()
    // Not re-pinned by the next poll of the still-active checkout either.
    await act(() => new Promise((resolve) => setTimeout(resolve, 5_500)))
    expect(screen.queryByRole('region', { name: 'Checkout' })).toBeNull()
  }, 10_000)

  it('keeps the same card form mounted while it re-reads the status after a decline', async () => {
    mockCheckoutWorld({
      current: buildCheckoutRead(),
      status: [buildPaymentRead({ payment_state: 'ready', last_error_code: 'incorrect_cvc' })],
      statusDelayMs: 300,
    })
    stripeDouble.confirmPayment.mockResolvedValue({
      error: { type: 'card_error', code: 'incorrect_cvc', message: 'raw' },
    })
    const user = userEvent.setup()
    renderCheckoutTab()

    const checkout = await panel()
    const cardForm = await within(checkout).findByTestId('stripe-payment-element')
    await user.click(within(checkout).getByRole('button', { name: 'Pay $75.00' }))
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)))

    // Mid-read: the player's card details are still where they typed them,
    // and no guessed decline message flashes before the server's code lands.
    expect(cardForm).toBeInTheDocument()
    expect(within(checkout).queryByText(/couldn’t be charged/)).toBeNull()
    expect(
      await within(checkout).findByText('The security code is incorrect. Check it and try again.'),
    ).toBeInTheDocument()
    expect(within(checkout).getByTestId('stripe-payment-element')).toBe(cardForm)
  })

  it('offers a way back when `?checkout=` names no checkout of yours', async () => {
    mockCheckoutWorld({ checkout: null })
    const user = userEvent.setup()
    const url = renderCheckoutTab({ checkoutParam: CHECKOUT_ID })

    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t find that checkout.')
    await user.click(screen.getByRole('button', { name: 'Back to events' }))

    expect(url.param()).toBeUndefined()
    expect(await eventsTabPage.findSelectButton('Open Singles')).toBeInTheDocument()
  })

  it('warns that a successful charge is refunded when cancelling a payment under check', async () => {
    mockCheckoutWorld({
      current: buildCheckoutRead({ payment_state: 'checking' }),
      checkout: buildCheckoutRead({ payment_state: 'checking' }),
      status: [buildPaymentRead({ payment_state: 'checking' })],
    })
    const user = userEvent.setup()
    renderCheckoutTab({ checkoutParam: CHECKOUT_ID })

    const checkout = await panel()
    await within(checkout).findByRole('heading', { name: 'Checking your payment' })
    expect(within(checkout).queryByRole('button', { name: 'Change selection' })).toBeNull()
    await user.click(within(checkout).getByRole('button', { name: 'Cancel checkout' }))

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'If the charge goes through, we refund it in full.',
    )
  })

  describe('paying', () => {
    /** An active checkout already open, as a resume on this or another device. */
    const openCheckout = (overrides: Parameters<typeof mockCheckoutWorld>[0] = {}) =>
      mockCheckoutWorld({ current: buildCheckoutRead(), ...overrides })

    function signInAs(user: { email: string | null; confirmed_at: string | null }) {
      server.use(
        http.get('*/v1/session', () => HttpResponse.json(sessionResponse({ user }))),
      )
    }

    it('saves the receipt address, then confirms against the server’s PaymentIntent', async () => {
      signInAs({ email: 'rita@example.com', confirmed_at: '2026-01-01T00:00:00Z' })
      const world = openCheckout({
        status: [buildPaymentRead({ payment_state: 'checking' })],
      })
      const user = userEvent.setup()
      const url = renderCheckoutTab()

      const checkout = await panel()
      const receipt = await within(checkout).findByLabelText('Receipt email')
      expect(receipt).toHaveValue('rita@example.com')
      expect(within(checkout).queryByText('Optional')).toBeNull()
      await user.clear(receipt)
      await user.type(receipt, 'club-treasurer@example.com')
      // Hold the confirm in flight, and press Pay again while it is.
      let finishConfirm!: () => void
      stripeDouble.confirmPayment.mockReturnValue(
        new Promise((resolve) => {
          finishConfirm = () => resolve({ paymentIntent: { status: 'processing' } })
        }),
      )
      const pay = within(checkout).getByRole('button', { name: 'Pay $75.00' })
      await user.click(pay)
      await waitFor(() => expect(stripeDouble.confirmPayment).toHaveBeenCalledTimes(1))
      // The card form stays mounted while Stripe confirms: unmounting the
      // Payment Element mid-confirm would break the payment.
      await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
      expect(pay).toBeInTheDocument()
      expect(within(checkout).getByTestId('stripe-payment-element')).toBeInTheDocument()
      expect(pay).toBeDisabled()
      await user.click(pay)
      // A submit that bypasses the disabled button (Enter in the field) is
      // refused too: give it time to reach the save and the confirm, if it could.
      fireEvent.submit(pay.closest('form')!)
      await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
      expect(world.calls.receiptBodies).toHaveLength(1)
      expect(stripeDouble.confirmPayment).toHaveBeenCalledTimes(1)
      finishConfirm()

      expect(
        await within(checkout).findByRole('heading', { name: 'Checking your payment' }),
      ).toBeInTheDocument()
      // One confirm, after the receipt address is saved.
      expect(stripeDouble.confirmPayment).toHaveBeenCalledTimes(1)
      expect(world.calls.log.slice(0, 3)).toEqual(['prepare', 'receipt', 'status'])
      expect(world.calls.receiptBodies).toEqual([
        { receipt_address: 'club-treasurer@example.com' },
      ])
      expect(stripeDouble.confirmPayment.mock.calls[0][0]).toMatchObject({
        redirect: 'if_required',
        confirmParams: {
          return_url: `${window.location.origin}/tournaments/${CHECKOUT_TOURNAMENT_ID}?tab=events&checkout=${CHECKOUT_ID}`,
        },
      })
      // The URL names the checkout before the confirm, so a reload or a 3-D
      // Secure return lands back on it.
      expect(url.param()).toBe(CHECKOUT_ID)
    })

    it('starts the receipt address empty and optional without a confirmed email, and sends none when left empty', async () => {
      signInAs({ email: 'rita@example.com', confirmed_at: null })
      const world = openCheckout({
        status: [buildPaymentRead({ payment_state: 'checking' })],
      })
      const user = userEvent.setup()
      renderCheckoutTab()

      const checkout = await panel()
      expect(await within(checkout).findByLabelText('Receipt email')).toHaveValue('')
      expect(within(checkout).getByText('Optional')).toBeInTheDocument()
      await user.click(within(checkout).getByRole('button', { name: 'Pay $75.00' }))

      await within(checkout).findByRole('heading', { name: 'Checking your payment' })
      expect(world.calls.receiptBodies).toEqual([{ receipt_address: null }])
    })

    it('does not confirm when the receipt address fails to save', async () => {
      const world = openCheckout({
        receipt: { status: 503, body: { detail: 'Unavailable.' } },
      })
      const user = userEvent.setup()
      renderCheckoutTab()

      const checkout = await panel()
      await user.type(await within(checkout).findByLabelText('Receipt email'), 'rita@example.com')
      await user.click(within(checkout).getByRole('button', { name: 'Pay $75.00' }))

      expect(
        await within(checkout).findByText('We couldn’t save your receipt address. Try again.'),
      ).toBeInTheDocument()
      expect(within(checkout).getByLabelText('Receipt email')).toHaveAttribute('aria-invalid', 'true')
      expect(stripeDouble.confirmPayment).not.toHaveBeenCalled()
      expect(world.calls.log).not.toContain('status')
    })

    it.each([
      ['card_declined', 'Your card was declined. Try another card.'],
      ['insufficient_funds', 'Your card was declined. Try another card.'],
      ['expired_card', 'Your card has expired. Try another card.'],
      ['incorrect_cvc', 'The security code is incorrect. Check it and try again.'],
      ['incorrect_number', 'The card number is incorrect. Check it and try again.'],
      ['processing_error', 'We couldn’t process your card. Try again.'],
      ['card_error', 'Your card couldn’t be charged. Try another card.'],
      ['a_code_from_the_future', 'Your card couldn’t be charged. Try another card.'],
    ])('explains a %s decline in its own words and lets the player retry', async (code, message) => {
      openCheckout({
        // An unknown code is still a string on the wire, whatever this build's
        // generated enum says.
        status: [buildPaymentRead({ payment_state: 'ready', last_error_code: code as never })],
      })
      stripeDouble.confirmPayment.mockResolvedValue({
        error: { type: 'card_error', code, message: 'Stripe raw: your card has insufficient funds.' },
      })
      const user = userEvent.setup()
      renderCheckoutTab()

      const checkout = await panel()
      await user.click(await within(checkout).findByRole('button', { name: 'Pay $75.00' }))

      expect(await within(checkout).findByRole('alert')).toHaveTextContent(message)
      expect(checkout).not.toHaveTextContent(/Stripe raw/)
      // The same PaymentIntent takes another try within the hold.
      expect(within(checkout).getByRole('button', { name: 'Pay $75.00' })).toBeEnabled()
      expect(within(checkout).getByTestId('stripe-payment-element')).toBeInTheDocument()
    })
  })

  describe('returning to a checkout by `?checkout=`', () => {
    /** A completed checkout: the "current" read no longer returns it. */
    const completed = () =>
      buildCheckoutRead({ status: 'completed', payment_state: 'succeeded' })

    it('shows each event entered after success, and Done returns to the list', async () => {
      const world = mockCheckoutWorld({
        checkout: completed(),
        status: [buildPaymentRead({ payment_state: 'succeeded', lines: paymentLines('admitted') })],
      })
      const user = userEvent.setup()
      const url = renderCheckoutTab({ checkoutParam: CHECKOUT_ID })

      const checkout = await panel()
      expect(await within(checkout).findByRole('heading', { name: 'You’re entered' })).toBeInTheDocument()
      expect(resultsOf(checkout)).toEqual([
        ['Open Singles', 'Entry confirmed'],
        ['U1500', 'Entry confirmed'],
      ])
      // The return page reads the status only: it never prepares or confirms.
      expect(world.calls.log).toEqual(['status'])
      expect(stripeDouble.confirmPayment).not.toHaveBeenCalled()

      await user.click(within(checkout).getByRole('button', { name: 'Done' }))

      expect(url.param()).toBeUndefined()
      expect(screen.queryByRole('region', { name: 'Checkout' })).not.toBeInTheDocument()
      expect(await eventsTabPage.findSelectButton('Open Singles')).toBeInTheDocument()
    })

    it('shows a mixed outcome per event, with no overall success message', async () => {
      mockCheckoutWorld({
        checkout: completed(),
        status: [
          buildPaymentRead({
            payment_state: 'succeeded',
            lines: [
              { ...paymentLines('admitted')[0] },
              { ...paymentLines('refund_pending')[1] },
            ],
          }),
        ],
      })
      renderCheckoutTab({ checkoutParam: CHECKOUT_ID })

      const checkout = await panel()
      await within(checkout).findByRole('button', { name: 'Done' })
      expect(resultsOf(checkout)).toEqual([
        ['Open Singles', 'Entry confirmed'],
        ['U1500', 'Not admitted — refund pending'],
      ])
      expect(within(checkout).queryByRole('heading', { name: 'You’re entered' })).toBeNull()
      expect(
        within(checkout).getByRole('heading', { name: 'Some entries weren’t admitted' }),
      ).toBeInTheDocument()
    })

    it('shows a payment under review neutrally, with its support reference', async () => {
      mockCheckoutWorld({
        checkout: completed(),
        status: [
          buildPaymentRead({
            payment_state: 'needs_review',
            reference: 'PAY-7K3M9QX2',
            lines: paymentLines('refund_pending'),
          }),
        ],
      })
      renderCheckoutTab({ checkoutParam: CHECKOUT_ID })

      const checkout = await panel()
      expect(
        await within(checkout).findByRole('heading', { name: 'Your payment needs review' }),
      ).toBeInTheDocument()
      expect(checkout).toHaveTextContent('Support reference PAY-7K3M9QX2')
      expect(within(checkout).getByRole('button', { name: 'Done' })).toBeInTheDocument()
    })

    it('keeps checking a payment after its hold has ended, with no way to pay again', async () => {
      mockCheckoutWorld({
        checkout: buildCheckoutRead({ status: 'expired', payment_state: 'checking' }),
        status: [buildPaymentRead({ payment_state: 'checking' })],
      })
      renderCheckoutTab({ checkoutParam: CHECKOUT_ID })

      const checkout = await panel()
      expect(
        await within(checkout).findByRole('heading', { name: 'Checking your payment' }),
      ).toBeInTheDocument()
      expect(checkout).toHaveTextContent('You can leave this page and come back.')
      expect(within(checkout).queryByRole('button', { name: /^Pay / })).toBeNull()
      expect(within(checkout).queryByRole('heading', { name: 'Your hold ended' })).toBeNull()
      expect(within(checkout).queryByText(/entered/i)).toBeNull()
      // The server still cancels a checkout whose payment is open, so the
      // player keeps that choice after the deadline.
      expect(within(checkout).getByRole('button', { name: 'Cancel checkout' })).toBeInTheDocument()
    })

    it('cancels an ended checkout’s open payment before reviewing availability', async () => {
      const world = mockCheckoutWorld({
        checkout: buildCheckoutRead({ status: 'expired', payment_state: 'expired' }),
        status: [buildPaymentRead({ payment_state: 'expired' })],
      })
      const user = userEvent.setup()
      const url = renderCheckoutTab({ checkoutParam: CHECKOUT_ID })

      const checkout = await panel()
      await within(checkout).findByRole('heading', { name: 'Your hold ended' })
      await user.click(within(checkout).getByRole('button', { name: 'Review availability' }))

      await waitFor(() => expect(world.calls.log).toContain('cancel'))
      await waitFor(() => expect(url.param()).toBeUndefined())
      expect(screen.getByRole('button', { name: 'Check out · $75.00' })).toBeInTheDocument()
    })

    it('keeps an ended checkout on screen when its cancel fails, and says so', async () => {
      const world = mockCheckoutWorld({
        checkout: buildCheckoutRead({ status: 'expired', payment_state: 'expired' }),
        status: [buildPaymentRead({ payment_state: 'expired' })],
        cancelRefusal: { status: 503, body: { detail: 'Unavailable.' } },
      })
      const user = userEvent.setup()
      const url = renderCheckoutTab({ checkoutParam: CHECKOUT_ID })

      const checkout = await panel()
      await within(checkout).findByRole('heading', { name: 'Your hold ended' })
      await user.click(within(checkout).getByRole('button', { name: 'Review availability' }))

      await waitFor(() => expect(world.calls.log).toContain('cancel'))
      expect(
        await within(checkout).findByText(
          'We couldn’t release this checkout’s payment. Try again in a moment.',
        ),
      ).toBeInTheDocument()
      // The old payment may still be confirmable, so no replacement starts yet.
      expect(url.param()).toBe(CHECKOUT_ID)
      expect(screen.queryByRole('button', { name: /^Check out/ })).toBeNull()
    })

    it('shows the result when another device completes the payment', async () => {
      const world = mockCheckoutWorld({
        current: buildCheckoutRead(),
        status: [buildPaymentRead({ payment_state: 'succeeded', lines: paymentLines('admitted') })],
      })
      renderCheckoutTab()

      const checkout = await panel()
      await within(checkout).findByTestId('stripe-payment-element')
      // Another device pays: the hold is consumed and "current" stops finding it.
      world.current = null
      world.checkout = buildCheckoutRead({ status: 'completed', payment_state: 'succeeded' })

      expect(
        await within(checkout).findByRole('heading', { name: 'You’re entered' }, { timeout: 7_000 }),
      ).toBeInTheDocument()
      expect(within(checkout).queryByRole('heading', { name: 'Your checkout ended' })).toBeNull()
    }, 10_000)
  })
})

/** Each result row as [event, result]. */
function resultsOf(checkout: HTMLElement) {
  return within(within(checkout).getByRole('list', { name: 'Results' }))
    .getAllByRole('listitem')
    .map((row) => [
      row.querySelector('[data-part="event"]')?.textContent,
      row.querySelector('[data-part="result"]')?.textContent,
    ])
}
