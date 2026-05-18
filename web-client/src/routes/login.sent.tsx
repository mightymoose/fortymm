import { createFileRoute } from '@tanstack/react-router'

import { ScreenSent, ScreenSentBounced } from '@/components/login/login-screens'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/login/sent')({
  head: () => ({
    meta: [{ title: pageTitle('Check your inbox') }],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    error: search.error === 'bounce' ? ('bounce' as const) : undefined,
  }),
  component: LoginSentPage,
})

function LoginSentPage() {
  const { error } = Route.useSearch()
  if (error === 'bounce') return <ScreenSentBounced />
  return <ScreenSent />
}
