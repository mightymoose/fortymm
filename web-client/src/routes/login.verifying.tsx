import { createFileRoute } from '@tanstack/react-router'

import {
  ScreenError,
  ScreenVerify,
  ScreenVerifyNetError,
} from '@/components/login/login-screens'
import { pageTitle } from '@/lib/page-title'

type VerifyError = 'expired' | 'net'

export const Route = createFileRoute('/login/verifying')({
  head: () => ({
    meta: [{ title: pageTitle('Verifying') }],
  }),
  validateSearch: (search: Record<string, unknown>) => {
    const e = search.error
    return {
      error: e === 'expired' || e === 'net' ? (e as VerifyError) : undefined,
    }
  },
  component: LoginVerifyingPage,
})

function LoginVerifyingPage() {
  const { error } = Route.useSearch()
  if (error === 'expired') return <ScreenError />
  if (error === 'net') return <ScreenVerifyNetError />
  return <ScreenVerify />
}
