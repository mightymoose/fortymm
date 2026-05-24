import { createFileRoute } from '@tanstack/react-router'
import {
  publicUserByUsernameQueryOptions,
  usePublicUserByUsername,
} from '@/api/users'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/p/users/$username')({
  head: () => ({
    meta: [{ title: pageTitle('User') }],
  }),
  loader: ({ context: { queryClient }, params: { username } }) => {
    void queryClient.prefetchQuery(publicUserByUsernameQueryOptions(username))
  },
  component: PublicUserRoute,
})

function PublicUserRoute() {
  const { username } = Route.useParams()
  const { data, isPending, isError } = usePublicUserByUsername(username)

  return (
    <div className="p-6">
      {isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {isError && <p className="text-sm text-[color:var(--loss)]">User not found.</p>}
      {data && <h1 className="text-2xl font-semibold">{data.username}</h1>}
    </div>
  )
}
