import { createFileRoute } from '@tanstack/react-router'
import { sessionQueryOptions, useSession } from '@/api/session'
import { useUserById } from '@/api/users'
import { AppShell } from '@/components/app-shell'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/users/$userId')({
  head: () => ({
    meta: [{ title: pageTitle('User') }],
  }),
  // Don't prefetch the profile here — it requires a session cookie, and on a
  // direct-load the session prefetch hasn't landed yet. The component fires
  // the profile query once `session.isSuccess`. See #144.
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(sessionQueryOptions())
  },
  component: UserRoute,
})

function UserRoute() {
  const { userId } = Route.useParams()
  const session = useSession()
  const { data, isPending, isError } = useUserById(userId, {
    enabled: session.isSuccess,
  })

  return (
    <AppShell>
      <div className="p-6">
        {isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {isError && <p className="text-sm text-[color:var(--loss)]">User not found.</p>}
        {data && <h1 className="text-2xl font-semibold">{data.username}</h1>}
      </div>
    </AppShell>
  )
}
