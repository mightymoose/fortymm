import { http, HttpResponse } from 'msw'
import { screen, waitFor } from '@/test/utilities'
import { server } from '@/mocks/server'
import { rolesPage } from './roles-page.page'
import { DEFAULT_ROLE_ID, PERM_VIEW, buildRolesSeed } from './roles-page.factory'

// ADR-0016: one role — `User` — is held by every account on the platform. The
// API refuses to delete or rename it (400), so the page must not offer either.
// Everything else about it, above all its permissions, stays editable: ticking a
// permission onto this role is how an admin grants a capability to everyone.
describe('RolesPage — the default role', () => {
  it('badges the default role, and only it', async () => {
    rolesPage.render()

    const defaultRow = await rolesPage.findRoleRow('User')
    const plainRow = await rolesPage.findRoleRow('Owner')

    expect(rolesPage.within(defaultRow).queryDefaultBadge()).toBeInTheDocument()
    expect(rolesPage.within(plainRow).queryDefaultBadge()).not.toBeInTheDocument()
  })

  it('badges it in the detail panel too, so a selected role reads as special', async () => {
    rolesPage.render()

    const detail = await rolesPage.select('User')

    expect(rolesPage.within(detail).queryDefaultBadge()).toBeInTheDocument()
  })

  it('disables Delete and says why', async () => {
    rolesPage.render()

    const detail = await rolesPage.select('User')
    const scope = rolesPage.within(detail)

    expect(await scope.findDeleteButton()).toBeDisabled()
    // The tooltip hangs off a wrapper: a disabled button is pointer-events-none,
    // so its own `title` would never surface on hover.
    expect(scope.queryTooltip(/held by everyone on the platform and can't be deleted/i)).toBeInTheDocument()
  })

  it('locks the name field in the edit modal and says why', async () => {
    const user = rolesPage.user()
    rolesPage.render()

    const detail = await rolesPage.select('User')
    await user.click(await rolesPage.within(detail).findEditButton())

    expect(await rolesPage.findNameInput()).toBeDisabled()
    expect(rolesPage.queryTooltip(/can't be renamed/i)).toBeInTheDocument()
    // The description is the one field on this role a rename guard must not touch.
    expect(await rolesPage.findDescriptionInput()).toBeEnabled()
  })

  it('still saves a description edit — the rename guard must not swallow the whole form', async () => {
    const user = rolesPage.user()
    const state = rolesPage.render()

    const detail = await rolesPage.select('User')
    await user.click(await rolesPage.within(detail).findEditButton())

    const description = await rolesPage.findDescriptionInput()
    await user.clear(description)
    await user.type(description, 'Everyone gets this.')
    await user.click(await rolesPage.findSaveButton())

    // The modal closes only on success, so its absence *is* the success signal.
    await waitFor(() => {
      expect(state.roles.get(DEFAULT_ROLE_ID)?.description).toBe('Everyone gets this.')
    })
    await waitFor(() => {
      expect(rolesPage.queryNameInput()).not.toBeInTheDocument()
    })
    expect(state.roles.get(DEFAULT_ROLE_ID)?.name).toBe('User')
  })

  it('keeps its permission checkboxes interactive — that is the whole point of it', async () => {
    const user = rolesPage.user()
    const state = rolesPage.render()

    await rolesPage.select('User')
    const toggle = await rolesPage.findPermToggle('tournament.view')
    expect(toggle).toBeEnabled()

    await user.click(toggle)

    await waitFor(() => {
      expect(state.roles.get(DEFAULT_ROLE_ID)?.permission_ids).toContain(PERM_VIEW)
    })
    await waitFor(() => expect(toggle).toBeChecked())

    // …and untickable again.
    await user.click(toggle)
    await waitFor(() => {
      expect(state.roles.get(DEFAULT_ROLE_ID)?.permission_ids).not.toContain(PERM_VIEW)
    })
  })
})

describe('RolesPage — a role nobody special', () => {
  it('deletes as before: Delete is enabled and untooltipped', async () => {
    rolesPage.render()

    const detail = await rolesPage.select('Owner')
    const scope = rolesPage.within(detail)

    expect(await scope.findDeleteButton()).toBeEnabled()
    expect(scope.queryTooltip(/can't be deleted/i)).not.toBeInTheDocument()
    expect(scope.queryDefaultBadge()).not.toBeInTheDocument()
  })

  it('renames as before: the edit modal leaves the name field editable', async () => {
    const user = rolesPage.user()
    const state = rolesPage.render()

    const detail = await rolesPage.select('Owner')
    await user.click(await rolesPage.within(detail).findEditButton())

    const name = await rolesPage.findNameInput()
    expect(name).toBeEnabled()

    await user.clear(name)
    await user.type(name, 'Founder')
    await user.click(await rolesPage.findSaveButton())

    await waitFor(() => {
      expect(rolesPage.queryRoleRow('Founder')).toBeInTheDocument()
    })
    expect([...state.roles.values()].map((r) => r.name)).toContain('Founder')
  })

  it('renders a badgeless list when no default role exists at all', async () => {
    rolesPage.render(
      buildRolesSeed({
        roles: [{ id: 'r_only', name: 'Owner', permission_ids: [], is_default: false }],
      }),
    )

    await rolesPage.findRoleRow('Owner')

    expect(rolesPage.queryDefaultBadge()).not.toBeInTheDocument()
  })
})

// #937: a name the server rejects (a duplicate → 409, an over-long name → 422)
// must surface inline on the name field with the dialog left open — not vanish
// behind a global toast. The modal closes only on success.
describe('RolesPage — creating a role', () => {
  async function openCreateModal() {
    const user = rolesPage.user()
    await user.click(await rolesPage.findNewRoleButton())
    // The name input's presence is how a test knows the modal is open; its
    // later absence is the only success signal (the modal closes on success).
    await rolesPage.findNameInput()
    return user
  }

  it('creates a role from a valid name and closes the modal on success', async () => {
    const state = rolesPage.render()
    const user = await openCreateModal()

    await user.type(await rolesPage.findNameInput(), 'Volunteer scorer')
    await user.click(await rolesPage.findCreateButton())

    await waitFor(() => {
      expect([...state.roles.values()].map((r) => r.name)).toContain('Volunteer scorer')
    })
    await waitFor(() => {
      expect(rolesPage.queryNameInput()).not.toBeInTheDocument()
    })
  })

  it('surfaces a server 409 (duplicate) inline and keeps the dialog open', async () => {
    // `Owner` already exists in the seed, so the create hits the engine's real
    // 409 ("role name already exists") — no client-side refine short-circuits it.
    const state = rolesPage.render()
    const user = await openCreateModal()

    await user.type(await rolesPage.findNameInput(), 'Owner')
    await user.click(await rolesPage.findCreateButton())

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument()
    // Dialog stays open, and no phantom second `Owner` was persisted.
    expect(rolesPage.queryNameInput()).toBeInTheDocument()
    expect([...state.roles.values()].filter((r) => r.name === 'Owner')).toHaveLength(1)
  })

  it('surfaces a server 422 (too long) inline and keeps the dialog open', async () => {
    rolesPage.render()
    // A short name passes the client schema, so the POST fires and the server's
    // 422 detail is what surfaces inline — proving the catch handles it, not the
    // client-side max() rule.
    server.use(
      http.post('*/v1/roles', () =>
        HttpResponse.json({ detail: 'Role name exceeds the 255 character limit.' }, { status: 422 }),
      ),
    )
    const user = await openCreateModal()

    await user.type(await rolesPage.findNameInput(), 'Weekend crew')
    await user.click(await rolesPage.findCreateButton())

    expect(await screen.findByText(/exceeds the 255 character limit/i)).toBeInTheDocument()
    expect(rolesPage.queryNameInput()).toBeInTheDocument()
  })

  it('caps the name input length with maxLength', async () => {
    rolesPage.render()
    await openCreateModal()

    expect(await rolesPage.findNameInput()).toHaveAttribute('maxlength', '255')
  })

  it('blocks an empty submit inline without closing', async () => {
    rolesPage.render()
    const user = await openCreateModal()

    await user.click(await rolesPage.findCreateButton())

    expect(await screen.findByText(/name is required/i)).toBeInTheDocument()
    expect(rolesPage.queryNameInput()).toBeInTheDocument()
  })
})
