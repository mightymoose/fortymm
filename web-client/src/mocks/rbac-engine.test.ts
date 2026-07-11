import { describe, expect, it } from 'vitest'
import { createRbacState, dispatchRbac, type RbacUser, type Role } from './rbac-engine'

// These tests pin the mock RBAC engine to the *real* server's behaviour
// (api/app/rbac.py, ADR-0016). Drift here is a false green: a component test
// would pass against MSW and fail against the API.

const SEED = {
  roles: [
    { id: 'r_user', name: 'User', permission_ids: [], is_default: true },
    { id: 'r_admin', name: 'Admin', permission_ids: [] },
  ],
  users: [{ id: 'u1', username: 'alex', role_ids: ['r_user', 'r_admin'] }],
}

describe('dispatchRbac · POST /v1/users', () => {
  it('grants the default role to a newly-created user', () => {
    const state = createRbacState(SEED)

    const result = dispatchRbac(state, 'POST', '/v1/users', { username: 'rita.kovac' })

    expect(result?.status).toBe(201)
    const created = result?.body as RbacUser
    expect(created.role_ids).toEqual(['r_user'])
    expect(state.users.get(created.id)?.role_ids).toEqual(['r_user'])
  })

  it('mints a role-less user when the seed has no default role', () => {
    const state = createRbacState({ roles: [{ id: 'r_admin', name: 'Admin' }], users: [] })

    const result = dispatchRbac(state, 'POST', '/v1/users', { username: 'rita.kovac' })

    expect(result?.status).toBe(201)
    expect((result?.body as RbacUser).role_ids).toEqual([])
  })
})

describe('dispatchRbac · default-role refusals', () => {
  // Byte-for-byte the details `delete_role` / `update_role` raise in
  // api/app/rbac.py. The tails differ: delete offers only the permissions,
  // rename offers the permissions and the description.
  it('refuses to delete the default role with the API’s copy', () => {
    const state = createRbacState(SEED)

    const result = dispatchRbac(state, 'DELETE', '/v1/roles/r_user', null)

    expect(result).toEqual({
      status: 400,
      body: {
        detail:
          'The "User" role is held by everyone on the platform and cannot be deleted. ' +
          'You can change the permissions it grants instead.',
      },
    })
    expect(state.roles.has('r_user')).toBe(true)
  })

  it('refuses to rename the default role with the API’s copy', () => {
    const state = createRbacState(SEED)

    const result = dispatchRbac(state, 'PATCH', '/v1/roles/r_user', { name: 'Everyone' })

    expect(result).toEqual({
      status: 400,
      body: {
        detail:
          'The "User" role is held by everyone on the platform and cannot be renamed. ' +
          'You can change the permissions it grants and its description.',
      },
    })
    expect(state.roles.get('r_user')?.name).toBe('User')
  })

  it('still edits the default role’s description and permissions', () => {
    const state = createRbacState(SEED)

    const result = dispatchRbac(state, 'PATCH', '/v1/roles/r_user', {
      name: 'User',
      description: 'Everyone holds this.',
      permission_ids: ['p_tv'],
    })

    expect(result?.status).toBe(200)
    const updated = result?.body as Role
    expect(updated.description).toBe('Everyone holds this.')
    expect(updated.permission_ids).toEqual(['p_tv'])
  })
})
