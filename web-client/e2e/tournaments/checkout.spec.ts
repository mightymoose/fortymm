/**
 * The web checkout screen (#1809), through a real browser (ADR-0016).
 *
 * This suite runs with MSW **off**: the API is stubbed with a stateful
 * `page.route` store (`CheckoutStore`) and Stripe.js — a THIRD PARTY the app
 * loads directly — is stubbed separately (`../support/stripe`). What only a
 * browser can prove here:
 *
 *   1. The **layout** claim: the panel is a real CSS grid that goes one
 *      column on a phone (jsdom performs no layout at all).
 *   2. The **Stripe.js integration** itself: `@stripe/react-stripe-js` really
 *      does mount a Payment Element and call `stripe.confirmPayment` with the
 *      body the panel built — vitest replaces the whole package with a test
 *      double (`src/test/stripe-double.tsx`) and so never exercises the real
 *      `<Elements>`/`<PaymentElement>` wiring at all.
 *   3. The **3-D Secure return**: a real navigation carrying Stripe's own
 *      query params, and the real router history the cleanup has to leave
 *      unchanged.
 *   4. **Exactly one confirm on a rapid double click** — a real double click,
 *      not a synthetic `fireEvent.submit` bypassing a `disabled` attribute.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'

import {
  buildCheckoutRead,
  buildPaymentRead,
  paymentLines,
} from '../../src/mocks/factories/checkouts/checkout.factory'
import {
  buildTournamentEventRead,
  UNBREAKABLE_TOURNAMENT_NAME,
} from '../../src/mocks/factories/tournaments/tournament.factory'
import {
  CHECKOUT_ID,
  CheckoutStore,
  EVENT,
  OPEN_SINGLES_ID,
  TOURNAMENT_ID,
  U1500_ID,
} from '../page-objects/tournaments/checkout-store'
import {
  installStripeDouble,
  stripeConfirmCallCount,
  stripeConfirmCalls,
} from '../support/stripe'
import { expectNoHorizontalScroll } from '../support/viewport'

const EVENTS_URL = `/tournaments/${TOURNAMENT_ID}?tab=events`

const selectButton = (page: Page, eventName: string) =>
  page.getByRole('button', { name: `Select ${eventName}` })

const checkoutPanel = (page: Page) => page.getByRole('region', { name: 'Checkout' })

const payButton = (page: Page) =>
  checkoutPanel(page).getByRole('button', { name: /^Pay \$/ })

/** Select both paid events and start the checkout — the entry to every
 * scenario below that needs an open panel. */
async function startCheckout(page: Page) {
  await selectButton(page, EVENT.OPEN_SINGLES).click()
  await selectButton(page, EVENT.U1500).click()
  await page.getByRole('button', { name: 'Check out · $75.00' }).click()
  await expect(checkoutPanel(page)).toBeVisible()
}

/** Press Tab, from wherever focus currently sits, until `target` is the
 * focused element or the budget runs out. */
