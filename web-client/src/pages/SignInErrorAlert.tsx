import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useId, useState } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { parseSignInError, signInErrors, tones } from './signInErrors'
import { useSignInHref } from './useSignInHref'

// Why a sign-in that came back with `sign_in_error` didn't finish, styled by
// `.sign-in-error` in styles/base.css. It keeps the message but removes the
// param from the URL, so a reload doesn't show it again.
export function SignInErrorAlert() {
  const search: { sign_in_error?: unknown } = useSearch({ strict: false })
  const inUrl = 'sign_in_error' in search
  const [code, setCode] = useState(() => parseSignInError(search.sign_in_error))
  const navigate = useNavigate()
  const signInHref = useSignInHref()
  const titleId = useId()

  useEffect(() => {
    if (!inUrl) return
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev }
        delete next.sign_in_error
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
      <p className="fm-alert__body">{body}</p>
      <div className="fm-alert__actions">
        {/* A full page load, as the account strip's Sign in is. */}
        <a className="fm-btn fm-btn--primary fm-btn--sm" href={signInHref}>
          Try again
        </a>
        <Button variant="ghost" size="sm" onClick={() => setCode(null)}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
