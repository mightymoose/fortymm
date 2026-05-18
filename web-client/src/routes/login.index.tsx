import { createFileRoute } from '@tanstack/react-router'

import {
  ScreenEmail,
  ScreenEmailSendFailed,
} from '@/components/login/login-screens'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/login/')({
  head: () => ({
    meta: [{ title: pageTitle('Sign in') }],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    error: search.error === 'send-failed' ? ('send-failed' as const) : undefined,
  }),
  component: LoginPage,
})

function LoginPage() {
  const { error } = Route.useSearch()
  if (error === 'send-failed') return <ScreenEmailSendFailed />
  return <ScreenEmail />
}
