import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AdminPage, type AdminTab } from '../../test/pages/AdminPage'
import {
  administrator,
  builtInPermissions,
  failAdminOnce,
  holdAdmin,
  mockAdmin,
  type AdminList,
  type AdminState,
} from '../../test/server'

const viewer = {
  id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
  name: 'Viewer',
  description: 'Sees the admin page.',
  permissions: ['admin.view'],
}
const ann = {
  id: '0b9e3c1e-58f4-4c84-9a59-2d0b6f3f6a10',
  email: 'ann@example.com',
  display_name: 'excited egret 387',
  role_ids: [administrator.id],
}
const ben = {
  id: '6f5e4d3c-2b1a-4098-8f7e-6d5c4b3a2918',
  email: 'ben@example.com',
  display_name: 'brave badger 214',
  role_ids: [],
}
const gamesRecord = { key: 'games.record', description: 'Record a match.', built_in: false }

// Ann, signed in, is the administrator.
function admin(state: Partial<AdminState> = {}) {
  return mockAdmin({
    permissions: [...builtInPermissions, gamesRecord],
    roles: [administrator, viewer],
    accounts: [ann, ben],
    ...state,
  })
}

describe('the admin page', () => {
  it('is in the account menu only for an account with admin.view', async () => {
    admin()
    const page = await AdminPage.render()
    await page.user.click((await page.adminLink())!)
    expect(page.href).toBe('/admin')
  })

  it('isn’t in the account menu for a guest', async () => {
    const page = await AdminPage.render()
    expect(await page.adminLink()).toBeNull()
  })

  it('sends an account without admin.view to Home', async () => {
    admin({ accounts: [{ ...ann, role_ids: [] }] })
    const page = await AdminPage.render()
    expect(page.href).toBe('/')
    expect(page.title).toBeNull()
  })

  it('sends a guest to Home', async () => {
    expect((await AdminPage.render()).href).toBe('/')
  })

  const sections: { tab: AdminTab; list: AdminList; label: string; content: string }[] = [
    { tab: 'Roles', list: 'roles', label: 'Loading roles', content: 'Administrator' },
    { tab: 'Permissions', list: 'permissions', label: 'Loading permissions', content: 'games.record' },
    { tab: 'Accounts', list: 'accounts', label: 'Loading accounts', content: 'ben@example.com' },
  ]

  it.each(sections)('shows a skeleton while the $tab load', async ({ tab, list, label, content }) => {
    admin()
    const held = holdAdmin(list)
    const page = await AdminPage.render()
    await page.openTab(tab)
    expect(page.loading(label)).toBe(true)
    await held.release()
    expect(await page.findRow(content)).toBeInTheDocument()
    expect(page.loading(label)).toBe(false)
  })

  it.each(sections)('shows an error with Try again when the $tab fail', async ({ tab, list, content }) => {
    admin()
    failAdminOnce(list, 500)
    const page = await AdminPage.render()
    await page.openTab(tab)
    await waitFor(() => expect(page.loadError).toHaveTextContent('Something went wrong'))
    expect(page.title).toBeInTheDocument()
    await page.tryAgain()
    expect(await page.findRow(content)).toBeInTheDocument()
  })
})

