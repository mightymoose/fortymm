import { useMutation } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { logout } from '../api/queries'
import { leavePage } from '../leavePage'

// Signs the visitor out, then leaves for the identity provider's logout
// page, which sends the browser on to `/signed-out`. `leaving` stays
// true after success too, while the browser leaves.
export function useSignOut() {
  const { api } = useRouteContext({ from: '__root__' })
  const signOut = useMutation({
    mutationFn: () => logout(api),
    onSuccess: (logoutUrl) => leavePage(logoutUrl),
  })
  return {
    signOut: () => signOut.mutate(),
    leaving: signOut.isPending || signOut.isSuccess,
    failed: signOut.isError,
  }
}
