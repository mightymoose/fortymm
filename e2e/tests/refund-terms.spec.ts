import { expect, test } from '@playwright/test'

/**
 * `/refund-terms` (#1760, linked from the checkout panel's #1809 "Refund
 * terms" anchor) — the ONE checkout-adjacent surface a signed-out visitor
 * reaches. It sits outside the `_app` layout on purpose (`src/routes/
 * refund-terms.tsx`'s own comment: "a signed-out reader never mints a guest
 * session"), so this spec's whole point is a **fresh, cookie-less** context
 * proving that holds — no `session` cookie should appear from merely reading
 * this page.
 */
test.describe('refund terms (#1760)', () => {
  test('renders for a signed-out visitor with its five policy lines', async ({
    page,
    context,
  }) => {
    await page.goto('/refund-terms')

    await expect(
      page.getByRole('heading', { level: 1, name: 'Refund terms' }),
    ).toBeVisible()

    const policyList = page.getByRole('list')
    await expect(policyList.getByRole('listitem')).toHaveText([
      'Refunds are full refunds only, per event.',
      'If you withdraw before registration closes, your refund is automatic. After registration closes, the organizer approves the refund.',
      'If an event is cancelled, every paid entry in it is refunded.',
      'You never pay card fees.',
      'A combined payment is refunded one event at a time.',
    ])

    // The page never called `GET /v1/session` — a signed-out reader mints no
    // guest identity just by reading the policy.
    const cookies = await context.cookies()
    expect(cookies.find((cookie) => cookie.name === 'session')).toBeUndefined()
  })
})
