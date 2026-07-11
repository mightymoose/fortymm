import { useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { ApiError } from '@/api/client'
import { useRequestLogin } from '@/api/session'
import { ScreenSent } from '@/components/login/login-screens'
import { Turnstile, type TurnstileHandle } from '@/components/turnstile'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/login/sent')({
  head: () => ({
    meta: [{ title: pageTitle('Check your inbox') }],
  }),
  // No `error` key: this page has exactly one state. A hand-typed `?error=…`
  // is simply never read, so it falls through to the normal "check your inbox"
  // screen rather than a bespoke error screen (#226).
  validateSearch: (search: Record<string, unknown>) => ({
    email: typeof search.email === 'string' ? search.email : '',
    sentAt: typeof search.sentAt === 'number' ? search.sentAt : undefined,
  }),
  component: LoginSentPage,
})

function LoginSentPage() {
  const { email, sentAt } = Route.useSearch()
  const navigate = useNavigate()
  const requestLogin = useRequestLogin()
  // A fresh captcha token is kept on this page (the Turnstile widget below
  // hands one over and replaces it after each use) so "Resend" can re-issue
  // the link without bouncing through /login to re-run the challenge.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [resendMessage, setResendMessage] = useState<string | null>(null)
  const [resendError, setResendError] = useState<string | null>(null)
  const captchaRef = useRef<TurnstileHandle | null>(null)
  const inFlight = useRef(false)

  // "Start over" goes back to /login with the email prefilled to re-run the
  // whole flow from scratch.
  const startOver = () => {
    navigate({
      to: '/login',
      search: { email: email || undefined, error: undefined },
    })
  }

  // "Resend" re-issues the link in place: POST a new request with the held
  // captcha token, reset the expiry countdown (a new sentAt), and reset the
  // widget so the next resend gets a fresh token. The Resend control is
  // cooldown-throttled (see ScreenSent), so a failure here means a genuine
  // server error — surface it inline and keep the user on this screen (they
  // still hold their original link) rather than bouncing them to /login.
  const resend = () => {
    if (inFlight.current || !email || !captchaToken) return
    inFlight.current = true
    setResendMessage(null)
    setResendError(null)
    requestLogin.mutate(
      { email, captchaToken },
      {
        onSuccess: () => {
          setResendMessage('New link sent — check your inbox.')
          navigate({
            to: '/login/sent',
            replace: true,
            search: { email, sentAt: Date.now() },
          })
        },
        onError: (err) => {
          setResendError(
            err instanceof ApiError && err.status === 429
              ? "That's a lot of links — give it a minute before resending again."
              : "Couldn't resend just now. Try again in a moment, or start over.",
          )
        },
        onSettled: () => {
          inFlight.current = false
          // Turnstile tokens are single-use; drop the spent one and ask the
          // widget for a fresh one for any subsequent resend.
          setCaptchaToken(null)
          captchaRef.current?.reset()
        },
      },
    )
  }

  return (
    <>
      <ScreenSent
        email={email || 'your inbox'}
        sentAt={sentAt}
        onStartOver={startOver}
        // Disabled until a captcha token is in hand (and there's an address to
        // send to); the button shows the disabled state in the meantime.
        onResend={email && captchaToken ? resend : undefined}
        resending={requestLogin.isPending}
        resendMessage={resendMessage}
        resendError={resendError}
      />
      <Turnstile
        handleRef={(h) => {
          captchaRef.current = h
        }}
        onToken={setCaptchaToken}
        onExpire={() => setCaptchaToken(null)}
        onError={() => setCaptchaToken(null)}
      />
    </>
  )
}
