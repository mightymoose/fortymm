import { expect, test } from '@playwright/test'
import { AppLayoutPage } from './app-layout.page.ts'

test.describe('on a phone', () => {
  test('the bottom bar is shown', async ({ page }) => {
    const layout = new AppLayoutPage(page)
    await layout.gotoOnPhone()
    await expect(layout.bottomBar).toBeVisible()
  })

  test('the sidebar is not shown', async ({ page }) => {
    const layout = new AppLayoutPage(page)
    await layout.gotoOnPhone()
    await expect(layout.sidebar).toBeHidden()
  })

  test('the sidebar toggle is not shown', async ({ page }) => {
    const layout = new AppLayoutPage(page)
    await layout.gotoOnPhone()
    await expect(layout.sidebarToggle).toBeHidden()
  })

  test('a toast sits above the bottom bar', async ({ page }) => {
    const layout = new AppLayoutPage(page)
    await layout.gotoOnPhone()
    await layout.showToast()
    expect(await layout.toastClearanceAboveBottomBar()).toBeGreaterThan(0)
  })
})

test.describe('on a desktop', () => {
  test('the sidebar is shown', async ({ page }) => {
    const layout = new AppLayoutPage(page)
    await layout.gotoOnDesktop()
    await expect(layout.sidebar).toBeVisible()
  })

  test('the bottom bar is not shown', async ({ page }) => {
    const layout = new AppLayoutPage(page)
    await layout.gotoOnDesktop()
    await expect(layout.bottomBar).toBeHidden()
  })
})
