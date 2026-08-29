/**
 * A guest with NO permissions can view and enter a published tournament (#1092).
 *
 * Driven through the REAL composed stack — nginx on :18080 → api → postgres —
 * as a fresh browser context: no session cookie, no seeded identity, no RBAC
 * grant. Loading `/_app/*` mints a guest via `GET /v1/session` (ADR-0016), and
 * from this change on that default `User` role is enough: the list loads, the
 * published tournament opens, and the guest self-registers into its singles
 * event through the UI.
 *
 * The event carries **no rating predicate** (`seedTournament`'s default), so a
 * guest with no rating is never refused for a reason unrelated to permissions —
 * the failure this spec exists to catch cannot hide behind a `rating_ineligible`
 * 409.
 */
import { expect, test } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { mintGuest } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import { seedTournament, transitionTournament } from '../support/tournament-api'

test.describe('guest tournament access (#1092)', () => {
  test('a fresh guest lists, opens, and enters a published tournament', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The DIRECTOR needs `tournament.create` (Beta tester) to seed; the BROWSER
    // guest deliberately gets NO grant — a minted guest holds only the default
    // `User` role, and that is the whole point of this spec.
    const director = await mintGuest(baseURL!)
    grantBetaTester(director.username)

    const name = `Guest Entry ${faker.string.uuid()}`
    const seeded = await seedTournament(director, name)
    await transitionTournament(director, seeded.tournamentId, 'published')

    // A brand-new browser context: no `session` cookie. Loading the tournaments
    // route mints the guest (app-shell calls `useSession`), then the list —
    // ungated now — must render the published tournament.
    await page.goto('/tournaments')
    const card = page.getByRole('button', { name: new RegExp(name) })
    await expect(card).toBeVisible()

    // Open the tournament's detail page.
    await card.click()
    await expect(
      page.getByRole('heading', { name: new RegExp(name), level: 1 }),
    ).toBeVisible()

    // Enter the singles event — self-registration, no permission asked.
    const enter = page.getByRole('button', { name: 'Enter Open Singles' })
    await expect(enter).toBeVisible()
    await enter.click()

    // The control flips to Withdraw once the guest holds an entry — and the
    // roster names them.
    await expect(
      page.getByRole('button', { name: 'Withdraw from Open Singles' }),
    ).toBeVisible()
  })
})