describe('roles', () => {
  it('lists each role with its permissions and holders', async () => {
    admin()
    const page = await AdminPage.render()
    await page.findRow('Administrator')
    expect(page.rows).toEqual([
      [
        'AdministratorEverything on the admin page.',
        'account_roles.manageadmin.viewroles.manage',
        '1',
        'EditDelete…',
      ],
      ['ViewerSees the admin page.', 'admin.view', '0', 'EditDelete…'],
    ])
  })

  it('checks a new role before it sends it, then creates it', async () => {
    const api = admin()
    const page = await AdminPage.render()
    await page.click('New role')
    const sheet = page.dialog('New role')!

    await page.press(sheet, 'Create role')
    expect(page.field(sheet, 'Name')).toHaveAccessibleDescription('Enter a name.')
    expect(page.field(sheet, 'Name')).toHaveAttribute('aria-invalid', 'true')

    await page.type(sheet, 'Name', 'x'.repeat(51))
    await page.press(sheet, 'Create role')
    expect(page.field(sheet, 'Name')).toHaveAccessibleDescription('Use 50 characters or fewer.')
    expect(api.writes).toEqual([])

    await page.type(sheet, 'Name', '  Umpire ')
    await page.toggle(sheet, 'games.record')
    await page.press(sheet, 'Create role')

    expect(await page.findToast('Role created')).toBeInTheDocument()
    expect(api.writes).toEqual([
      {
        method: 'POST',
        path: '/v1/admin/roles',
        body: { name: 'Umpire', description: '', permissions: ['games.record'] },
      },
    ])
    expect(page.dialog('New role')).toBeNull()
    expect(await page.findRow('Umpire')).toHaveTextContent('games.record')
  })

  it('puts a name that another tab took on the name field', async () => {
    const api = admin()
    const page = await AdminPage.render()
    await page.click('New role')
    api.state.roles.push({ id: crypto.randomUUID(), name: 'Umpire', description: '', permissions: [] })
    const sheet = page.dialog('New role')!
    await page.type(sheet, 'Name', 'umpire')
    await page.press(sheet, 'Create role')

    await waitFor(() =>
      expect(page.field(sheet, 'Name')).toHaveAccessibleDescription(
        'Another role has this name. Choose another.',
      ),
    )
    expect(page.dialog('New role')).toBeInTheDocument()
  })

  it('says why it can’t take the last permission to grant roles', async () => {
    admin()
    const page = await AdminPage.render()
    await page.click('Edit Administrator')
    const sheet = page.dialog('Edit Administrator')!
    await page.toggle(sheet, 'account_roles.manage')
    await page.press(sheet, 'Save role')

    await waitFor(() =>
      expect(sheet).toHaveTextContent('At least one account must keep the permission to grant roles'),
    )
    expect(page.dialog('Edit Administrator')).toBeInTheDocument()
  })

  it('deletes a role after it asks', async () => {
    const api = admin()
    const page = await AdminPage.render()
    await page.click('Delete Viewer')
    await page.press(page.dialog('Delete Viewer?')!, 'Delete role')

    expect(await page.findToast('Role deleted')).toBeInTheDocument()
    expect(api.writes).toEqual([{ method: 'DELETE', path: `/v1/admin/roles/${viewer.id}`, body: null }])
    expect(page.rows.map(([name]) => name)).toEqual(['AdministratorEverything on the admin page.'])
  })

  it('refuses to delete the last role that grants roles', async () => {
    admin()
    const page = await AdminPage.render()
    await page.click('Delete Administrator')
    const dialog = page.dialog('Delete Administrator?')!
    await page.press(dialog, 'Delete role')
    await waitFor(() =>
      expect(dialog).toHaveTextContent('At least one account must keep the permission to grant roles'),
    )
  })
})

