import { createFileRoute } from '@tanstack/react-router'
import { sessionQueryOptions } from '@/api/session'
import { useUserById, userByIdQueryOptions } from '@/api/users'
import { AppShell } from '@/components/app-shell'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/users/$userId')({
  head: () => ({
    meta: [{ title: pageTitle('User') }],
  }),
  loader: ({ context: { queryClient }, params: { userId } }) => {
    void queryClient.prefetchQuery(sessionQueryOptions())
    void queryClient.prefetchQuery(userByIdQueryOptions(userId))
  },
  component: UserRoute,
})

function UserRoute() {
  const { userId } = Route.useParams()
  const { data, isPending, isError } = useUserById(userId)

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
