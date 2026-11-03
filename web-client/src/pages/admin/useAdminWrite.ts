import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { useRouteContext, useRouter } from '@tanstack/react-router'
import type { ApiClient } from '../../api/client'
import { can, type BuiltInPermission } from '../../api/permissions'
import { refreshAfterAdminWrite, sessionQuery } from '../../api/queries'

// An admin write: roles, permissions, who holds them, or a signing key's
// revoke. After it, the admin lists and the session fetch again. Then the admin route's loader checks the
// session again, so a visitor who took `admin.view` from themselves goes to
// Home. Its promise settles once all of that is done.
export function useAdminWrite<Variables>(
  write: (api: ApiClient, variables: Variables) => Promise<void>,
) {
  const { api, queryClient } = useRouteContext({ from: '__root__' })
  const router = useRouter()
  return useMutation({
    mutationFn: (variables: Variables) => write(api, variables),
    onSuccess: async () => {
      await refreshAfterAdminWrite(api, queryClient)
      await router.invalidate()
    },
  })
}

// Whether the visitor's account holds `permission`. The `_authenticated`
// loader has loaded the session, so this never suspends.
export function useCan(permission: BuiltInPermission): boolean {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  return can(account, permission)
}
