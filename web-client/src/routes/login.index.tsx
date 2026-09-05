import { useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { ApiError } from '@/api/client'
import { useRequestLogin, useStartNewGuest, useLogout } from '@/api/session'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useEndedSession } from '@/api/browser-session'
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
  const ended = useEndedSession()
  const newGuest = useStartNewGuest()
  const retryLogout = useLogout(true)
  const [serverError, setServerError] = useState<string | null>(null)
  // Synchronous in-flight guard: the mutation's isPending flips on a batched
  // re-render, so a rapid click burst can dispatch duplicate requests (and
  // duplicate sign-in emails) before the button disables.
  const inFlight = useRef(false)

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
      notice={ended && <Alert className="mb-2 border-[var(--warn)]/40">
        <AlertTitle>{ended.logoutPending ? 'Sign-out incomplete' : 'Signed out'}</AlertTitle>
        <AlertDescription>
          <p>{ended.message}</p>
          {ended.logoutPending && <button type="button" className="mt-3 underline"
            disabled={retryLogout.isPending} onClick={() => retryLogout.mutate()}>
            Retry sign-out
          </button>}
          <button type="button" className="mt-3 underline" disabled={newGuest.isPending}
            onClick={() => newGuest.mutate(undefined, {
              onSuccess: () => navigate({ to: '/dashboard' }),
            })}>
            Continue as a new guest
          </button>
          {newGuest.isError && <p>We couldn't start a new guest. Please try again.</p>}
        </AlertDescription>
      </Alert>}
      initialEmail={initialEmail ?? ''}
      submitting={requestLogin.isPending}
      errorMessage={serverError}
      onSubmit={async ({ email, captchaToken, honeypot }) => {
        if (inFlight.current) return
        inFlight.current = true
        setServerError(null)
        try {
          await requestLogin.mutateAsync({ email, captchaToken, honeypot })
          navigate({
            to: '/login/sent',
            // Stamp the send time so /login/sent can run a real expiry
            // countdown anchored to when the link actually went out (survives
            // refresh; a fresh send via resend re-stamps it).
            search: { email, sentAt: Date.now() },
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
            if (err.status === 429) {
              // The API's bare "Too Many Requests" detail is no guidance, so
              // give the user a concrete what-now instead of echoing it.
              setServerError(
                'Too many sign-in attempts. Wait a minute, then try again.',
              )
              return
            }
            if (err.status === 422) {
              // Pydantic's 422 detail leaks internals ("value is not a valid
              // email address: The email address is too long (N characters
              // too many)"). Show the same friendly copy the client-side
              // validator uses instead of echoing it.
              setServerError("That doesn't look like a valid email.")
              return
            }
            setServerError(err.detail ?? 'Something went wrong. Try again.')
            return
          }
          setServerError('Something went wrong. Try again.')
        } finally {
          inFlight.current = false
        }
      }}
    />
  )
}
