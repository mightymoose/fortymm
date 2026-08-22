import { createFileRoute, redirect } from '@tanstack/react-router'
import { sessionQueryOptions } from '@/api/session'
import { hasAppEntered } from '@/lib/landing-redirect'
import { BRAND } from '@/lib/page-title'
import App from '../App'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [{ title: `${BRAND} — table tennis, properly tracked` }],
  }),
  // Idempotent on purpose: the router writes the validated search back into
  // the URL and parses it again. A `{ landing: false }` result would come back
  // as `?landing=false`, and a bare `'landing' in search` check would then read
  // true and swallow the dashboard redirect. So only a present, non-false value
  // sets the flag, and the absent case yields `{}` so the URL stays `/`.
  validateSearch: (search: Record<string, unknown>): { landing?: boolean } => {
    if (!('landing' in search)) return {}
    const raw = search.landing
    if (raw === false || raw === 'false') return {}
    return { landing: true }
  },
  beforeLoad: ({ search }) => {
    if (search.landing) return
    if (hasAppEntered()) throw redirect({ to: '/dashboard' })
  },
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(sessionQueryOptions())
  },
  component: App,
})
