import { test, expect } from '@playwright/test'

test('roles page renders list and detail', async ({ page }) => {
  await page.goto('/admin/roles')
  await expect(page.getByText('Tournament Director').first()).toBeVisible()
  await expect(page.getByText('Permissions', { exact: false }).first()).toBeVisible()
})

test('permissions page renders groups', async ({ page }) => {
  await page.goto('/admin/permissions')
  await expect(page.getByRole('heading', { name: 'Permissions', level: 1 })).toBeVisible()
  await expect(page.getByText('tournament.*')).toBeVisible()
  await expect(page.getByText('tournament.view').first()).toBeVisible()
})

test('users page renders table', async ({ page }) => {
  await page.goto('/admin/users')
  await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible()
  await expect(page.getByText('tim.nguyen').first()).toBeVisible()
  await expect(page.getByText('alex.johansen').first()).toBeVisible()
})

test('sidebar shows administration sub-nav', async ({ page }) => {
  await page.goto('/admin/roles')
  // Sub-nav items: Roles / Permissions / Users (sidebar)
  const sidebar = page.locator('.app-shell__sidebar')
  await expect(sidebar.getByRole('link', { name: /Roles/ })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: /Permissions/ })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: /Users/ })).toBeVisible()
})

test('sub-nav navigates between admin pages', async ({ page }) => {
  await page.goto('/admin/roles')
  await page.locator('.app-shell__sidebar').getByRole('link', { name: /Permissions/ }).click()
  await page.waitForURL('**/admin/permissions')
  await expect(page.getByRole('heading', { name: 'Permissions', level: 1 })).toBeVisible()
  await page.locator('.app-shell__sidebar').getByRole('link', { name: /^Users$/ }).click()
  await page.waitForURL('**/admin/users')
  await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible()
})
