import { expect, test } from '@playwright/test'
import { LandingPage } from './page-objects/landing.page'

test('landing page renders the hero heading', async ({ page }) => {
  const landingPage = await LandingPage.navigateTo(page)

  await expect(landingPage.heroHeading).toBeVisible()
})

for (const width of [1440, 320]) {
  test(`landing preserves heading hierarchy and fits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/?landing=true')
    const heading = page.getByRole('heading', { name: /Everything a club needs/ })
    await expect(heading).toBeVisible()
    expect(await heading.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(42)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
  })
}

test('FAQ exposes state and a real controlled answer', async ({ page }) => {
  await page.goto('/?landing=true')
  const question = page.getByRole('button', { name: /Is it really free/ })
  await expect(question).toHaveAttribute('aria-expanded', 'true')
  const answerId = await question.getAttribute('aria-controls')
  expect(answerId).toBeTruthy()
  const answer = page.locator(`[id="${answerId}"]`)
  await expect(answer).toBeVisible()
  await question.click()
  await expect(question).toHaveAttribute('aria-expanded', 'false')
  await expect(answer).toBeHidden()
  await question.press('Enter')
  await expect(answer).toBeVisible()
})

test('reduced motion shows a complete, static demo', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?landing=true')
  const demo = page.locator('.solver')
  await expect(demo.getByText('courts × rounds × players')).toBeVisible()
  expect(await page.locator('.sb-serve').evaluate(el => getComputedStyle(el).animationName)).toBe('none')
  const before = await page.locator('.scoreboard').innerText()
  await page.waitForTimeout(2800)
  expect(await page.locator('.scoreboard').innerText()).toBe(before)
  await expect(demo.getByText('courts × rounds × players')).toBeVisible()
})
