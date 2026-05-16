import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'

export type Permission = components['schemas']['PermissionRead']
export type Role = components['schemas']['RoleRead']
export type RbacUser = components['schemas']['RbacUserRead']

const PERMISSIONS_KEY = ['permissions'] as const
const ROLES_KEY = ['roles'] as const
const USERS_KEY = ['rbac-users'] as const

function notifyError(verb: string) {
  return (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    toast.error(`Couldn't ${verb}`, { description: message })
  }
}

export function usePermissions() {
  return useQuery({
    queryKey: PERMISSIONS_KEY,
    queryFn: async (): Promise<Permission[]> =>
      unwrap('load permissions', await api.GET('/v1/permissions')),
    throwOnError: true,
    retry: false,
  })
}

export function useRoles() {
  return useQuery({
    queryKey: ROLES_KEY,
    queryFn: async (): Promise<Role[]> =>
      unwrap('load roles', await api.GET('/v1/roles')),
    throwOnError: true,
    retry: false,
  })
}

export function useRbacUsers() {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: async (): Promise<RbacUser[]> =>
      unwrap('load users', await api.GET('/v1/users')),
    throwOnError: true,
    retry: false,
  })
}

// The permission form awaits these via mutateAsync so it can surface 4xx
// errors inline on the matching field — that's why neither hook attaches a
// global onError toast. If a non-form caller is added later, it must handle
// errors itself or wrap with notifyError at the call site.
export function useCreatePermission() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { name: string; description?: string | null }) =>
      unwrap('create permission', await api.POST('/v1/permissions', { body: input })),
    onSuccess: () => qc.invalidateQueries({ queryKey: PERMISSIONS_KEY }),
  })
}

export function useUpdatePermission() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      id: string
      patch: { name?: string; description?: string | null }
    }) =>
      unwrap(
        'update permission',
        await api.PATCH('/v1/permissions/{permission_id}', {
          params: { path: { permission_id: input.id } },
          body: input.patch,
        }),
      ),
    // Roles only embed permission_ids, so a permission edit doesn't change role
    // payloads — no ROLES_KEY invalidation needed (role detail re-renders from
    // the fresh permissions cache).
    onSuccess: () => qc.invalidateQueries({ queryKey: PERMISSIONS_KEY }),
  })
}

export function useDeletePermission() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      unwrap(
        'delete permission',
        await api.DELETE('/v1/permissions/{permission_id}', {
          params: { path: { permission_id: id } },
        }),
        { allowEmpty: true },
      )
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PERMISSIONS_KEY })
      qc.invalidateQueries({ queryKey: ROLES_KEY })
    },
    onError: notifyError('delete the permission'),
  })
}

export function useCreateRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      name: string
      description?: string | null
      template_id?: string
      permission_ids?: string[]
    }) => unwrap('create role', await api.POST('/v1/roles', { body: input })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ROLES_KEY }),
    onError: notifyError('create the role'),
  })
}

export function useUpdateRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      id: string
      patch: {
        name?: string
        description?: string | null
        permission_ids?: string[]
      }
    }) =>
      unwrap(
        'update role',
        await api.PATCH('/v1/roles/{role_id}', {
          params: { path: { role_id: input.id } },
          body: input.patch,
        }),
      ),
    // Optimistic update so permission checkboxes (toggled rapidly) flip
    // instantly; restore the snapshot on error so the UI doesn't lie.
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ROLES_KEY })
      const previous = qc.getQueryData<Role[]>(ROLES_KEY)
      if (previous) {
        qc.setQueryData<Role[]>(
          ROLES_KEY,
          previous.map((r) => (r.id === input.id ? { ...r, ...input.patch } : r)),
        )
      }
      return { previous }
    },
    onError: (err, _input, ctx) => {
      if (ctx?.previous) qc.setQueryData(ROLES_KEY, ctx.previous)
      notifyError('update the role')(err)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ROLES_KEY }),
  })
}

export function useDeleteRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      unwrap(
        'delete role',
        await api.DELETE('/v1/roles/{role_id}', {
          params: { path: { role_id: id } },
        }),
        { allowEmpty: true },
      )
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ROLES_KEY })
      qc.invalidateQueries({ queryKey: USERS_KEY })
    },
    onError: notifyError('delete the role'),
  })
}

export function useCreateRbacUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (username: string) =>
      unwrap('create user', await api.POST('/v1/users', { body: { username } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY }),
    onError: notifyError('add the user'),
  })
}

export function useDeleteRbacUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      unwrap(
        'delete user',
        await api.DELETE('/v1/users/{user_id}', {
          params: { path: { user_id: id } },
        }),
        { allowEmpty: true },
      )
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY }),
    onError: notifyError('remove the user'),
  })
}

export function useSetUserRoles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string; roleIds: string[] }) =>
      unwrap(
        'set user roles',
        await api.PUT('/v1/users/{user_id}/roles', {
          params: { path: { user_id: input.id } },
          body: { role_ids: input.roleIds },
        }),
      ),
    // Optimistic so revoke-from-role-detail doesn't read a stale cached list
    // when two revokes fire close together — both reads would otherwise see
    // the pre-revoke role set and one revoke would be lost.
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: USERS_KEY })
      const previous = qc.getQueryData<RbacUser[]>(USERS_KEY)
      if (previous) {
        qc.setQueryData<RbacUser[]>(
          USERS_KEY,
          previous.map((u) =>
            u.id === input.id ? { ...u, role_ids: input.roleIds } : u,
          ),
        )
      }
      return { previous }
    },
    onError: (err, _input, ctx) => {
      if (ctx?.previous) qc.setQueryData(USERS_KEY, ctx.previous)
      notifyError('save role assignments')(err)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: USERS_KEY }),
  })
}
