import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.ts'

// The migration makes this email's account an administrator. A sign-in
// with no session counts toward the guest account limit.
const administrator = { sub: 'e2e|mightymoose', email: 'mightymoose@fortymm.com' }

test('an administrator creates a role, deletes it, then opens their account', async ({ page, adminPage, signInPage }) => {
  await signInPage.signIn(administrator)
  await adminPage.goto()
  await expect(adminPage.title).toBeVisible()
  await expect(adminPage.row('Administrator')).toBeVisible()

  // The dev database keeps its roles, so each run makes a new name.
  const name = `Umpire ${randomUUID().slice(0, 8)}`
  await adminPage.createRole(name, ['admin.view'])
  await expect(adminPage.row(name)).toContainText('admin.view')

  await test.step('on a phone, the toast sits above the tab bar', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await adminPage.deleteRole(name)
    await expect(adminPage.row(name)).toHaveCount(0)
    await expect(adminPage.toastRegion).toContainText('Role deleted')
    const toast = await adminPage.toastRegion.boundingBox()
    const tabBar = await adminPage.mainNav.boundingBox()
    expect(toast).not.toBeNull()
    expect(tabBar).not.toBeNull()
    expect(toast!.y + toast!.height).toBeLessThanOrEqual(tabBar!.y)
    await page.setViewportSize({ width: 1280, height: 720 })
  })

  await adminPage.openAccount(administrator.email)
  await expect(adminPage.accountHeading(administrator.email)).toBeVisible()
  await expect(adminPage.roleCheckbox('Administrator')).toBeChecked()
})
