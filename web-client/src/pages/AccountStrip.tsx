import { useSuspenseQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { sessionQuery } from '../api/queries'
import { useSignInHref } from './useSignInHref'

// The visitor's account above Home's roadmap, styled by `.sign-in-strip` in
// styles/base.css. A guest gets the link that signs them in.
export function AccountStrip() {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const signInHref = useSignInHref()

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
  return null
}
