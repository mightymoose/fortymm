import { useEffect, useRef } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'

import { ApiError } from '@/api/client'
import { useConfirmEmail } from '@/api/session'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/confirm-email')({
  head: () => ({
    meta: [{ title: pageTitle('Confirm email') }],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : '',
  }),
  component: ConfirmEmailPage,
})

function ConfirmEmailPage() {
  const { token } = Route.useSearch()
  const confirm = useConfirmEmail()
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current || !token) return
    fired.current = true
    confirm.mutate(token)
  }, [token, confirm])

  const status: 'missing-token' | 'confirming' | 'ok' | 'error' = !token
    ? 'missing-token'
    : confirm.isSuccess
      ? 'ok'
      : confirm.isError
        ? 'error'
        : 'confirming'

  const errorMsg =
    status === 'missing-token'
      ? 'This link is missing its token.'
      : confirm.error instanceof ApiError && confirm.error.detail
        ? confirm.error.detail
        : 'Confirmation failed.'

  // Intentionally NOT wrapped in <AppShell> — AppShell calls useSession()
  // on mount, and `GET /v1/session` auto-mints a guest user for cookieless
  // requests. Clicking the link on a device that doesn't share cookies
  // with the requesting browser (mobile mail, in-app webview) would leak
  // one orphan user + session-token row per click. The confirm endpoint
  // itself rotates the cookie to the token's owner, so the user lands on
  // the dashboard signed in as themselves.
  return (
    <div
      style={{
        maxWidth: 520,
        margin: '64px auto',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 40,
          margin: '0 0 12px',
        }}
      >
        {status === 'ok' ? 'You’re in.' : 'Confirming your email…'}
      </h1>
      {status === 'confirming' && (
        <p style={{ color: 'var(--fg-3)' }}>Hang tight, this only takes a second.</p>
      )}
      {status === 'ok' && (
        <>
          <p style={{ color: 'var(--fg-2)' }}>
            Your email is verified. Your FortyMM account is now yours to keep.
          </p>
          <Link
            to="/dashboard"
            className="fmm-btn fmm-btn--primary"
            style={{ marginTop: 24 }}
          >
            Go to dashboard
          </Link>
        </>
      )}
      {(status === 'error' || status === 'missing-token') && (
        <>
          <p className="fmm-help fmm-help--err" role="alert">
            {errorMsg}
          </p>
          <Link
            to="/settings"
            hash="sec-email"
            className="fmm-btn fmm-btn--quiet"
            style={{ marginTop: 24 }}
          >
            Back to settings
          </Link>
        </>
      )}
    </div>
  )
}
