import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { SessionRecoveryPage } from '../page-objects/session-recovery.page'
import { csrfHeaders, receivedLink, requestLoginLink } from '../support/session-mail'

const mailpit = process.env.E2E_MAILPIT_URL
// The standard composed stack has no mailbox. Run these against a QA stack.
test.skip(!mailpit, 'Requires E2E_MAILPIT_URL pointing to an isolated QA Mailpit')

for (const trigger of ['sign-in', 'email-change'] as const) {
  test(`${trigger} elsewhere signs out every old tab without creating a guest`, async ({ browser, context, page, baseURL }) => {
    const email = `session-${randomUUID()}@example.com`
    await page.goto(await requestLoginLink(context, mailpit!, email))
    await expect(page).toHaveURL(/\/dashboard$/)
    const original = (await (await context.request.get('/api/v1/session')).json()).data.user
    const secondTab = await context.newPage()
    await secondTab.goto('/dashboard')
    const other = await browser.newContext({ baseURL })
    try {
      let link: string
      if (trigger === 'sign-in') {
        link = await requestLoginLink(other, mailpit!, email)
      } else {
        const nextEmail = `changed-${randomUUID()}@example.com`
        const change = await context.request.post('/api/v1/me/email', {
          headers: await csrfHeaders(context),
          data: { email: nextEmail, captcha_token: 'test-token', fmm_hp_token: '' },
        })
        expect(change.status(), await change.text()).toBe(202)
        link = await receivedLink(context.request, mailpit!, nextEmail)
      }
      const acceptingPage = await other.newPage()
      await acceptingPage.goto(link)
      if (trigger === 'email-change') await new SessionRecoveryPage(acceptingPage).dashboardLink.click()
      await expect(acceptingPage).toHaveURL(/\/dashboard$/)
      expect((await (await other.request.get('/api/v1/session')).json()).data.user.id).toBe(original.id)

      await page.reload()
      for (const tab of [page, secondTab]) {
        await expect(tab).toHaveURL(/\/login(?:\?.*)?$/)
        await expect(new SessionRecoveryPage(tab).signedOutNotice).toBeVisible()
        await tab.reload()
        await tab.goto('/dashboard')
        await expect(tab).toHaveURL(/\/login(?:\?.*)?$/)
      }
      await new SessionRecoveryPage(page).newGuest.click()
      await expect(page).toHaveURL(/\/dashboard$/)
      const guest = (await (await context.request.get('/api/v1/session')).json()).data.user
      expect(guest.id).not.toBe(original.id)
      expect(guest.email).toBeNull()
    } finally { await other.close() }
  })
}

test('another claimed account’s confirmation link waits for approval and cancel leaves it live', async ({ browser, context, page, baseURL }) => {
  const aliceEmail = `alice-${randomUUID()}@example.com`
  await page.goto(await requestLoginLink(context, mailpit!, aliceEmail))
  await expect(page).toHaveURL(/\/dashboard$/)
  const alice = (await (await context.request.get('/api/v1/session')).json()).data.user
  const bobContext = await browser.newContext({ baseURL })
  try {
    const bobPage = await bobContext.newPage()
    await bobPage.goto(await requestLoginLink(bobContext, mailpit!, `bob-${randomUUID()}@example.com`))
    await expect(bobPage).toHaveURL(/\/dashboard$/)
    const bob = (await (await bobContext.request.get('/api/v1/session')).json()).data.user
    const changedEmail = `bob-new-${randomUUID()}@example.com`
    const change = await bobContext.request.post('/api/v1/me/email', {
      headers: await csrfHeaders(bobContext),
      data: { email: changedEmail, captcha_token: 'test-token', fmm_hp_token: '' },
    })
    expect(change.status()).toBe(202)
    const link = await receivedLink(bobContext.request, mailpit!, changedEmail)
    const recovery = new SessionRecoveryPage(page)
    await page.goto(link)
    await expect(recovery.switchHeading(bob.username)).toBeVisible()
    await recovery.cancelSwitch.click()
    await expect(page).toHaveURL(/\/dashboard$/)
    expect((await (await context.request.get('/api/v1/session')).json()).data.user.id).toBe(alice.id)
    await page.goto(link)
    await recovery.continueAs(bob.username).click()
    await recovery.dashboardLink.click()
    await expect(page).toHaveURL(/\/dashboard$/)
    expect((await (await context.request.get('/api/v1/session')).json()).data.user.id).toBe(bob.id)
  } finally { await bobContext.close() }
})
