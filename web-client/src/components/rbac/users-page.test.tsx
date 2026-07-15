import { waitFor } from '@/test/utilities'
import { mockSession } from '@/mocks/handlers'
import { usersPage } from './users-page.page'
import { DEFAULT_ROLE_ID, PLAIN_ROLE_ID, USER_ID } from './users-page.factory'

// ADR-0016: `User` is held by every account on the platform. A full-replace
// PUT could otherwise strip it from one user, so the per-user editor disables
// that one checkbox up front (the Roles page disables Delete on the same role)
// while every other role stays freely assignable.
describe('UsersPage — the default role in the assignment editor', () => {
  it('renders the default role checked and disabled, with a tooltip', async () => {
    usersPage.render()

    await usersPage.open('eun.han')

    const checkbox = await usersPage.findRoleCheckbox('User')
    expect(checkbox).toBeChecked()
    expect(checkbox).toBeDisabled()
    // The tooltip hangs off a wrapper span: a disabled checkbox is
    // pointer-events-none, so its own `title` would never surface on hover.
    expect(
      usersPage.queryTooltip(/held by everyone on the platform and can't be removed/i),
    ).toBeInTheDocument()
  })

  it('leaves a non-default role fully interactive and saves it', async () => {
    const user = usersPage.user()
    const state = usersPage.render()

    await usersPage.open('eun.han')

    const owner = await usersPage.findRoleCheckbox('Owner')
    expect(owner).toBeEnabled()
    expect(owner).not.toBeChecked()

    await user.click(owner)
    await user.click(await usersPage.findSaveButton())

    // The save persists both the newly-ticked role and the retained default —
    // the disabled checkbox keeps it selected, and the mock backstops it too.
    await waitFor(() => {
      const roleIds = state.users.get(USER_ID)?.role_ids ?? []
      expect(roleIds).toContain(PLAIN_ROLE_ID)
      expect(roleIds).toContain(DEFAULT_ROLE_ID)
    })
  })

  it('opens with nothing dirtied — the locked default role never counts as a change', async () => {
    usersPage.render()

    await usersPage.open('eun.han')

    // The user holds only the default role, which the editor keeps checked but
    // disabled. With no togglable state changed, Save reads "No changes".
    expect(await usersPage.findRoleCheckbox('User')).toBeDisabled()
    expect(usersPage.queryNoChangesButton()).toBeInTheDocument()
  })
})

// Bug #8: the "Remove user" guard must key off `id`, not `username` — a rename
// can't slip past it, and two users can't collide on a display name. Mirrors
// the e2e coverage in `web-client/e2e/rbac-bugfixes.spec.ts` at the unit level.
describe('UsersPage — self-removal guard keys off id, not username', () => {
  it('disables Remove for a row whose id matches the session user, even with a different username', async () => {
    const { id: sessionId } = mockSession.data.user
    usersPage.render({
      permissions: [],
      roles: [],
      users: [{ id: sessionId, username: 'someone.else', role_ids: [] }],
    })

    await usersPage.open('someone.else')

    // The session loads asynchronously, so the guard flips on only once it
    // resolves — poll rather than asserting immediately after the drawer opens.
    await waitFor(async () => {
      expect(await usersPage.findRemoveButton()).toBeDisabled()
    })
  })

  it('leaves Remove enabled for a row whose username matches the session user but whose id differs', async () => {
    const { username: sessionUsername } = mockSession.data.user
    usersPage.render({
      permissions: [],
      roles: [],
      users: [{ id: 'u_other', username: sessionUsername, role_ids: [] }],
    })

    await usersPage.open(sessionUsername)

    expect(await usersPage.findRemoveButton()).toBeEnabled()
  })
})
