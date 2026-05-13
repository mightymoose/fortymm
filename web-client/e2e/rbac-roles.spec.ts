import { expect, test } from '@playwright/test'
import { RolesPage } from './page-objects/rbac/roles.page'

const BASE_SEED = {
  permissions: [
    { id: 'p_tv', name: 'tournament.view', description: 'View tournaments.' },
    { id: 'p_te', name: 'tournament.edit', description: 'Edit tournaments.' },
    { id: 'p_dv', name: 'draws.view', description: 'View brackets.' },
    { id: 'p_cs', name: 'courts.score', description: 'Score live matches.' },
  ],
  roles: [
    {
      id: 'r_admin',
      name: 'Admin',
      description: 'Full power.',
      permission_ids: ['p_tv', 'p_te', 'p_dv', 'p_cs'],
    },
    {
      id: 'r_score',
      name: 'Scorekeeper',
      description: 'Tap in points.',
      permission_ids: ['p_cs'],
    },
  ],
  users: [
    { id: 'u1', username: 'alex', role_ids: ['r_admin'] },
    { id: 'u2', username: 'maya', role_ids: ['r_admin', 'r_score'] },
    { id: 'u3', username: 'riley', role_ids: ['r_score'] },
  ],
}

test.describe('Administration · Roles', () => {
  test('shows the role list and selects the first role by default', async ({ page }) => {
    await RolesPage.navigateTo(page, BASE_SEED)
    await expect(page.getByText('Admin').first()).toBeVisible()
    await expect(page.getByText('Scorekeeper').first()).toBeVisible()
    // Detail title for the first (alphabetical) role
    await expect(page.locator('h1.rbac-inline-edit', { hasText: 'Admin' })).toBeVisible()
  })

  test('shows the empty state with a CTA when no roles exist', async ({ page }) => {
    const { pom } = await RolesPage.navigateTo(page, { permissions: [], roles: [], users: [] })
    await expect(pom.emptyState).toBeVisible()
    await expect(pom.newButton.first()).toBeVisible()
  })

  test('escalates a 500 on roles fetch to the error boundary', async ({ page }) => {
    await page.route('**/api/v1/roles', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    )
    await page.route('**/api/v1/permissions', (route) =>
      route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
    )
    await page.route('**/api/v1/users', (route) =>
      route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
    )
    await page.goto('/admin/roles')
    await expect(page.getByText('Something went wrong loading this page').first()).toBeVisible()
  })

  test('toggling a permission row fires exactly one PATCH and persists', async ({ page }) => {
    const { pom, store } = await RolesPage.navigateTo(page, BASE_SEED)
    // Select Scorekeeper so it has a small permission set we can mutate
    await pom.roleRow('Scorekeeper').click()
    const before = store.requests.filter((r) => r.method === 'PATCH').length
    await pom.permRow('tournament.view').click()
    await expect(page.getByText('2 / 4')).toBeVisible()
    const after = store.requests.filter((r) => r.method === 'PATCH').length
    expect(after - before).toBe(1)
    expect(store.getRole('r_score')!.permission_ids).toContain('p_tv')
  })

  test('clicking the checkbox itself fires exactly one PATCH (no double-fire)', async ({ page }) => {
    const { pom, store } = await RolesPage.navigateTo(page, BASE_SEED)
    await pom.roleRow('Scorekeeper').click()
    const before = store.requests.filter((r) => r.method === 'PATCH').length
    await pom.permRow('tournament.view').locator('button[role=checkbox]').click()
    await expect(page.getByText('2 / 4')).toBeVisible()
    expect(store.requests.filter((r) => r.method === 'PATCH').length - before).toBe(1)
  })

  test('a 500 when toggling a permission shows a toast and reverts the UI', async ({ page }) => {
    const { pom, store } = await RolesPage.navigateTo(page, BASE_SEED)
    await pom.roleRow('Scorekeeper').click()
    store.fail({ pattern: 'PATCH', status: 500, body: { detail: 'db down' }, times: 1 })
    await pom.permRow('tournament.view').click()
    await expect(pom.toast()).toContainText("Couldn't update the role")
    // Scorekeeper still has only its original 1 permission
    await expect(page.getByText('1 / 4')).toBeVisible()
    expect(store.getRole('r_score')!.permission_ids).toEqual(['p_cs'])
  })

  test('inline-renaming a role to an existing name surfaces a 409 toast', async ({ page }) => {
    const { pom, store } = await RolesPage.navigateTo(page, BASE_SEED)
    await pom.roleRow('Scorekeeper').click()
    await pom.detailTitle('Scorekeeper').click()
    const input = pom.titleInput('Scorekeeper')
    await input.fill('Admin')
    await input.press('Tab')
    await expect(pom.toast()).toContainText(/role name already exists/i)
    expect(store.getRole('r_score')!.name).toBe('Scorekeeper')
  })

  test('creates a new role from blank and selects it', async ({ page }) => {
    const { pom, store } = await RolesPage.navigateTo(page, BASE_SEED)
    await pom.newButton.click()
    await pom.newRoleNameInput.fill('Volunteer Scorer')
    await pom.newRoleDescriptionInput.fill('Weekend volunteers.')
    await pom.newRoleSubmit.click()
    await expect(page.locator('h1.rbac-inline-edit', { hasText: 'Volunteer Scorer' })).toBeVisible()
    expect(store.listRoles().some((r) => r.name === 'Volunteer Scorer')).toBe(true)
  })

  test('duplicate-role copies permissions from the source', async ({ page }) => {
    const { pom, store } = await RolesPage.navigateTo(page, BASE_SEED)
    await pom.roleRow('Admin').click()
    await pom.duplicateButton.click()
    const copy = store.listRoles().find((r) => r.name === 'Admin (copy)')
    expect(copy).toBeDefined()
    expect(copy!.permission_ids).toEqual(['p_tv', 'p_te', 'p_dv', 'p_cs'])
  })

  test('a 500 on duplicate shows a toast and does not select a phantom role', async ({ page }) => {
    const { pom, store } = await RolesPage.navigateTo(page, BASE_SEED)
    await pom.roleRow('Admin').click()
    store.fail({ pattern: 'POST', status: 500, body: { detail: 'cannot copy' }, times: 1 })
    await pom.duplicateButton.click()
    await expect(pom.toast()).toContainText("Couldn't create the role")
    expect(store.listRoles().find((r) => r.name === 'Admin (copy)')).toBeUndefined()
  })

  test('deletes a role and removes it from the sidebar', async ({ page }) => {
    const { pom, store } = await RolesPage.navigateTo(page, BASE_SEED)
    await pom.roleRow('Scorekeeper').click()
    await page.getByRole('button', { name: /^Delete$/ }).first().click()
    await pom.confirmDeleteButton.click()
    await expect(page.getByText('Scorekeeper', { exact: true })).toHaveCount(0)
    expect(store.listRoles().some((r) => r.name === 'Scorekeeper')).toBe(false)
  })

  test('a 500 on delete keeps the role visible and toasts', async ({ page }) => {
    const { pom, store } = await RolesPage.navigateTo(page, BASE_SEED)
    await pom.roleRow('Scorekeeper').click()
    store.fail({ pattern: 'DELETE', status: 500, body: { detail: 'fk constraint' }, times: 1 })
    await page.getByRole('button', { name: /^Delete$/ }).first().click()
    await pom.confirmDeleteButton.click()
    await expect(pom.toast()).toContainText("Couldn't delete the role")
    expect(store.listRoles().some((r) => r.name === 'Scorekeeper')).toBe(true)
  })

  test('Members tab shows users that have this role', async ({ page }) => {
    const { pom } = await RolesPage.navigateTo(page, BASE_SEED)
    await pom.roleRow('Admin').click()
    await page.getByRole('button', { name: /^Users/ }).click()
    await expect(page.getByText('alex')).toBeVisible()
    await expect(page.getByText('maya')).toBeVisible()
  })

  test('Revoke from Members tab removes the user from this role only', async ({ page }) => {
    const { pom, store } = await RolesPage.navigateTo(page, BASE_SEED)
    await pom.roleRow('Admin').click()
    await page.getByRole('button', { name: /^Users/ }).click()
    // Each member card contains their id as `user id u2` — scope by that to avoid sibling rows
    const mayaCard = page.locator('div').filter({ hasText: 'user id u2' }).filter({ has: page.getByRole('button', { name: /Revoke/ }) }).last()
    await mayaCard.getByRole('button', { name: /Revoke/ }).click()
    await expect.poll(() => store.getUser('u2')!.role_ids).toEqual(['r_score'])
  })
})