describe('permissions', () => {
  it('offers no delete for a built-in permission', async () => {
    admin()
    const page = await AdminPage.render()
    await page.openTab('Permissions')
    await page.findRow('games.record')
    expect(page.button('Edit admin.view')).toBeInTheDocument()
    expect(page.button('Delete admin.view')).toBeNull()
    expect(page.button('Delete games.record')).toBeInTheDocument()
  })

  it('deletes a permission after it asks', async () => {
    const api = admin()
    const page = await AdminPage.render()
    await page.openTab('Permissions')
    await page.findRow('games.record')
    await page.click('Delete games.record')
    await page.press(page.dialog('Delete games.record?')!, 'Delete permission')

    expect(await page.findToast('Permission deleted')).toBeInTheDocument()
    expect(api.writes).toEqual([
      { method: 'DELETE', path: '/v1/admin/permissions/games.record', body: null },
    ])
    expect(page.button('Delete games.record')).toBeNull()
  })

  it('checks a new key before it sends it, and puts a taken key on its field', async () => {
    const api = admin()
    const page = await AdminPage.render()
    await page.openTab('Permissions')
    await page.click('New permission')
    const sheet = page.dialog('New permission')!

    await page.type(sheet, 'Key', 'Games.Record')
    await page.press(sheet, 'Create permission')
    expect(page.field(sheet, 'Key')).toHaveAccessibleDescription(
      expect.stringContaining('Use lowercase words of letters, digits and _, joined by dots'),
    )
    expect(api.writes).toEqual([])

    await page.type(sheet, 'Key', 'games.record')
    await page.press(sheet, 'Create permission')
    await waitFor(() =>
      expect(page.field(sheet, 'Key')).toHaveAccessibleDescription(
        expect.stringContaining('Another permission has this key.'),
      ),
    )
  })

  it('creates a permission', async () => {
    const api = admin()
    const page = await AdminPage.render()
    await page.openTab('Permissions')
    await page.click('New permission')
    const sheet = page.dialog('New permission')!
    await page.type(sheet, 'Key', 'leagues.run')
    await page.type(sheet, 'Description', 'Run a league.')
    await page.press(sheet, 'Create permission')

    expect(await page.findToast('Permission created')).toBeInTheDocument()
    expect(api.writes).toEqual([
      {
        method: 'POST',
        path: '/v1/admin/permissions',
        body: { key: 'leagues.run', description: 'Run a league.' },
      },
    ])
    expect(await page.findRow('leagues.run')).toBeInTheDocument()
  })
})

describe('accounts', () => {
  it('links each account to its own page', async () => {
    admin()
    const page = await AdminPage.render()
    await page.openTab('Accounts')
    await page.findRow('ben@example.com')
    await page.follow('ben@example.com')
    expect(page.href).toBe(`/admin/accounts/${ben.id}`)
    expect(await page.findHeading('ben@example.com')).toBeInTheDocument()
  })

  it('finds accounts by email', async () => {
    admin()
    const page = await AdminPage.render()
    await page.openTab('Accounts')
    await page.findRow('ann@example.com')
    await page.search('BEN')
    await waitFor(() => expect(page.rows.map(([email]) => email)).toEqual(['ben@example.com']))
  })

  it('says when it shows only the first 50', async () => {
    const many = Array.from({ length: 51 }, (_, index) => ({
      id: crypto.randomUUID(),
      email: `player${index}@example.com`,
      display_name: `player ${index}`,
      role_ids: [],
    }))
    admin({ accounts: [ann, ...many] })
    const page = await AdminPage.render()
    await page.openTab('Accounts')
    await page.findRow('ann@example.com')
    expect(page.panel).toHaveTextContent('Showing the first 50.')
  })
})

