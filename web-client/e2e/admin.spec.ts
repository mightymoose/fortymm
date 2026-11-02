import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.ts'

// The migration makes this email's account an administrator. A sign-in
// with no session counts toward the guest account limit.
const administrator = { sub: 'e2e|mightymoose', email: 'mightymoose@fortymm.com' }

test('an administrator creates a role, deletes it, then opens their account', async ({ adminPage, signInPage }) => {
  await signInPage.signIn(administrator)
  await adminPage.goto()
  await expect(adminPage.title).toBeVisible()
  await expect(adminPage.row('Administrator')).toBeVisible()

  // The dev database keeps its roles, so each run makes a new name.
  const name = `Umpire ${randomUUID().slice(0, 8)}`
  await adminPage.createRole(name, ['admin.view'])
  await expect(adminPage.row(name)).toContainText('admin.view')

  await adminPage.deleteRole(name)
  await expect(adminPage.row(name)).toHaveCount(0)

  await adminPage.openAccount(administrator.email)
  await expect(adminPage.accountHeading(administrator.email)).toBeVisible()
  await expect(adminPage.roleCheckbox('Administrator')).toBeChecked()
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  // `.fm-toast-region` in kit.css, which the tab bar's top edge replaces.
  const KIT_TOAST_BOTTOM_PX = 24

  test('a toast sits above the tab bar', async ({ adminPage, signInPage }) => {
    await signInPage.signIn(administrator)
    await adminPage.goto()
    const name = `Umpire ${randomUUID().slice(0, 8)}`
    await adminPage.createRole(name, ['admin.view'])
    await expect(adminPage.toastRegion).toContainText('Role created')

    const toast = await adminPage.toastRegion.boundingBox()
    const tabBar = await adminPage.tabBar.boundingBox()
    if (!toast || !tabBar) throw new Error('The toast or the tab bar has no box')
    expect(tabBar.y - (toast.y + toast.height)).toBeCloseTo(KIT_TOAST_BOTTOM_PX, 0)

    await adminPage.deleteRole(name)
  })
})
