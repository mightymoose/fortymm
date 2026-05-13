import { expect, test } from '@playwright/test'
import { UsersPage } from './page-objects/rbac/users.page'

const BASE_SEED = {
  permissions: [
    { id: 'p_tv', name: 'tournament.view' },
    { id: 'p_cs', name: 'courts.score' },
  ],
  roles: [
    { id: 'r_admin', name: 'Admin', permission_ids: ['p_tv', 'p_cs'] },
    { id: 'r_score', name: 'Scorekeeper', permission_ids: ['p_cs'] },
  ],
  users: [
    { id: 'u1', username: 'alex', role_ids: ['r_admin'] },
    { id: 'u2', username: 'maya', role_ids: ['r_admin', 'r_score'] },
    { id: 'u3', username: 'eun', role_ids: [] },
  ],
}

test.describe('Administration · Users', () => {
  test('lists users and surfaces a "no role" warning for unassigned users', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, BASE_SEED)
    await expect(pom.heading).toBeVisible()
    await expect(pom.userRow('alex')).toBeVisible()
    await expect(pom.userRow('eun').getByText('no role', { exact: true })).toBeVisible()
  })

  test('shows the empty state with a CTA when no users exist', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, { permissions: [], roles: [], users: [] })
    await expect(pom.emptyState).toBeVisible()
    await expect(pom.addButton.first()).toBeVisible()
  })

  test('escalates a 500 on users fetch to the error boundary', async ({ page }) => {
    await page.route('**/api/v1/users', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    )
    await page.route('**/api/v1/roles', (route) =>
      route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
    )
    await page.route('**/api/v1/permissions', (route) =>
      route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
    )
    await page.goto('/admin/users')
    await expect(page.getByText('Something went wrong loading this page').first()).toBeVisible()
  })

  test('search filters users by username', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, BASE_SEED)
    await pom.searchInput.fill('ale')
    await expect(pom.userRow('alex')).toBeVisible()
    await expect(page.locator('.rbac-row').filter({ hasText: 'maya' })).toHaveCount(0)
  })

  test('search with no matches shows the filter empty state', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, BASE_SEED)
    await pom.searchInput.fill('zzz')
    await expect(page.getByText('No users match this filter.')).toBeVisible()
  })

  test('Add user happy path: modal closes, drawer opens for the new user', async ({ page }) => {
    const { pom, store } = await UsersPage.navigateTo(page, BASE_SEED)
    await pom.addButton.click()
    await pom.newUsernameInput.fill('rita.kovac')
    await pom.newUserSubmit.click()
    await expect(pom.sheet).toBeVisible()
    await expect(pom.sheet.getByText('rita.kovac', { exact: true })).toBeVisible()
    expect(store.listUsers().some((u) => u.username === 'rita.kovac')).toBe(true)
  })

  test('client-side guard rejects a duplicate username before submit', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, BASE_SEED)
    await pom.addButton.click()
    await pom.newUsernameInput.fill('alex')
    await expect(page.getByText(/already taken/i)).toBeVisible()
    await expect(pom.newUserSubmit).toBeDisabled()
  })

  test('a 409 from the server on add shows a toast', async ({ page }) => {
    const { pom, store } = await UsersPage.navigateTo(page, BASE_SEED)
    store.fail({ pattern: 'POST', status: 409, body: { detail: 'username already exists' }, times: 1 })
    await pom.addButton.click()
    await pom.newUsernameInput.fill('rita.kovac')
    await pom.newUserSubmit.click()
    await expect(pom.toast()).toContainText('username already exists')
  })

  test('opens the drawer, save is disabled when nothing changes', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, BASE_SEED)
    await pom.userRow('alex').click()
    await expect(pom.noChangesButton).toBeDisabled()
  })

  test('toggling a role enables Save and persists the new role set', async ({ page }) => {
    const { pom, store } = await UsersPage.navigateTo(page, BASE_SEED)
    await pom.userRow('eun').click()
    await pom.drawerRoleRow('Scorekeeper').click()
    await pom.saveButton.click()
    await expect(pom.sheet).toBeHidden({ timeout: 5000 }).catch(() => {})
    await expect.poll(() => store.getUser('u3')!.role_ids).toEqual(['r_score'])
  })

  test('clicking the role checkbox in the drawer toggles (no double-fire cancellation)', async ({
    page,
  }) => {
    const { pom, store } = await UsersPage.navigateTo(page, BASE_SEED)
    await pom.userRow('eun').click()
    await pom.drawerRoleRow('Scorekeeper').locator('button[role=checkbox]').click()
    await pom.saveButton.click()
    await expect.poll(() => store.getUser('u3')!.role_ids).toEqual(['r_score'])
  })

  test('a 500 on PUT user roles toasts and leaves the DB unchanged', async ({ page }) => {
    const { pom, store } = await UsersPage.navigateTo(page, BASE_SEED)
    await pom.userRow('eun').click()
    await pom.drawerRoleRow('Scorekeeper').click()
    store.fail({ pattern: 'PUT', status: 500, body: { detail: 'db down' }, times: 1 })
    await pom.saveButton.click()
    await expect(pom.toast()).toContainText("Couldn't save role assignments")
    expect(store.getUser('u3')!.role_ids).toEqual([])
  })

  test('removes a user via the drawer with confirmation', async ({ page }) => {
    const { pom, store } = await UsersPage.navigateTo(page, BASE_SEED)
    await pom.userRow('eun').click()
    await pom.removeButton.click()
    await pom.confirmRemoveButton.click()
    await expect(page.locator('.rbac-row').filter({ hasText: /^eun/ })).toHaveCount(0)
    expect(store.getUser('u3')).toBeUndefined()
  })

  test('a 500 on user delete keeps the user visible and toasts', async ({ page }) => {
    const { pom, store } = await UsersPage.navigateTo(page, BASE_SEED)
    store.fail({ pattern: 'DELETE', status: 500, body: { detail: 'cannot delete' }, times: 1 })
    await pom.userRow('eun').click()
    await pom.removeButton.click()
    await pom.confirmRemoveButton.click()
    await expect(pom.toast()).toContainText("Couldn't remove the user")
    expect(store.getUser('u3')).toBeDefined()
  })

  test('drawer stat shows resolved permission count from selected roles', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, BASE_SEED)
    await pom.userRow('alex').click()
    // Admin has 2 perms (tournament.view + courts.score)
    await expect(pom.sheet.getByText(/grants/)).toBeVisible()
    await expect(pom.sheet.getByText('2', { exact: true })).toBeVisible()
  })

  test('removing the only role surfaces the "this user can\'t do anything" callout', async ({
    page,
  }) => {
    const { pom } = await UsersPage.navigateTo(page, BASE_SEED)
    await pom.userRow('alex').click()
    await pom.drawerRoleRow('Admin').click()
    await expect(pom.sheet.getByText(/can't do anything/i)).toBeVisible()
  })
})