describe('an account’s page', () => {
  it('shows who the account is', async () => {
    admin()
    const page = await AdminPage.renderAccount(ben.id)
    await page.findHeading('ben@example.com')
    expect(document.body).toHaveTextContent('Playerbrave badger 214')
    expect(document.body).toHaveTextContent('Joined')
    expect(document.body).toHaveTextContent('Last seen')
  })

  it('sets the roles the account holds', async () => {
    const api = admin()
    const page = await AdminPage.renderAccount(ben.id)
    await page.findHeading('ben@example.com')
    await page.toggle(page.rolesCard, 'Viewer')
    await page.press(page.rolesCard, 'Save roles')

    expect(await page.findToast('Roles saved for ben@example.com')).toBeInTheDocument()
    expect(api.writes).toEqual([
      { method: 'PUT', path: `/v1/admin/accounts/${ben.id}/roles`, body: { role_ids: [viewer.id] } },
    ])
    expect(api.state.accounts[1].role_ids).toEqual([viewer.id])
    expect(within(page.rolesCard).getByRole('checkbox', { name: /^Viewer/ })).toBeChecked()
  })

  it('says why the last administrator keeps their role', async () => {
    admin()
    const page = await AdminPage.renderAccount(ann.id)
    await page.findHeading('ann@example.com')
    await page.toggle(page.rolesCard, 'Administrator')
    await page.press(page.rolesCard, 'Save roles')
    await waitFor(() =>
      expect(page.rolesCard).toHaveTextContent(
        'At least one account must keep the permission to grant roles',
      ),
    )
  })

  it('sends a visitor who takes admin.view from themselves to Home', async () => {
    const granter = {
      id: 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f',
      name: 'Granter',
      description: '',
      permissions: ['account_roles.manage'],
    }
    admin({
      roles: [administrator, viewer, granter],
      accounts: [{ ...ann, role_ids: [viewer.id, granter.id] }, ben],
    })
    const page = await AdminPage.renderAccount(ann.id)
    await page.findHeading('ann@example.com')
    await page.toggle(page.rolesCard, 'Viewer')
    await page.press(page.rolesCard, 'Save roles')

    await waitFor(() => expect(page.href).toBe('/'))
    expect(await page.adminLink()).toBeNull()
  })

  it('goes back to the Accounts tab', async () => {
    admin()
    const page = await AdminPage.renderAccount(ben.id)
    await page.findHeading('ben@example.com')
    await page.follow('Accounts')
    expect(page.href).toBe('/admin?tab=accounts')
    expect(page.selectedTab).toBe('Accounts')
    expect(await page.findRow('ben@example.com')).toBeInTheDocument()
  })

  it('keeps the open tab in the URL', async () => {
    admin()
    const page = await AdminPage.render()
    await page.openTab('Permissions')
    expect(page.href).toBe('/admin?tab=permissions')
  })

  it('opens Roles for a tab it doesn’t know', async () => {
    admin()
    const page = await AdminPage.render('/admin?tab=bogus')
    expect(page.selectedTab).toBe('Roles')
    expect(await page.findRow('Administrator')).toBeInTheDocument()
  })

  it('says when no verified account has the id', async () => {
    admin()
    const page = await AdminPage.renderAccount(crypto.randomUUID())
    expect(await page.findHeading('No such account')).toBeInTheDocument()
  })

  it('shows a skeleton while the account loads', async () => {
    admin()
    const held = holdAdmin(`accounts/${ben.id}`)
    const page = await AdminPage.render(`/admin/accounts/${ben.id}`)
    expect(document.body).toHaveTextContent('Loading account')
    await held.release()
    expect(await page.findHeading('ben@example.com')).toBeInTheDocument()
  })

  it('shows an error with Try again when the account fails', async () => {
    admin()
    failAdminOnce(`accounts/${ben.id}`, 500)
    const page = await AdminPage.renderAccount(ben.id)
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong'),
    )
    expect(screen.getByRole('link', { name: 'Accounts' })).toBeInTheDocument()
    await page.user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await page.findHeading('ben@example.com')).toBeInTheDocument()
  })
})

describe('an account with only admin.view', () => {
  it('sees every list, with no controls that change them', async () => {
    admin({ accounts: [{ ...ann, role_ids: [viewer.id] }, { ...ben, role_ids: [administrator.id] }] })
    const page = await AdminPage.render()
    await page.findRow('Administrator')
    expect(page.button('New role')).toBeNull()
    expect(page.button('Edit Administrator')).toBeNull()

    await page.openTab('Permissions')
    await page.findRow('games.record')
    expect(page.button('New permission')).toBeNull()
    expect(page.button('Edit games.record')).toBeNull()
  })

  it('sees an account’s roles, with no way to change them', async () => {
    admin({ accounts: [{ ...ann, role_ids: [viewer.id] }, { ...ben, role_ids: [administrator.id] }] })
    const page = await AdminPage.renderAccount(ben.id)
    await page.findHeading('ben@example.com')
    expect(page.rolesCard).toHaveTextContent('Administrator')
    expect(page.rolesCard).not.toHaveTextContent('Viewer')
    expect(within(page.rolesCard).queryByRole('checkbox')).toBeNull()
    expect(within(page.rolesCard).queryByRole('button', { name: 'Save roles' })).toBeNull()
  })
})
