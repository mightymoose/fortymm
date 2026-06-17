import { expect, test } from '@playwright/test'
import { PermissionsPage } from './page-objects/rbac/permissions.page'
import { mockAdminSession } from './page-objects/rbac/rbac-store'

const BASE_SEED = {
  permissions: [
    { id: 'p_tv', name: 'tournament.view', description: 'See tournaments.' },
    { id: 'p_te', name: 'tournament.edit', description: 'Edit tournaments.' },
    { id: 'p_dv', name: 'draws.view', description: 'View brackets.' },
  ],
  roles: [
    {
      id: 'r_admin',
      name: 'Admin',
      description: 'Wields all power.',
      permission_ids: ['p_tv', 'p_te'],
    },
  ],
}

test.describe('Administration · Permissions', () => {
  test('shows the heading, prefix groups, and a "in use" tally', async ({ page }) => {
    const { pom } = await PermissionsPage.navigateTo(page, BASE_SEED)
    await expect(pom.heading).toBeVisible()
    await expect(page.getByText('tournament.*')).toBeVisible()
    await expect(page.getByText('draws.*')).toBeVisible()
    // 2 of 3 perms are owned by Admin role
    await expect(page.getByText('2 / 3')).toBeVisible()
  })

  test('shows the empty state with a CTA when no permissions exist', async ({ page }) => {
    const { pom } = await PermissionsPage.navigateTo(page, { permissions: [], roles: [] })
    await expect(pom.emptyState).toBeVisible()
    await expect(page.getByRole('button', { name: /New permission/i }).first()).toBeVisible()
  })

  test('renders skeleton placeholders while permissions load', async ({ page }) => {
    await mockAdminSession(page)
    let release: (() => void) | null = null
    await page.route('**/api/v1/permissions', async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    })
    await page.route('**/api/v1/roles', (route) =>
      route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
    )
    await page.route('**/api/v1/users', (route) =>
      route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
    )
    await page.goto('/admin/permissions')
    await expect(page.locator('[data-slot=skeleton]').first()).toBeVisible()
    release?.()
    await expect(page.getByText('No permissions yet')).toBeVisible()
  })

  test('escalates a 500 on initial load to the error boundary', async ({ page }) => {
    await mockAdminSession(page)
    await page.route('**/api/v1/permissions', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"boom"}' }),
    )
    await page.route('**/api/v1/roles', (route) =>
      route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
    )
    await page.route('**/api/v1/users', (route) =>
      route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
    )
    await page.goto('/admin/permissions')
    await expect(page.getByText('Something went wrong loading this page').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible()
  })

  test('"Try again" recovers after the error is resolved', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    await expect(pom.heading).toBeVisible()
    // Now break the next refetch and trigger one by going elsewhere and back
    store.fail({ pattern: /^GET .*\/api\/v1\/permissions$/, status: 500, times: 1 })
    await page.reload()
    await expect(page.getByText('Something went wrong loading this page').first()).toBeVisible()
    // The boundary recovers once the next fetch succeeds
    await page.getByRole('button', { name: 'Try again' }).last().click()
    await expect(page.getByText('tournament.view')).toBeVisible()
  })

  test('creates a permission and shows it in the list', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    await pom.newButton.click()
    await pom.dialogNameInput.fill('courts.score')
    await pom.dialogDescriptionInput.fill('Tap in points at courtside.')
    await pom.dialogCreateButton.click()
    await expect(page.getByText('courts.score')).toBeVisible()
    expect(store.listPermissions().some((p) => p.name === 'courts.score')).toBe(true)
  })

  test('rejects a duplicate name in the create form (client-side guard)', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    await pom.newButton.click()
    await pom.dialogNameInput.fill('tournament.view')
    await expect(page.getByText(/already exists/i)).toBeVisible()
    await pom.dialogCreateButton.click()
    await expect(pom.dialogNameInput).toBeVisible()
    expect(store.listPermissions().filter((p) => p.name === 'tournament.view')).toHaveLength(1)
  })

  test('rejects a malformed name (client-side guard)', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    await pom.newButton.click()
    await pom.dialogNameInput.fill('Has Spaces!')
    await expect(page.getByText(/lowercase letters/i)).toBeVisible()
    await pom.dialogCreateButton.click()
    await expect(pom.dialogNameInput).toBeVisible()
    expect(store.listPermissions()).toHaveLength(3)
  })

  test('flags an empty name on submit (client-side guard)', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    await pom.newButton.click()
    // Submit without typing anything — zod's .min(1) message must surface.
    await pom.dialogCreateButton.click()
    await expect(page.getByText('Name is required.')).toBeVisible()
    await expect(pom.dialogNameInput).toBeVisible()
    expect(store.listPermissions()).toHaveLength(3)
  })

  test('flags an undotted name (resource.action convention is required)', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    await pom.newButton.click()
    // Passes the character-class check but has no dot — the refine still rejects.
    await pom.dialogNameInput.fill('invalidname')
    await expect(page.getByText(/lowercase letters/i)).toBeVisible()
    await expect(page.getByText(/exactly one dot/i)).toBeVisible()
    await pom.dialogCreateButton.click()
    await expect(pom.dialogNameInput).toBeVisible()
    expect(store.listPermissions().some((p) => p.name === 'invalidname')).toBe(false)
  })

  test('flags a name longer than 255 characters (client-side guard)', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    await pom.newButton.click()
    // 'a.' + 254 b's → length 256, passes the regex, fails .max(255).
    const tooLong = 'a.' + 'b'.repeat(254)
    await pom.dialogNameInput.fill(tooLong)
    await expect(page.getByText(/255 characters or fewer/i)).toBeVisible()
    await pom.dialogCreateButton.click()
    await expect(pom.dialogNameInput).toBeVisible()
    expect(store.listPermissions()).toHaveLength(3)
  })

  test('flags a description longer than 1024 characters (client-side guard)', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    await pom.newButton.click()
    await pom.dialogNameInput.fill('courts.score')
    await pom.dialogDescriptionInput.fill('x'.repeat(1025))
    await expect(page.getByText(/1024 characters or fewer/i)).toBeVisible()
    await pom.dialogCreateButton.click()
    await expect(pom.dialogNameInput).toBeVisible()
    expect(store.listPermissions().some((p) => p.name === 'courts.score')).toBe(false)
  })

  test('surfaces a server 500 on create as a toast (UI does not crash)', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    store.fail({ pattern: 'POST', status: 500, body: { detail: 'database is down' }, times: 1 })
    await pom.newButton.click()
    await pom.dialogNameInput.fill('courts.score')
    await pom.dialogCreateButton.click()
    await expect(pom.toast()).toBeVisible()
    await expect(pom.toast()).toContainText(/Couldn't create the permission/i)
    await expect(pom.toast()).toContainText('database is down')
    // Modal stays open and the store is unchanged.
    await expect(pom.dialogNameInput).toBeVisible()
    expect(store.listPermissions().some((p) => p.name === 'courts.score')).toBe(false)
  })

  test('surfaces a 409 conflict from the server inline on the name field', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    // Race: someone created the permission between page load and submit.
    store.fail({ pattern: 'POST', status: 409, body: { detail: 'permission name already exists' }, times: 1 })
    await pom.newButton.click()
    await pom.dialogNameInput.fill('courts.brand_new')
    await pom.dialogCreateButton.click()
    await expect(page.getByText('permission name already exists')).toBeVisible()
    // Modal stays open so the user can correct the name.
    await expect(pom.dialogNameInput).toBeVisible()
  })

  test('surfaces a 422 server validation error inline on the name field', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    // Stricter server pattern than the client (or client/server drift) —
    // the API rejects with 422 and the detail must surface inline.
    store.fail({
      pattern: 'POST',
      status: 422,
      body: { detail: 'permission name must match resource.action convention' },
      times: 1,
    })
    await pom.newButton.click()
    await pom.dialogNameInput.fill('courts.brand_new')
    await pom.dialogCreateButton.click()
    await expect(
      page.getByText('permission name must match resource.action convention'),
    ).toBeVisible()
    await expect(pom.dialogNameInput).toBeVisible()
  })

  test('surfaces a 409 conflict on update inline on the name field', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    store.fail({
      pattern: 'PATCH',
      status: 409,
      body: { detail: 'permission name already exists' },
      times: 1,
    })
    await pom.permissionRow('tournament.view').getByRole('button', { name: 'Edit' }).click()
    // Use a name the client-side guard accepts (not in seed) so the request
    // actually hits the server, where the mock returns 409.
    await pom.dialogNameInput.fill('courts.score')
    await pom.dialogSaveButton.click()
    await expect(page.getByText('permission name already exists')).toBeVisible()
    await expect(pom.dialogNameInput).toBeVisible()
  })

  test('surfaces an arbitrary 4xx (e.g. 403) from the server as a toast', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    // 403 isn't a field-level error — the form should fall through to the toast
    // path so the user still learns what happened.
    store.fail({
      pattern: 'POST',
      status: 403,
      body: { detail: 'you do not have permission to create permissions' },
      times: 1,
    })
    await pom.newButton.click()
    await pom.dialogNameInput.fill('courts.score')
    await pom.dialogCreateButton.click()
    await expect(pom.toast()).toContainText(/Couldn't create the permission/i)
    await expect(pom.toast()).toContainText('you do not have permission to create permissions')
    await expect(pom.dialogNameInput).toBeVisible()
  })

  test('edits a permission description and the row reflects it', async ({ page }) => {
    const { pom } = await PermissionsPage.navigateTo(page, BASE_SEED)
    await pom.permissionRow('tournament.view').getByRole('button', { name: 'Edit' }).click()
    await pom.dialogDescriptionInput.fill('Updated description text')
    await pom.dialogSaveButton.click()
    await expect(page.getByText('Updated description text')).toBeVisible()
  })

  test('a 500 on update keeps the original value visible and toasts', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    store.fail({ pattern: 'PATCH', status: 500, body: { detail: 'update broke' }, times: 1 })
    await pom.permissionRow('tournament.view').getByRole('button', { name: 'Edit' }).click()
    await pom.dialogDescriptionInput.fill('Updated description text')
    await pom.dialogSaveButton.click()
    await expect(pom.toast()).toContainText("Couldn't update the permission")
    // The row in the list still shows the original description (the rollback
    // is implicit — we never optimistically updated the cache).
    await expect(pom.permissionRow('tournament.view')).toContainText('See tournaments.')
    await expect(pom.permissionRow('tournament.view')).not.toContainText('Updated description text')
  })

  test('deletes a permission after confirming and removes it from the list', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    await pom.permissionRow('draws.view').getByRole('button', { name: 'Delete' }).click()
    await pom.confirmDeleteButton.click()
    await expect(page.getByText('draws.view')).toHaveCount(0)
    expect(store.listPermissions().some((p) => p.name === 'draws.view')).toBe(false)
  })

  test('a 500 on delete keeps the row visible and toasts', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, BASE_SEED)
    store.fail({ pattern: 'DELETE', status: 500, body: { detail: 'cant delete' }, times: 1 })
    await pom.permissionRow('draws.view').getByRole('button', { name: 'Delete' }).click()
    await pom.confirmDeleteButton.click()
    await expect(pom.toast()).toContainText("Couldn't delete the permission")
    await expect(page.getByText('draws.view')).toBeVisible()
  })

  test('search filters the visible rows', async ({ page }) => {
    const { pom } = await PermissionsPage.navigateTo(page, BASE_SEED)
    await pom.searchInput.fill('draws')
    await expect(page.getByText('draws.view')).toBeVisible()
    await expect(page.getByText('tournament.view')).toHaveCount(0)
  })

  test('search with no matches shows a "no permissions match" empty filter state', async ({ page }) => {
    const { pom } = await PermissionsPage.navigateTo(page, BASE_SEED)
    await pom.searchInput.fill('zzzzzz')
    await expect(page.getByText('No permissions match.')).toBeVisible()
  })
})
