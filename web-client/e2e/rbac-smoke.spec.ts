import { test, expect } from '@playwright/test'
import { PermissionsPage } from './page-objects/rbac/permissions.page'
import { RolesPage } from './page-objects/rbac/roles.page'
import { UsersPage } from './page-objects/rbac/users.page'

const SEED = {
  permissions: [
    { id: 'p_tv', name: 'tournament.view' },
    { id: 'p_te', name: 'tournament.edit' },
  ],
  roles: [
    {
      id: 'r_td',
      name: 'Tournament Director',
      description: 'Runs events.',
      permission_ids: ['p_tv', 'p_te'],
    },
  ],
  users: [
    { id: 'u1', username: 'tim.nguyen', role_ids: ['r_td'] },
    { id: 'u2', username: 'alex.johansen', role_ids: [] },
  ],
}

test('roles page renders list and detail', async ({ page }) => {
  await RolesPage.navigateTo(page, SEED)
  await expect(page.getByText('Tournament Director').first()).toBeVisible()
  await expect(page.getByText('Permissions', { exact: false }).first()).toBeVisible()
})

test('permissions page renders groups', async ({ page }) => {
  await PermissionsPage.navigateTo(page, SEED)
  await expect(page.getByRole('heading', { name: 'Permissions', level: 1 })).toBeVisible()
  await expect(page.getByText('tournament.*')).toBeVisible()
  await expect(page.getByText('tournament.view').first()).toBeVisible()
})

test('users page renders table', async ({ page }) => {
  await UsersPage.navigateTo(page, SEED)
  await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible()
  await expect(page.getByText('tim.nguyen').first()).toBeVisible()
  await expect(page.getByText('alex.johansen').first()).toBeVisible()
})

test('sidebar shows administration sub-nav', async ({ page }) => {
  await RolesPage.navigateTo(page, SEED)
  const sidebar = page.locator('.app-shell__sidebar')
  await expect(sidebar.getByRole('link', { name: /Roles/ })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: /Permissions/ })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: /Users/ })).toBeVisible()
})

test('sub-nav navigates between admin pages', async ({ page }) => {
  await RolesPage.navigateTo(page, SEED)
  await page.locator('.app-shell__sidebar').getByRole('link', { name: /Permissions/ }).click()
  await page.waitForURL('**/admin/permissions')
  await expect(page.getByRole('heading', { name: 'Permissions', level: 1 })).toBeVisible()
  await page.locator('.app-shell__sidebar').getByRole('link', { name: /^Users$/ }).click()
  await page.waitForURL('**/admin/users')
  await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible()
})
