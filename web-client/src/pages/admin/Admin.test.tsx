import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { AdminPlayerDetail, AdminSigningKey } from '../../api/queries'
import { AdminPage, type AdminTab } from '../../test/pages/AdminPage'
import { HomePage } from '../../test/pages/HomePage'
import {
  administrator,
  API_BASE_URL,
  builtInPermissions,
  failAdminOnce,
  holdAdmin,
  mockAdmin,
  server,
  userRole,
  type AdminList,
  type AdminState,
} from '../../test/server'

const viewer = {
  id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
  name: 'Viewer',
  description: 'Sees the admin page.',
  permissions: ['admin.view'],
  default: false,
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
const guest = { id: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', email: null, display_name: 'curious crane 512' }

function signingKey(
  digit: string,
  label: string,
  { id, email, display_name }: AdminSigningKey['account'],
  changes: Partial<AdminSigningKey> = {},
): AdminSigningKey {
  return {
    id: digit.repeat(64),
    label,
    created_at: '2026-11-02T12:00:00Z',
    state: 'live',
    signed_out_at: null,
    revoked_at: null,
    revoked_by: null,
    revoked_by_email: null,
    account: { id, email, display_name },
    ...changes,
  }
}
const annsPhone = signingKey('a', 'Ann’s iPhone', ann)
const guestsBrowser = signingKey('b', 'Web browser', guest)
const bensLaptop = signingKey('c', 'Ben’s laptop', ben, {
  state: 'signed_out',
  signed_out_at: '2026-11-02T13:00:00Z',
})
const bensPhone = signingKey('d', 'Ben’s phone', ben, {
  state: 'revoked',
  revoked_at: '2026-11-02T14:00:00Z',
  revoked_by: ann.id,
  revoked_by_email: ann.email,
})
const guestsOldBrowser = signingKey('e', 'Old browser', guest, {
  state: 'revoked',
  revoked_at: '2026-11-02T14:00:00Z',
  revoked_by: guest.id,
})

// Ann's own player, which Ben manages too.
const excitedEgret: AdminPlayerDetail = {
  id: '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a',
  display_name: 'excited egret 387',
  created_at: '2026-03-14T09:30:00Z',
  merged_into: null,
  merged_into_display_name: null,
  match_count: 4,
  managers: [
    { id: ann.id, email: ann.email, relationship: 'self', open_question: false },
    { id: ben.id, email: ben.email, relationship: 'managed', open_question: true },
  ],
  leagues: ['FortyMM'],
}
// A guest's player.
const curiousCrane: AdminPlayerDetail = {
  ...excitedEgret,
  id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
  display_name: 'curious crane 512',
  match_count: 0,
  managers: [{ id: guest.id, email: null, relationship: 'self', open_question: false }],
}
// A player that merged into Ann's.
const oldEgret: AdminPlayerDetail = {
  ...excitedEgret,
  id: 'e5f4d3c2-b1a0-4f9e-8d7c-6b5a49382716',
  display_name: 'early egret 101',
  merged_into: excitedEgret.id,
  merged_into_display_name: excitedEgret.display_name,
  managers: [],
}

// Ann, signed in, is the administrator.
function admin(state: Partial<AdminState> = {}) {
  return mockAdmin({
    permissions: [...builtInPermissions, gamesRecord],
    roles: [administrator, userRole, viewer],
    accounts: [ann, ben],
    signingKeys: [annsPhone, guestsBrowser, bensLaptop, bensPhone, guestsOldBrowser],
    players: [excitedEgret, curiousCrane, oldEgret],
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

  it('gives an account the permissions of the default role it holds', async () => {
    admin({
      roles: [administrator, { ...userRole, permissions: ['matches.create'] }],
      accounts: [{ ...ann, role_ids: [userRole.id] }, { ...ben, role_ids: [administrator.id] }],
    })
    const home = await HomePage.render()
    expect(home.newMatchLink).toBeInTheDocument()
  })

  it('sends a guest to Home', async () => {
    expect((await AdminPage.render()).href).toBe('/')
  })

  const sections: { tab: AdminTab; list: AdminList; label: string; content: string }[] = [
    { tab: 'Roles', list: 'roles', label: 'Loading roles', content: 'Administrator' },
    { tab: 'Permissions', list: 'permissions', label: 'Loading permissions', content: 'games.record' },
    { tab: 'Accounts', list: 'accounts', label: 'Loading accounts', content: 'ben@example.com' },
    { tab: 'Players', list: 'players', label: 'Loading players', content: 'excited egret 387' },
    { tab: 'Signing keys', list: 'signing-keys', label: 'Loading signing keys', content: 'Ann’s iPhone' },
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
        'account_roles.manageadmin.viewmatches.creatematches.viewplayers.viewroles.managesigning_keys.revoke',
        '1',
        'EditDelete…',
      ],
      ['UserDefaultEvery new account gets this role, guests too.', 'None', '0', 'EditDelete…'],
      ['ViewerSees the admin page.', 'admin.view', '0', 'EditDelete…'],
    ])
  })

  it('offers the default role every permission', async () => {
    const api = admin()
    const page = await AdminPage.render()
    await page.click('Edit User')
    const sheet = page.dialog('Edit User')!
    expect(
      within(sheet)
        .getAllByRole('checkbox')
        .map((box) => box.getAttribute('value')),
    ).toEqual([...builtInPermissions.map((permission) => permission.key), 'games.record'])

    await page.toggle(sheet, 'games.record')
    await page.press(sheet, 'Save role')

    expect(await page.findToast('Role saved')).toBeInTheDocument()
    expect(api.writes).toEqual([
      {
        method: 'PUT',
        path: `/v1/admin/roles/${userRole.id}`,
        body: {
          name: 'User',
          description: 'Every new account gets this role, guests too.',
          permissions: ['games.record'],
        },
      },
    ])
    expect(await page.findRow('User')).toHaveTextContent('games.record')
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
    api.state.roles.push({
      id: crypto.randomUUID(),
      name: 'Umpire',
      description: '',
      permissions: [],
      default: false,
    })
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
    expect(page.rows.map(([name]) => name)).toEqual([
      'AdministratorEverything on the admin page.',
      'UserDefaultEvery new account gets this role, guests too.',
    ])
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

describe('players', () => {
  it('lists each player with the account that plays as it, but no merged player', async () => {
    admin()
    const page = await AdminPage.render()
    await page.openTab('Players')
    await page.findRow('curious crane 512')
    expect(page.rows).toEqual([
      ['curious crane 512', 'Guest', '1'],
      ['excited egret 387', 'ann@example.com', '2'],
    ])
    expect(within(page.panel).getByRole('link', { name: 'ann@example.com' })).toHaveAttribute(
      'href',
      `/admin/accounts/${ann.id}`,
    )
  })

  it('finds players by name', async () => {
    admin()
    const page = await AdminPage.render()
    await page.openTab('Players')
    await page.findRow('curious crane 512')
    await page.searchPlayers('EGRET')
    await waitFor(() => expect(page.rows.map(([name]) => name)).toEqual(['excited egret 387']))
  })

  it('says when no player matches', async () => {
    admin()
    const page = await AdminPage.render()
    await page.openTab('Players')
    await page.findRow('curious crane 512')
    await page.searchPlayers('zebra')
    expect(await within(page.panel).findByText('No players match')).toBeInTheDocument()
  })

  it('says when it shows only the first 50', async () => {
    const many = Array.from({ length: 51 }, (_, index) => ({
      ...curiousCrane,
      id: crypto.randomUUID(),
      display_name: `player ${index}`,
    }))
    admin({ players: many })
    const page = await AdminPage.render()
    await page.openTab('Players')
    await page.findRow('player 0')
    expect(page.panel).toHaveTextContent('Showing the first 50.')
  })

  it('links each player to its own page', async () => {
    admin()
    const page = await AdminPage.render('/admin?tab=players')
    await page.findRow('excited egret 387')
    await page.follow('excited egret 387')
    expect(page.href).toBe(`/admin/players/${excitedEgret.id}`)
    expect(await page.findHeading('excited egret 387')).toBeInTheDocument()
  })
})

describe('a player’s page', () => {
  it('shows the player, its leagues and its matches', async () => {
    admin()
    const page = await AdminPage.renderPlayer(excitedEgret.id)
    await page.findHeading('excited egret 387')
    expect(document.body).toHaveTextContent('Matches4')
    expect(document.body).toHaveTextContent('LeaguesFortyMM')
    expect(document.body).toHaveTextContent('Added')
  })

  it('lists the accounts that play as it or manage it', async () => {
    admin()
    const page = await AdminPage.renderPlayer(excitedEgret.id)
    await page.findHeading('excited egret 387')
    const items = within(page.accountsCard).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'ann@example.comPlays as',
      'ben@example.comManagesHasn’t answered “Is this you?”',
    ])
    await page.follow('ben@example.com')
    expect(page.href).toBe(`/admin/accounts/${ben.id}`)
  })

  it('names a guest that plays as it', async () => {
    admin()
    const page = await AdminPage.renderPlayer(curiousCrane.id)
    await page.findHeading('curious crane 512')
    expect(page.accountsCard).toHaveTextContent('GuestPlays as')
    expect(within(page.accountsCard).queryByRole('link')).toBeNull()
  })

  it('links a merged player to the one it merged into', async () => {
    admin()
    const page = await AdminPage.renderPlayer(oldEgret.id)
    await page.findHeading('early egret 101')
    expect(page.accountsCard).toHaveTextContent('No account plays as this player or manages it.')
    await page.follow('excited egret 387')
    expect(await page.findHeading('excited egret 387')).toBeInTheDocument()
  })

  it('goes back to the Players tab', async () => {
    admin()
    const page = await AdminPage.renderPlayer(excitedEgret.id)
    await page.findHeading('excited egret 387')
    await page.follow('Players')
    expect(page.href).toBe('/admin?tab=players')
    expect(page.selectedTab).toBe('Players')
    expect(await page.findRow('excited egret 387')).toBeInTheDocument()
  })

  it('says when no player has the id', async () => {
    admin()
    const page = await AdminPage.renderPlayer(crypto.randomUUID())
    expect(await page.findHeading('No such player')).toBeInTheDocument()
  })

  it('shows a skeleton while the player loads', async () => {
    admin()
    const held = holdAdmin(`players/${excitedEgret.id}`)
    const page = await AdminPage.renderPlayer(excitedEgret.id)
    expect(document.body).toHaveTextContent('Loading player')
    await held.release()
    expect(await page.findHeading('excited egret 387')).toBeInTheDocument()
  })

  it('shows an error with Try again when the player fails', async () => {
    admin()
    failAdminOnce(`players/${excitedEgret.id}`, 500)
    const page = await AdminPage.renderPlayer(excitedEgret.id)
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong'),
    )
    expect(screen.getByRole('link', { name: 'Players' })).toBeInTheDocument()
    await page.user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await page.findHeading('excited egret 387')).toBeInTheDocument()
  })
})

