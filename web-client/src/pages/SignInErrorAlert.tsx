import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useId, useState } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { RetryTime } from '../components/RetryTime'
import { parseRetryAfter, parseSignInError, signInErrors, tones } from './signInErrors'
import { signInHref, useSignInHref } from './useSignInHref'

// The params a sign-in that didn't finish adds to the URL.
const PARAMS = ['sign_in_error', 'retry_after'] as const

// Why a sign-in that came back with `sign_in_error` didn't finish, styled by
// `.sign-in-error` in styles/base.css. It keeps the message but removes the
// params from the URL, so a reload doesn't show it again. Its Try again signs
// in back to this page, or to `returnTo` if given.
export function SignInErrorAlert({ returnTo }: { returnTo?: string }) {
  const search: { sign_in_error?: unknown; retry_after?: unknown } = useSearch({ strict: false })
  const inUrl = PARAMS.some((param) => param in search)
  const [code, setCode] = useState(() => parseSignInError(search.sign_in_error))
  // Read once, so the time counts from the page load.
  const [retryAt] = useState(() => parseRetryAfter(search.retry_after))
  const navigate = useNavigate()
  const thisPage = useSignInHref()
  const tryAgainHref = returnTo === undefined ? thisPage : signInHref(returnTo)
  const titleId = useId()

  useEffect(() => {
    if (!inUrl) return
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev }
        for (const param of PARAMS) delete next[param]
        return next
      },
      replace: true,
    })
  }, [inUrl, navigate])

  if (code === null) return null
  const { title, body, tone } = signInErrors[code]
  const { className, icon, role } = tones[tone]
  return (
    <div className={`${className} sign-in-error`} role={role} aria-labelledby={titleId}>
      <Icon name={icon} />
      <p className="fm-alert__title" id={titleId}>
        {title}
      </p>
      <p className="fm-alert__body">
        {body}
        {code === 'rate_limited' && retryAt && (
          <>
            {' '}
            <RetryTime at={retryAt} />
          </>
        )}
      </p>
      <div className="fm-alert__actions">
        {/* A full page load, as the account menu's Sign in is. */}
        <a className="fm-btn fm-btn--primary fm-btn--sm" href={tryAgainHref}>
          Try again
        </a>
        <Button variant="ghost" size="sm" onClick={() => setCode(null)}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
