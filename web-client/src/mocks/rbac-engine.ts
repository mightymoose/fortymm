import type { components } from '@/api/schema'
import {
  permission as makePermission,
  role as makeRole,
  rbacUser as makeUser,
} from '@/test/factories'

export type Permission = components['schemas']['PermissionRead']
export type Role = components['schemas']['RoleRead']
export type RbacUser = components['schemas']['RbacUserRead']

export interface RbacState {
  permissions: Map<string, Permission>
  roles: Map<string, Role>
  users: Map<string, RbacUser>
}

export interface SeedSpec {
  permissions?: Partial<Permission>[]
  roles?: Partial<Role>[]
  users?: Partial<RbacUser>[]
}

export function createRbacState(seed: SeedSpec = {}): RbacState {
  const state: RbacState = {
    permissions: new Map(),
    roles: new Map(),
    users: new Map(),
  }
  for (const p of seed.permissions ?? []) {
    const built = makePermission(p)
    state.permissions.set(built.id, built)
  }
  for (const r of seed.roles ?? []) {
    const built = makeRole(r)
    state.roles.set(built.id, built)
  }
  for (const u of seed.users ?? []) {
    const built = makeUser(u)
    state.users.set(built.id, built)
  }
  return state
}

export interface DispatchResult {
  status: number
  body: unknown
}

type Body = {
  name?: string
  description?: string | null
  template_id?: string
  permission_ids?: string[]
  username?: string
  role_ids?: string[]
}

const sortedPermissions = (s: RbacState) =>
  [...s.permissions.values()].sort((a, b) => a.name.localeCompare(b.name))
const sortedRoles = (s: RbacState) =>
  [...s.roles.values()].sort((a, b) => a.name.localeCompare(b.name))
const sortedUsers = (s: RbacState) =>
  [...s.users.values()].sort((a, b) => a.username.localeCompare(b.username))

/**
 * Returns null when no rule matches `${method} ${path}`, allowing callers
 * to fall through to a 404 or other handlers.
 */
export function dispatchRbac(
  state: RbacState,
  method: string,
  path: string,
  rawBody: unknown,
): DispatchResult | null {
  const body: Body = (rawBody ?? {}) as Body

  // ---- permissions
  if (path === '/v1/permissions' && method === 'GET') {
    return { status: 200, body: sortedPermissions(state) }
  }
  if (path === '/v1/permissions' && method === 'POST') {
    if ([...state.permissions.values()].some((p) => p.name === body.name)) {
      return { status: 409, body: { detail: 'permission name already exists' } }
    }
    const p = makePermission({ name: body.name!, description: body.description ?? null })
    state.permissions.set(p.id, p)
    return { status: 201, body: p }
  }
  let m = path.match(/^\/v1\/permissions\/([^/]+)$/)
  if (m) {
    const id = m[1]
    const existing = state.permissions.get(id)
    if (!existing) return { status: 404, body: { detail: 'permission not found' } }
    if (method === 'GET') return { status: 200, body: existing }
    if (method === 'PATCH') {
      if (
        body.name &&
        [...state.permissions.values()].some((p) => p.id !== id && p.name === body.name)
      ) {
        return { status: 409, body: { detail: 'permission name already exists' } }
      }
      const updated: Permission = { ...existing, ...body, updated_at: new Date().toISOString() }
      state.permissions.set(id, updated)
      return { status: 200, body: updated }
    }
    if (method === 'DELETE') {
      state.permissions.delete(id)
      for (const r of state.roles.values()) {
        r.permission_ids = r.permission_ids.filter((pid) => pid !== id)
      }
      return { status: 204, body: null }
    }
  }

  // ---- roles
  if (path === '/v1/roles' && method === 'GET') {
    return { status: 200, body: sortedRoles(state) }
  }
  if (path === '/v1/roles' && method === 'POST') {
    if ([...state.roles.values()].some((r) => r.name === body.name)) {
      return { status: 409, body: { detail: 'role name already exists' } }
    }
    let permission_ids: string[] = []
    if (body.template_id) {
      const tmpl = state.roles.get(body.template_id)
      if (!tmpl) return { status: 404, body: { detail: 'template role not found' } }
      permission_ids = [...tmpl.permission_ids]
    } else if (body.permission_ids) {
      permission_ids = [...body.permission_ids]
    }
    const r = makeRole({
      name: body.name!,
      description: body.description ?? null,
      permission_ids,
    })
    state.roles.set(r.id, r)
    return { status: 201, body: r }
  }
  m = path.match(/^\/v1\/roles\/([^/]+)$/)
  if (m) {
    const id = m[1]
    const existing = state.roles.get(id)
    if (!existing) return { status: 404, body: { detail: 'role not found' } }
    if (method === 'GET') return { status: 200, body: existing }
    if (method === 'PATCH') {
      if (
        body.name &&
        [...state.roles.values()].some((r) => r.id !== id && r.name === body.name)
      ) {
        return { status: 409, body: { detail: 'role name already exists' } }
      }
      const updated: Role = {
        ...existing,
        ...body,
        permission_ids: body.permission_ids ?? existing.permission_ids,
        updated_at: new Date().toISOString(),
      }
      state.roles.set(id, updated)
      return { status: 200, body: updated }
    }
    if (method === 'DELETE') {
      state.roles.delete(id)
      for (const u of state.users.values()) {
        u.role_ids = u.role_ids.filter((rid) => rid !== id)
      }
      return { status: 204, body: null }
    }
  }

  // ---- users
  if (path === '/v1/users' && method === 'GET') {
    return { status: 200, body: sortedUsers(state) }
  }
  if (path === '/v1/users' && method === 'POST') {
    if ([...state.users.values()].some((u) => u.username === body.username)) {
      return { status: 409, body: { detail: 'username already exists' } }
    }
    const u = makeUser({ username: body.username! })
    state.users.set(u.id, u)
    return { status: 201, body: u }
  }
  m = path.match(/^\/v1\/users\/([^/]+)$/)
  if (m) {
    const id = m[1]
    const existing = state.users.get(id)
    if (!existing) return { status: 404, body: { detail: 'user not found' } }
    if (method === 'GET') return { status: 200, body: existing }
    if (method === 'DELETE') {
      state.users.delete(id)
      return { status: 204, body: null }
    }
  }
  m = path.match(/^\/v1\/users\/([^/]+)\/roles$/)
  if (m && method === 'PUT') {
    const id = m[1]
    const existing = state.users.get(id)
    if (!existing) return { status: 404, body: { detail: 'user not found' } }
    existing.role_ids = [...(body.role_ids ?? [])]
    return { status: 200, body: existing }
  }

  return null
}
