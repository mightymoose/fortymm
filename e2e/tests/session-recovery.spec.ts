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
  const sameBrowserTab = await context.newPage()
  await sameBrowserTab.goto('/dashboard')
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
    await expect(new SessionRecoveryPage(sameBrowserTab).userMenu).toContainText(bob.username)
  } finally { await bobContext.close() }
})


test('a timed-out recovery tab follows its peer to the recovered dashboard', async ({ context, page }) => {
  await context.addInitScript(() => { Object.defineProperty(navigator, 'locks', { value: undefined }) })
  await page.goto('/dashboard')
  const second = await context.newPage()
  await second.goto('/dashboard')
  const firstRecovery = new SessionRecoveryPage(page)
  await firstRecovery.userMenu.click()
  await firstRecovery.logout.click()
  await expect(second).toHaveURL(/\/login(?:\?.*)?$/)
  await page.goto('/login')
  await second.reload()
  await expect(firstRecovery.newGuest).toBeVisible()
  await expect(new SessionRecoveryPage(second).newGuest).toBeVisible()

  let release!: () => void
  let started!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const startedRequest = new Promise<void>((resolve) => { started = resolve })
  await context.route('**/api/v1/session', async (route) => {
    if (route.request().method() === 'GET') {
      started()
      await held
    }
    await route.continue()
  })
  try {
    await firstRecovery.newGuest.click()
    await startedRequest
    await new SessionRecoveryPage(second).newGuest.click()
    await expect(second.getByText("We couldn't start a new guest. Please try again.")).toBeVisible({ timeout: 15_000 })
  } finally {
    release()
  }
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(second).toHaveURL(/\/dashboard$/)
  const user = (await (await context.request.get('/api/v1/session')).json()).data.user
  await expect(firstRecovery.userMenu).toContainText(user.username)
  await expect(new SessionRecoveryPage(second).userMenu).toContainText(user.username)
})

for (const kind of ['sign-in', 'confirmation'] as const) {
  test(`completes ${kind} after a failed logout without leaving the link route`, async ({ context, page }) => {
    const email = `retry-${randomUUID()}@example.com`
    await page.goto(await requestLoginLink(context, mailpit!, email))
    await expect(page).toHaveURL(/\/dashboard$/)
    const original = (await (await context.request.get('/api/v1/session')).json()).data.user
    let link: string
    if (kind === 'sign-in') {
      link = await requestLoginLink(context, mailpit!, email)
    } else {
      const nextEmail = `retry-next-${randomUUID()}@example.com`
      const change = await context.request.post('/api/v1/me/email', {
        headers: await csrfHeaders(context),
        data: { email: nextEmail, captcha_token: 'test-token', fmm_hp_token: '' },
      })
      expect(change.status()).toBe(202)
      link = await receivedLink(context.request, mailpit!, nextEmail)
    }
    let failed = false
    await page.route('**/api/v1/session', async (route) => {
      if (route.request().method() === 'DELETE' && !failed) {
        failed = true
        await route.fulfill({ status: 503, body: '' })
      } else { await route.continue() }
    })
    const recovery = new SessionRecoveryPage(page)
    await recovery.userMenu.click()
    const failedLogout = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.status() === 503)
    await recovery.logout.click()
    await failedLogout
    await expect(page.getByRole('button', { name: 'Retry sign-out' })).toBeVisible()
    await page.goto(link)
    if (kind === 'confirmation') await recovery.dashboardLink.click()
    await expect(page).toHaveURL(/\/dashboard$/)
    expect((await (await context.request.get('/api/v1/session')).json()).data.user.id).toBe(original.id)
  })
}
