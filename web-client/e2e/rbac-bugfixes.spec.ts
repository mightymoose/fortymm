import { expect, test, type Page } from '@playwright/test'
import { PermissionsPage } from './page-objects/rbac/permissions.page'
import { RolesPage } from './page-objects/rbac/roles.page'
import { UsersPage } from './page-objects/rbac/users.page'

/**
 * Regression tests for a batch of admin-area bugs. Each block is written
 * against the *fixed* behaviour: run against the unpatched code they fail,
 * which is what verifies the bug exists in the first place.
 */

const ROLES_SEED = {
  permissions: [
    { id: 'p_tv', name: 'tournament.view', description: 'View tournaments.' },
    { id: 'p_cs', name: 'courts.score', description: 'Score live matches.' },
  ],
  roles: [
    { id: 'r_admin', name: 'Admin', description: 'Full power.', permission_ids: ['p_tv', 'p_cs'] },
    { id: 'r_score', name: 'Scorekeeper', description: 'Tap in points.', permission_ids: ['p_cs'] },
  ],
  users: [{ id: 'u1', username: 'alex', role_ids: ['r_admin'] }],
}

const PERMS_SEED = {
  permissions: [{ id: 'p_tv', name: 'tournament.view', description: 'See tournaments.' }],
  roles: [],
}

test.describe('Bug #8 · Remove user must not allow self-removal', () => {
  // RbacStore signs the session in as `rita.kovac`.
  const SEED = {
    permissions: [],
    roles: [],
    users: [
      { id: 'u_self', username: 'rita.kovac', role_ids: [] },
      { id: 'u_other', username: 'alex', role_ids: [] },
    ],
  }

  test('Remove user is disabled for the signed-in admin', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, SEED)
    await pom.userRow('rita.kovac').click()
    await expect(pom.sheet).toBeVisible()
    await expect(pom.removeButton).toBeDisabled()
  })

  test('Remove user stays enabled for other users', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, SEED)
    await pom.userRow('alex').click()
    await expect(pom.sheet).toBeVisible()
    await expect(pom.removeButton).toBeEnabled()
  })
})

test.describe('Bug #3 · relative timestamps must not land in the future', () => {
  // A browser timezone behind UTC exposes the bug: a naive (no-`Z`) UTC
  // timestamp from the API gets parsed as local time and drifts hours ahead.
  test.use({ timezoneId: 'America/New_York' })

  test('a naive UTC timestamp renders as "ago", never "in …"', async ({ page }) => {
    const naive = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().replace('Z', '')
    const { pom } = await RolesPage.navigateTo(page, {
      permissions: [],
      roles: [{ id: 'r1', name: 'Tournament Director', updated_at: naive, created_at: naive }],
      users: [],
    })
    const row = pom.roleRow('Tournament Director')
    await expect(row).toBeVisible()
    await expect(row).not.toContainText(/\bin \d/)
    await expect(row).toContainText(/ago/)
  })
})

test.describe('Bug #4 · selection must track the filtered list', () => {
  test('filtering out the selected role clears it from the detail panel', async ({ page }) => {
    const { pom } = await RolesPage.navigateTo(page, ROLES_SEED)
    await pom.roleRow('Scorekeeper').click()
    await expect(pom.detailTitle('Scorekeeper')).toBeVisible()

    await pom.searchInput.fill('Admin')
    // Scorekeeper drops out of the sidebar...
    await expect(page.locator('.rbac-row').filter({ hasText: 'Scorekeeper' })).toHaveCount(0)
    // ...so the detail panel must not keep showing it.
    await expect(pom.detailTitle('Scorekeeper')).toHaveCount(0)
  })
})

test.describe('Bug #5/#1 · New role dialog must flag an empty name', () => {
  test('submitting an empty name shows an inline error and creates nothing', async ({ page }) => {
    const { pom, store } = await RolesPage.navigateTo(page, ROLES_SEED)
    await pom.newButton.click()
    await pom.newRoleSubmit.click({ force: true })
    await expect(page.getByText('Name is required.')).toBeVisible()
    await expect(pom.newRoleNameInput).toBeVisible()
    expect(store.listRoles()).toHaveLength(2)
  })

  test('whitespace-only name is rejected the same way', async ({ page }) => {
    const { pom, store } = await RolesPage.navigateTo(page, ROLES_SEED)
    await pom.newButton.click()
    await pom.newRoleNameInput.fill('   ')
    await pom.newRoleSubmit.click({ force: true })
    await expect(page.getByText('Name is required.')).toBeVisible()
    expect(store.listRoles()).toHaveLength(2)
  })
})

