import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { ApiError } from '@/api/client'
import { useRequestLogin } from '@/api/session'
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
    email: typeof search.email === 'string' ? search.email : undefined,
  }),
  component: LoginPage,
})

function LoginPage() {
  const { error, email: initialEmail } = Route.useSearch()
  const navigate = useNavigate()
  const requestLogin = useRequestLogin()
  const [serverError, setServerError] = useState<string | null>(null)

  if (error === 'send-failed') {
    return (
      <ScreenEmailSendFailed
        email={initialEmail ?? ''}
        detail={serverError ?? undefined}
        onTryAgain={() =>
          navigate({
            to: '/login',
            search: { error: undefined, email: initialEmail },
          })
        }
      />
    )
  }

  return (
    <ScreenEmail
      initialEmail={initialEmail ?? ''}
      submitting={requestLogin.isPending}
      errorMessage={serverError}
      onSubmit={async ({ email, captchaToken, honeypot }) => {
        setServerError(null)
        try {
          await requestLogin.mutateAsync({ email, captchaToken, honeypot })
          navigate({
            to: '/login/sent',
            search: { email, error: undefined },
          })
        } catch (err) {
          if (err instanceof ApiError) {
            if (err.status >= 500 || err.status === 0) {
              navigate({
                to: '/login',
                search: { error: 'send-failed', email },
              })
              return
            }
            setServerError(err.detail ?? 'Something went wrong. Try again.')
            return
          }
          setServerError('Something went wrong. Try again.')
        }
      }}
    />
  )
}
