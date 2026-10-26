import { useSuspenseQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { sessionQuery } from '../api/queries'
import { Button } from '../components/Button'
import { useSignInHref } from './useSignInHref'
import { useSignOut } from './useSignOut'

// The visitor's account above Home's roadmap, styled by `.sign-in-strip` in
// styles/base.css. A guest gets the link that signs them in. A verified
// account gets Sign out. A guest gets none, because signing out would throw
// their account away.
export function AccountStrip() {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const signInHref = useSignInHref()
  const { signOut, leaving, failed } = useSignOut()

  if (account.kind === 'guest') {
    return (
      <aside className="sign-in-strip" aria-label="Sign in">
        <p>
          <b>Playing as a guest.</b> Sign in to use this account on any device.
        </p>
        <a className="fm-btn fm-btn--primary fm-btn--sm" href={signInHref}>
          Sign in
        </a>
      </aside>
    )
  }

  return (
    <aside
      className="sign-in-strip"
      aria-label="Your account"
      data-error={failed || undefined}
    >
      {failed ? (
        <p role="alert">
          <b>Couldn’t sign you out.</b> Check your connection, then try again.
        </p>
      ) : (
        <p>
          <b>Signed in as {account.email}.</b>
        </p>
      )}
      <Button
        variant="secondary"
        size="sm"
        busy={leaving}
        aria-disabled={leaving || undefined}
        onClick={signOut}
      >
        {leaving ? 'Signing out…' : 'Sign out'}
      </Button>
    </aside>
  )
}
