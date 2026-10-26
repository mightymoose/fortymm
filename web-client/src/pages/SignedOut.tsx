import { Link } from '@tanstack/react-router'
import { ErrorScreen } from '../components/ErrorScreen'
import { signInHref } from './useSignInHref'

// Where Auth0 sends the browser after sign-out. It's a public page, so it
// starts no session. Home would start a new guest account at once, and the
// sign-out wouldn't show.
export function SignedOut() {
  return (
    <ErrorScreen
      title="You’re signed out"
      actions={
        <>
          {/* A full page load, as the account menu's Sign in is. */}
          <a className="fm-btn fm-btn--primary" href={signInHref('/')}>
            Sign in
          </a>
          <Link to="/" className="fm-btn fm-btn--ghost">
            Play as a guest
          </Link>
        </>
      }
    >
      You signed out of FortyMM on this browser. Sign in to get back to your
      players, or play as a guest.
    </ErrorScreen>
  )
}