test.describe('Bug #6 · permission names follow resource.action (one dot)', () => {
  test('a name with more than one dot is rejected client-side', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, PERMS_SEED)
    await pom.newButton.click()
    await pom.dialogNameInput.fill('a.b.c.d.e')
    await expect(page.locator('[data-slot=form-message]')).toContainText(/exactly one dot/i)
    await pom.dialogCreateButton.click()
    await expect(pom.dialogNameInput).toBeVisible()
    expect(store.listPermissions().some((p) => p.name === 'a.b.c.d.e')).toBe(false)
  })

  test('a well-formed resource.action name is still accepted', async ({ page }) => {
    const { pom, store } = await PermissionsPage.navigateTo(page, PERMS_SEED)
    await pom.newButton.click()
    await pom.dialogNameInput.fill('courts.score')
    await pom.dialogCreateButton.click()
    await expect(page.getByText('courts.score')).toBeVisible()
    expect(store.listPermissions().some((p) => p.name === 'courts.score')).toBe(true)
  })
})

test.describe('Bug #9 · effective-permissions copy must reflect attached roles', () => {
  test('an attached role with zero permissions is not reported as "no role"', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, {
      permissions: [],
      roles: [{ id: 'r_empty', name: 'Empty Role', description: 'Grants nothing.', permission_ids: [] }],
      users: [{ id: 'u1', username: 'alex', role_ids: ['r_empty'] }],
    })
    await pom.userRow('alex').click()
    await expect(pom.sheet).toBeVisible()
    // A role IS attached — the "attach at least one role" copy would be wrong.
    await expect(pom.sheet.getByText(/can't do anything/i)).toHaveCount(0)
    await expect(pom.sheet.getByText(/no permissions/i)).toBeVisible()
  })

  test('a user with no roles at all still gets the "attach a role" prompt', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, {
      permissions: [],
      roles: [{ id: 'r_empty', name: 'Empty Role', permission_ids: [] }],
      users: [{ id: 'u1', username: 'alex', role_ids: [] }],
    })
    await pom.userRow('alex').click()
    await expect(pom.sheet).toBeVisible()
    await expect(pom.sheet.getByText(/attach at least one role/i)).toBeVisible()
  })
})

test.describe('Bug #14 · admin dialogs need an accessible description', () => {
  function trackDescriptionWarnings(page: Page): string[] {
    const warnings: string[] = []
    page.on('console', (msg) => {
      if (/Missing `Description`|aria-describedby=\{undefined\}/.test(msg.text())) {
        warnings.push(msg.text())
      }
    })
    return warnings
  }

  test('New role dialog has a description', async ({ page }) => {
    const { pom } = await RolesPage.navigateTo(page, ROLES_SEED)
    const warnings = trackDescriptionWarnings(page)
    await pom.newButton.click()
    await expect(pom.newRoleNameInput).toBeVisible()
    await page.waitForTimeout(200)
    expect(warnings).toEqual([])
  })

  test('New permission dialog has a description', async ({ page }) => {
    const { pom } = await PermissionsPage.navigateTo(page, PERMS_SEED)
    const warnings = trackDescriptionWarnings(page)
    await pom.newButton.click()
    await expect(pom.dialogNameInput).toBeVisible()
    await page.waitForTimeout(200)
    expect(warnings).toEqual([])
  })

  test('Add user dialog has a description', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, ROLES_SEED)
    const warnings = trackDescriptionWarnings(page)
    await pom.addButton.click()
    await expect(pom.newUsernameInput).toBeVisible()
    await page.waitForTimeout(200)
    expect(warnings).toEqual([])
  })

  test('User drawer has a description', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, ROLES_SEED)
    const warnings = trackDescriptionWarnings(page)
    await pom.userRow('alex').click()
    await expect(pom.sheet).toBeVisible()
    await page.waitForTimeout(200)
    expect(warnings).toEqual([])
  })
})

test.describe('Bug #15/#16 · Add user dialog stays usable on the Users page', () => {
  test('Add user opens its dialog after the user drawer has been used', async ({ page }) => {
    const { pom } = await UsersPage.navigateTo(page, ROLES_SEED)
    // Exercise the drawer first, then dismiss it.
    await pom.userRow('alex').click()
    await expect(pom.sheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(pom.sheet).toBeHidden()
    // The page-level Add user button must still open its dialog.
    await pom.addButton.click()
    await expect(pom.newUsernameInput).toBeVisible()
  })

  test('Add user dialog accepts input and submits without wedging', async ({ page }) => {
    const { pom, store } = await UsersPage.navigateTo(page, ROLES_SEED)
    await pom.addButton.click()
    await expect(pom.newUsernameInput).toBeVisible()
    await pom.newUsernameInput.fill('jamie.tran')
    await pom.newUserSubmit.click()
    await expect(pom.sheet).toBeVisible()
    await expect(pom.sheet.getByText('jamie.tran', { exact: true })).toBeVisible()
    expect(store.listUsers().some((u) => u.username === 'jamie.tran')).toBe(true)
  })
})