describe('signing keys', () => {
  async function openSigningKeys(state: Partial<AdminState> = {}) {
    const api = admin(state)
    const page = await AdminPage.render()
    await page.openTab('Signing keys')
    await page.findRow('Ann’s iPhone')
    return { api, page }
  }

  it('lists each key with its device, account and state', async () => {
    const { page } = await openSigningKeys()
    expect(page.rows.map(([device, account, , state]) => [device, account, state])).toEqual([
      ['Ann’s iPhoneaaaaaaaa…', 'ann@example.comexcited egret 387', 'Live'],
      ['Web browserbbbbbbbb…', 'Guestcurious crane 512', 'Live'],
      ['Ben’s laptopcccccccc…', 'ben@example.combrave badger 214', expect.stringMatching(/^Signed out/)],
      ['Ben’s phonedddddddd…', 'ben@example.combrave badger 214', expect.stringMatching(/^Revoked.* by ann@example\.com$/)],
      ['Old browsereeeeeeee…', 'Guestcurious crane 512', expect.stringMatching(/^Revoked.* by the owner$/)],
    ])
    const [bensLink] = within(page.panel).getAllByRole('link', { name: 'ben@example.com' })
    expect(bensLink).toHaveAttribute('href', `/admin/accounts/${ben.id}`)
  })

  it('finds keys by part of an account’s email or player name', async () => {
    const { page } = await openSigningKeys()
    await page.searchKeys('CRANE')
    await waitFor(() =>
      expect(page.rows.map(([device]) => device)).toEqual(['Web browserbbbbbbbb…', 'Old browsereeeeeeee…']),
    )
    await page.searchKeys('ben@')
    await waitFor(() =>
      expect(page.rows.map(([device]) => device)).toEqual(['Ben’s laptopcccccccc…', 'Ben’s phonedddddddd…']),
    )
  })

  it('says when no key matches', async () => {
    const { page } = await openSigningKeys()
    await page.searchKeys('nobody')
    await waitFor(() => expect(page.panel).toHaveTextContent('No signing keys match'))
  })

  it('says when it shows only the newest 50', async () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      signingKey('f', 'Web browser', guest, { id: index.toString(16).padStart(64, '0') }),
    )
    const { page } = await openSigningKeys({ signingKeys: [annsPhone, ...many] })
    expect(page.panel).toHaveTextContent('Showing the newest 50.')
  })

  it('revokes a key after it asks', async () => {
    const { api, page } = await openSigningKeys()
    await page.click('Revoke key cccccccc')
    const dialog = page.dialog('Revoke this signing key?')!
    for (const text of [
      'Ben’s laptop',
      'ben@example.com',
      'brave badger 214',
      'FortyMM will refuse every result this key signs from now on, and every result it signed that hasn’t reached FortyMM yet. Results FortyMM already has stay as they are.',
      'The device stays signed in. The next time it opens FortyMM online, it makes a new key.',
      'This can’t be undone.',
    ]) {
      expect(dialog).toHaveTextContent(text)
    }
    await page.press(dialog, 'Revoke key')

    expect(await page.findToast('Signing key revoked')).toBeInTheDocument()
    expect(api.writes).toEqual([
      { method: 'POST', path: `/v1/admin/signing-keys/${bensLaptop.id}/revoke`, body: null },
    ])
    expect(page.rows[2][3]).toMatch(/^Revoked.* by ann@example\.com$/)
    expect(page.button('Revoke key cccccccc')).toBeNull()
  })

  it('names a guest’s account in the dialog', async () => {
    const { page } = await openSigningKeys()
    await page.click('Revoke key bbbbbbbb')
    const dialog = page.dialog('Revoke this signing key?')!
    expect(dialog).toHaveTextContent('Guest')
    expect(dialog).toHaveTextContent('curious crane 512')
  })

  it('reads Revoking… while the revoke is in flight', async () => {
    const { page } = await openSigningKeys()
    let release = () => {}
    server.use(
      http.post(
        `${API_BASE_URL}/v1/admin/signing-keys/:id/revoke`,
        () => new Promise<Response>((resolve) => {
          release = () => resolve(HttpResponse.json({ data: annsPhone }))
        }),
      ),
    )
    await page.click('Revoke key aaaaaaaa')
    const dialog = page.dialog('Revoke this signing key?')!
    await page.press(dialog, 'Revoke key')
    expect(within(dialog).getByRole('button', { name: 'Revoking…' })).toBeDisabled()
    release()
    expect(await page.findToast('Signing key revoked')).toBeInTheDocument()
  })

  it('sends nothing when the visitor keeps the key', async () => {
    const { api, page } = await openSigningKeys()
    await page.click('Revoke key aaaaaaaa')
    await page.press(page.dialog('Revoke this signing key?')!, 'Keep')
    await waitFor(() => expect(page.dialog('Revoke this signing key?')).toBeNull())
    expect(api.writes).toEqual([])
  })

  it('says why a revoke failed and keeps the dialog open', async () => {
    const { api, page } = await openSigningKeys()
    await page.click('Revoke key aaaaaaaa')
    api.state.signingKeys = []
    const dialog = page.dialog('Revoke this signing key?')!
    await page.press(dialog, 'Revoke key')
    await waitFor(() => expect(dialog).toHaveTextContent('No key has this id'))
    expect(page.dialog('Revoke this signing key?')).toBeInTheDocument()
  })

  it('offers no revoke for a revoked key', async () => {
    const { page } = await openSigningKeys()
    expect(page.button('Revoke key cccccccc')).toBeInTheDocument()
    expect(page.button('Revoke key dddddddd')).toBeNull()
    expect(page.button('Revoke key eeeeeeee')).toBeNull()
  })

  it('opens from the URL', async () => {
    admin()
    const page = await AdminPage.render('/admin?tab=signing-keys')
    expect(page.selectedTab).toBe('Signing keys')
    expect(await page.findRow('Ann’s iPhone')).toBeInTheDocument()
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

  it('offers the default role like any other', async () => {
    const api = admin()
    const page = await AdminPage.renderAccount(ben.id)
    await page.findHeading('ben@example.com')
    expect(
      within(page.rolesCard)
        .getAllByRole('checkbox')
        .map((box) => box.getAttribute('value')),
    ).toEqual([administrator.id, userRole.id, viewer.id])

    await page.toggle(page.rolesCard, 'User')
    await page.press(page.rolesCard, 'Save roles')

    expect(await page.findToast('Roles saved for ben@example.com')).toBeInTheDocument()
    expect(api.writes).toEqual([
      { method: 'PUT', path: `/v1/admin/accounts/${ben.id}/roles`, body: { role_ids: [userRole.id] } },
    ])
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
      default: false,
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

  it('sees every signing key, with no way to revoke one', async () => {
    admin({ accounts: [{ ...ann, role_ids: [viewer.id] }, { ...ben, role_ids: [administrator.id] }] })
    const page = await AdminPage.render()
    await page.openTab('Signing keys')
    await page.findRow('Ann’s iPhone')
    expect(page.rows).toHaveLength(5)
    expect(within(page.panel).queryByRole('button', { name: /^Revoke key/ })).toBeNull()
    expect(within(page.panel).queryByText('Actions')).toBeNull()
  })
})
