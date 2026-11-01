import { Link } from '@tanstack/react-router'
import { ErrorScreen } from '../components/ErrorScreen'
import { signInHref } from './useSignInHref'

// Where Auth0 sends the browser for any sign-in error. It's a public page,
// so it starts no session.
export function SignInStopped() {
  return (
    <ErrorScreen
      title="Sign-in stopped here"
      actions={
        <>
          <Link to="/" className="fm-btn fm-btn--primary">
            Go to FortyMM
          </Link>
          {/* A full page load, as the account menu's Sign in is. */}
          <a className="fm-btn fm-btn--ghost" href={signInHref('/')}>
            Sign in again
          </a>
        </>
      }
    >
      This sign-in page has ended. That often happens after going back from a
      sign-in that worked. If you finished signing in, you’re still signed in.
    </ErrorScreen>
  )
}
