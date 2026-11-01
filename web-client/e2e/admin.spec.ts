import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.ts'

// The migration makes this email's account an administrator. A sign-in
// with no session counts toward the guest account limit.
const administrator = { sub: 'e2e|mightymoose', email: 'mightymoose@fortymm.com' }

test('an administrator creates a role, then deletes it', async ({ adminPage, signInPage }) => {
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
})