async function tabUntilFocused(page: Page, target: Locator, maxPresses = 40) {
  for (let i = 0; i < maxPresses; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  throw new Error('Tab never reached the target element')
}

test.describe('Checkout · happy path', () => {
  test('selecting two paid events, paying once, and landing on a confirmed result', async ({
    page,
  }) => {
    const store = new CheckoutStore({
      user: { email: 'rita@example.com', confirmed_at: '2026-01-01T00:00:00Z' },
    })
    store.setStatusQueue([
      buildPaymentRead({ payment_state: 'checking' }),
      buildPaymentRead({ payment_state: 'succeeded', lines: paymentLines('admitted') }),
    ])
    await installStripeDouble(page, {
      confirmResult: { paymentIntent: { status: 'succeeded' } },
    })
    await store.install(page)
    await page.goto(EVENTS_URL)

    await startCheckout(page)
    const panel = checkoutPanel(page)

    // The card form appears in the SAME step — no separate "start payment"
    // click.
    await expect(panel.getByTestId('stripe-payment-element')).toBeVisible()
    // A confirmed account's email prefills the receipt field.
    await expect(panel.getByLabel('Receipt email')).toHaveValue('rita@example.com')

    const pay = payButton(page)
    await expect(pay).toHaveText('Pay $75.00')

    // A rapid double click must confirm exactly once.
    await pay.dblclick()
    await expect.poll(() => stripeConfirmCallCount(page)).toBe(1)

    const calls = await stripeConfirmCalls(page)
    expect(calls[0]?.confirmParams?.return_url).toBe(
      `${new URL(page.url()).origin}/tournaments/${TOURNAMENT_ID}?tab=events&checkout=${CHECKOUT_ID}`,
    )

    await expect(panel.getByRole('heading', { name: 'Checking your payment' })).toBeVisible()

    // The status-read stub's SECOND reply — served on the next 5s poll —
    // resolves the payment.
    await expect(panel.getByRole('heading', { name: 'You’re entered' })).toBeVisible({
      timeout: 8_000,
    })
    const results = panel.getByRole('list', { name: 'Results' })
    await expect(results.getByRole('listitem')).toHaveCount(2)
    await expect(results).toContainText('Entry confirmed')
    expect(await results.getByText('Entry confirmed').count()).toBe(2)

    // Never more than one confirm, even after the poll settled.
    expect(await stripeConfirmCallCount(page)).toBe(1)

    // In production a `checkout.changed` realtime push discovers a settled
    // checkout near-instantly; this suite's stream is permanently parked
    // (`../support/realtime`), so the discovery here is the client's own 5s
    // poll of `GET …/checkouts/current`. Wait for a FRESH read of it — one
    // that lands after the payment settled and so reads the checkout as gone
    // — before pressing Done, or Done's own "un-pin" can be immediately
    // reverted by a render that still sees the stale, still-`active` cache.
    const readsBeforeDone = store.currentReadCount
    await expect
      .poll(() => store.currentReadCount, { timeout: 8_000 })
      .toBeGreaterThan(readsBeforeDone)

    await panel.getByRole('button', { name: 'Done' }).click()

    expect(page.url()).not.toContain('checkout=')
    await expect(checkoutPanel(page)).toHaveCount(0)
    await expect(selectButton(page, EVENT.OPEN_SINGLES)).toBeVisible()

    expect(store.createdEventIds).toEqual([[OPEN_SINGLES_ID, U1500_ID]])
    expect(store.log).toEqual(['create', 'prepare', 'receipt', 'status', 'status'])
    expect(store.unhandled).toEqual([])
  })

  test('an unconfirmed account starts the receipt field empty and optional', async ({
    page,
  }) => {
    const store = new CheckoutStore()
    store.setStatusQueue([buildPaymentRead({ payment_state: 'checking' })])
    await installStripeDouble(page)
    await store.install(page)
    await page.goto(EVENTS_URL)

    await startCheckout(page)
    const panel = checkoutPanel(page)

    await expect(panel.getByLabel('Receipt email')).toHaveValue('')
    await expect(panel.getByText('Optional')).toBeVisible()
  })
})

test.describe('Checkout · a declined card', () => {
  test('shows the safe decline message, never Stripe’s raw text, and re-enables Pay', async ({
    page,
  }) => {
    const store = new CheckoutStore()
    store.setStatusQueue([
      buildPaymentRead({ payment_state: 'ready', last_error_code: 'expired_card' }),
    ])
    await installStripeDouble(page, {
      confirmResult: {
        error: {
          type: 'card_error',
          code: 'expired_card',
          message: 'Stripe raw: your card has insufficient funds and has expired.',
        },
      },
    })
    await store.install(page)
    await page.goto(EVENTS_URL)

    await startCheckout(page)
    const panel = checkoutPanel(page)
    await payButton(page).click()

    const alert = panel.getByRole('alert')
    await expect(alert).toHaveText('Your card has expired. Try another card.')
    await expect(panel).not.toContainText('Stripe raw')
    await expect(payButton(page)).toBeEnabled()
    await expect(panel.getByTestId('stripe-payment-element')).toBeVisible()
  })
})

test.describe('Checkout · a 3-D Secure return', () => {
  test('strips Stripe’s params, never grows history, makes no prepare call, and shows the status read', async ({
    page,
  }) => {
    const store = new CheckoutStore()
    store.seedCheckout(
      buildCheckoutRead({ status: 'completed', payment_state: 'succeeded' }),
    )
    store.setStatusQueue([
      buildPaymentRead({ payment_state: 'succeeded', lines: paymentLines('admitted') }),
    ])
    await page.addInitScript(() => {
      // The count as the browser sees it the instant this document's scripts
      // start — BEFORE the app's own cleanup effect can touch it.
      ;(window as unknown as { __historyLengthAtLoad?: number }).__historyLengthAtLoad =
        history.length
    })
    await store.install(page)

    const returnUrl =
      `${EVENTS_URL}&checkout=${CHECKOUT_ID}` +
      '&payment_intent=pi_x&payment_intent_client_secret=pi_x_secret_y&redirect_status=succeeded'
    await page.goto(returnUrl)

    const panel = checkoutPanel(page)
    await expect(panel.getByRole('heading', { name: 'You’re entered' })).toBeVisible()

    const url = page.url()
    expect(url).not.toContain('payment_intent')
    expect(url).not.toContain('redirect_status')

    const grew = await page.evaluate(
      () =>
        history.length >
        (window as unknown as { __historyLengthAtLoad?: number }).__historyLengthAtLoad!,
    )
    expect(grew).toBe(false)

    // The return page reads the status only: it never prepares or confirms.
    expect(store.log).not.toContain('prepare')
    expect(store.log).toContain('status')
  })
})

test.describe('Checkout · layout', () => {
  test('desktop shows the summary and payment side by side', async ({ page }) => {
    const store = new CheckoutStore()
    await installStripeDouble(page)
    await store.install(page)
    await page.goto(EVENTS_URL)
    await startCheckout(page)
    const panel = checkoutPanel(page)

    const entries = panel.getByRole('heading', { name: 'Your entries' })
    const payment = panel.getByRole('heading', { name: 'Payment' })
    const entriesBox = await entries.boundingBox()
    const paymentBox = await payment.boundingBox()
    expect(entriesBox).not.toBeNull()
    expect(paymentBox).not.toBeNull()
    // Side by side: payment starts well to the right of where entries does,
    // on (roughly) the same row.
    expect(paymentBox!.x).toBeGreaterThan(entriesBox!.x + entriesBox!.width - 10)
    expect(Math.abs(paymentBox!.y - entriesBox!.y)).toBeLessThan(10)
  })

  test.describe('phone', () => {
    test.use({ viewport: { width: 375, height: 667 } })

    test('one column, no horizontal page scroll', async ({ page }) => {
      const store = new CheckoutStore()
      await installStripeDouble(page)
      await store.install(page)
      await page.goto(EVENTS_URL)
      await startCheckout(page)
      const panel = checkoutPanel(page)

      const entries = panel.getByRole('heading', { name: 'Your entries' })
      const payment = panel.getByRole('heading', { name: 'Payment' })
      const entriesBox = await entries.boundingBox()
      const paymentBox = await payment.boundingBox()
      expect(entriesBox).not.toBeNull()
      expect(paymentBox).not.toBeNull()
      // Stacked: payment sits below entries, at (roughly) the same left edge.
      expect(paymentBox!.y).toBeGreaterThanOrEqual(entriesBox!.y + entriesBox!.height)
      expect(Math.abs(paymentBox!.x - entriesBox!.x)).toBeLessThan(5)

      await expectNoHorizontalScroll(page.locator('html'), 'the document')
    })

    test('a long event name wraps instead of overflowing', async ({ page }) => {
      const store = new CheckoutStore({
        tournament: {
          events: [
            buildTournamentEventRead({
              id: OPEN_SINGLES_ID,
              name: UNBREAKABLE_TOURNAMENT_NAME,
              entry_fee: 45,
              max_players: 64,
              reservations: [],
              groups: [],
            }),
          ],
        },
      })
      await installStripeDouble(page)
      await store.install(page)
      await page.goto(EVENTS_URL)

      await selectButton(page, UNBREAKABLE_TOURNAMENT_NAME).click()
      await page.getByRole('button', { name: 'Check out · $45.00' }).click()
      const panel = checkoutPanel(page)
      await expect(panel).toContainText(UNBREAKABLE_TOURNAMENT_NAME)

      await expectNoHorizontalScroll(page.locator('html'), 'the document')
    })
  })
})

test.describe('Checkout · keyboard', () => {
  test('Pay and Cancel checkout are reachable by Tab', async ({ page }) => {
    const store = new CheckoutStore()
    await installStripeDouble(page)
    await store.install(page)
    await page.goto(EVENTS_URL)
    await startCheckout(page)
    const panel = checkoutPanel(page)
    await expect(panel.getByTestId('stripe-payment-element')).toBeVisible()

    const pay = payButton(page)
    await tabUntilFocused(page, pay)
    await expect(pay).toBeFocused()

    const cancel = panel.getByRole('button', { name: 'Cancel checkout' })
    await tabUntilFocused(page, cancel)
    await expect(cancel).toBeFocused()
  })

  // Every `<Button>` sets `outline-0`, so its focus ring is the only thing a
  // keyboard user sees (#1809 requires visible focus on the panel).
  test(
    'the Pay button shows a visible focus indicator when reached by Tab',
    async ({ page }) => {
      const store = new CheckoutStore()
      await installStripeDouble(page)
      await store.install(page)
      await page.goto(EVENTS_URL)
      await startCheckout(page)
      const pay = payButton(page)
      await expect(checkoutPanel(page).getByTestId('stripe-payment-element')).toBeVisible()

      await tabUntilFocused(page, pay)
      await expect(pay).toBeFocused()

      const hasVisibleFocus = await pay.evaluate((el) => {
        const cs = getComputedStyle(el)
        const outline = parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none'
        const ring = cs.boxShadow !== 'none'
        return outline || ring
      })
      expect(hasVisibleFocus).toBe(true)
    },
  )
})

test.describe('Refund terms', () => {
  test('renders the policy, signed out, with no session stub of its own', async ({
    page,
  }) => {
    await page.goto('/refund-terms')

    await expect(page.getByRole('heading', { name: 'Refund terms', level: 1 })).toBeVisible()
    const items = page.getByRole('listitem')
    await expect(items).toHaveCount(5)
    await expect(items).toContainText([
      'Refunds are full refunds only, per event.',
      'If you withdraw before registration closes, your refund is automatic. After registration closes, the organizer approves the refund.',
      'If an event is cancelled, every paid entry in it is refunded.',
      'You never pay card fees.',
      'A combined payment is refunded one event at a time.',
    ])
  })
})
