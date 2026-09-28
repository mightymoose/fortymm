/**
 * Paid tournament checkout (#1809), through the real composed stack.
 *
 * This suite has no real Stripe keys (`STRIPE_SECRET_KEY` is unset in
 * `docker-compose.e2e.yml`), so a card payment itself cannot be driven here —
 * the ticket's Testing stage covers that against Stripe test mode. What the
 * real stack CAN prove, and what this file covers:
 *
 * 1. A signed-in player with no open checkouts sees none — `GET
 *    /v1/me/checkouts/open` answers `[]` and the app-wide bar renders nothing.
 * 2. The whole reachable-without-Stripe slice of the paid flow: selecting a
 *    paid event, starting a checkout, the panel's "couldn't start your
 *    payment" alert (the server 409s `POST …/payment` before it ever asks
 *    Stripe anything — `prepare_or_resume_payment`'s `card_payments_
 *    configured` gate), the app-wide open-checkout bar appearing on another
 *    page with a live countdown, its absence on the tournament's OWN Events
 *    tab, and cancelling the hold making the bar disappear on an already-open
 *    tab with no reload — the `checkout.changed` realtime hint doing its job.
 *
 * Scenario 2 needs no special setup and always runs. Scenario 3 needs a
 * tournament whose OWNER's Account id equals the api's configured
 * `TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID` — a fact that can only be arranged
 * once, before any test starts (`global-setup.ts` + `support/merchant-
 * checkout.ts`), because Account ids are minted server-side and there is no
 * id to pre-bake before the stack has ever booted. It is skipped outright
 * under `E2E_BASE_URL` (a stack this suite does not manage, and did not run
 * that provisioning against).
 */
import { existsSync } from 'node:fs'

import { expect, request, test } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { guestFromContext } from '../support/match-api'
import { MERCHANT_STORAGE_STATE_PATH } from '../support/merchant-checkout'
import { seedTournament, transitionTournament } from '../support/tournament-api'
import { DashboardPage } from '../page-objects/dashboard.page'
import { TournamentDetailPage } from '../page-objects/tournament-detail.page'

test.describe('open-checkout bar (#1809)', () => {
  test('a signed-in player with no open checkouts sees none', async ({ page }) => {
    // Any signed-in page mints the guest; the dashboard is as good as any and
    // is also where the bar would render if it had anything to show.
    const dashboard = await DashboardPage.navigateTo(page)
    await expect(dashboard.userMenu.skeleton).not.toBeVisible()

    // `guestFromContext` does its OWN `GET /v1/session` and only returns once
    // it resolves — the suite's established way to get a SETTLED session
    // before issuing a further authenticated call on `page.request`'s cookie
    // jar. Skipping this and calling `page.request.get(...)` directly right
    // after the skeleton clears races the app's OWN in-flight session mint
    // (`useSession()`'s effect fires on mount, independent of when the
    // skeleton's re-render happens to land) — that raced exactly once, 401ing
    // with `session_ended`, under this suite's full 12-worker parallel run.
    const player = await guestFromContext(page.request)

    const open = await player.ctx.get('/api/v1/me/checkouts/open')
    expect(open.ok(), `GET /v1/me/checkouts/open: ${open.status()} ${await open.text()}`).toBe(true)
    expect(await open.json()).toEqual([])

    await expect(dashboard.openCheckoutBar).not.toBeVisible()
  })
})

test.describe('paid checkout (#1809)', () => {
  test.skip(
    !existsSync(MERCHANT_STORAGE_STATE_PATH),
    'no merchant account was provisioned for this run (E2E_BASE_URL points at a ' +
      "stack this suite didn't set up — see global-setup.ts)",
  )

  test('select, check out, see the payment-unavailable alert, the open-checkout bar, and cancel via the realtime hint', async ({
    page,
    context,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The DIRECTOR is the one Account the recreated stack pins as the paid-
    // checkout merchant — loaded from the session `global-setup.ts` persisted,
    // never minted fresh (a fresh guest's Account id would not match).
    const merchantCtx = await request.newContext({
      baseURL: baseURL!,
      storageState: MERCHANT_STORAGE_STATE_PATH,
    })
    const director = await guestFromContext(merchantCtx)

    const name = `Paid Checkout ${faker.string.uuid()}`
    const seeded = await seedTournament(director, name, { entryFee: 20 })
    await transitionTournament(director, seeded.tournamentId, 'published')

    // The PLAYER is a fresh, ordinary guest — the browser's own session,
    // distinct from the director/merchant above.
    const tournament = await TournamentDetailPage.navigateTo(page, seeded.tournamentId)
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()

    await tournament.selectPaidEventButton('Open Singles').click()
    await expect(tournament.selectedPaidEventButton('Open Singles')).toBeVisible()

    await tournament.checkoutButton('$20.00').click()

    // The panel replaces the list: the summary shows the one line and total,
    // and the payment side lands on the "couldn't start" alert — this stack's
    // Stripe keys are unset, so the server refuses the payment prepare call
    // with a 409 before any Stripe call is made.
    await expect(tournament.checkoutSection).toBeVisible()
    await expect(tournament.checkoutSection.getByText('Open Singles')).toBeVisible()
    await expect(tournament.paymentUnavailableAlert).toHaveText(
      /We couldn.t start your payment\. Your places are still held\./,
    )

    // Absent on the tournament's own Events tab — its own panel already shows
    // this exact hold.
    await expect(page.getByRole('region', { name: 'Open checkouts' })).toHaveCount(0)

    // A second tab, same signed-in player (shared browser context — same
    // `session` cookie): the app-wide bar shows the hold with a live
    // countdown and a way back in.
    const dashboardPage = await context.newPage()
    const dashboard = await DashboardPage.navigateTo(dashboardPage)
    await expect(dashboard.openCheckoutBar).toBeVisible()
    await expect(dashboard.openCheckoutSummary).toHaveText(
      new RegExp(`Checkout open · ${name} · \\d{2}:\\d{2} left`),
    )
    await expect(dashboard.resumeCheckoutLink).toHaveText('Resume')

    // Cancel from the ORIGINAL tab, where the checkout panel is already open —
    // never reload `dashboardPage`. If the bar clears there, nothing but the
    // `checkout.changed` realtime hint (or the bar's own poll-free query
    // invalidation it drives) could have told it to.
    await tournament.cancelCheckout()
    await expect(tournament.checkoutSection).not.toBeVisible()

    await expect(dashboard.openCheckoutBar).not.toBeVisible()

    await dashboardPage.close()
    await merchantCtx.dispose()
  })
})
