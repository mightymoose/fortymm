import { createFileRoute, redirect } from '@tanstack/react-router'
import { sessionQueryOptions } from '@/api/session'
import { hasAppEntered } from '@/lib/landing-redirect'
import { BRAND } from '@/lib/page-title'
import App from '../App'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [{ title: `${BRAND} — table tennis, properly tracked` }],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    landing: 'landing' in search,
  }),
  beforeLoad: ({ search }) => {
    if (search.landing) return
    if (hasAppEntered()) throw redirect({ to: '/dashboard' })
  },
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(sessionQueryOptions())
  },
  component: App,
})
