import { Link } from '@tanstack/react-router'
import { ErrorScreen } from '../../components/ErrorScreen'
import { Icon } from '../../components/Icon'
import { signInHref } from '../useSignInHref'

// The page Auth0 sends the browser to after sign-out, in the designs under
// review at /signed-out-1 to /signed-out-4. /signed-out shows the first. Each
// is a public page that starts no session: Home would start a new guest
// account at once, and the sign-out wouldn't show. The sign-in links are full
// page loads, as the account strip's is.

const SIGN_IN_HREF = signInHref('/')

// 1. The error screens' frame: the wordmark, a title and the two ways on.
export function SignedOutScreen() {
  return (
    <ErrorScreen
      title="You’re signed out"
      actions={
        <>
          <a className="fm-btn fm-btn--primary" href={SIGN_IN_HREF}>
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

// 2. A card that confirms the sign-out and says what it ended.
export function SignedOutCard() {
  return (
    <main className="signed-out">
      <div className="loading-screen-wordmark">FortyMM</div>
      <section className="fm-card signed-out-card" aria-labelledby="signed-out-title">
        <div className="fm-card__head">
          <h1 className="fm-card__title" id="signed-out-title">
            You’re signed out
          </h1>
        </div>
        <div className="fm-card__body signed-out-card__body">
          <p className="fm-notice fm-notice--success">
            <Icon name="check" />
            <span>Your session on this browser has ended.</span>
          </p>
          <p className="fm-notice">
            <Icon name="info" />
            <span>Other devices where you signed in stay signed in.</span>
          </p>
        </div>
        <div className="fm-card__foot signed-out-card__foot">
          <a className="fm-btn fm-btn--primary fm-btn--block" href={SIGN_IN_HREF}>
            Sign in again
          </a>
          <Link to="/" className="fm-btn fm-btn--secondary fm-btn--block">
            Play as a guest
          </Link>
        </div>
      </section>
    </main>
  )
}

// 3. Guest play first: the big button starts playing, and sign-in is a link.
export function SignedOutGuestFirst() {
  return (
    <main className="signed-out">
      <div className="loading-screen-wordmark">FortyMM</div>
      <h1 className="signed-out__title">See you at the table</h1>
      <p className="signed-out__body">
        You’re signed out. You can still play now as a guest, and sign in
        later from Home.
      </p>
      <Link to="/" className="fm-btn fm-btn--primary fm-btn--xl">
        Play as a guest
      </Link>
      <p className="signed-out__body">
        Signed out by mistake?{' '}
        <a className="fm-btn fm-btn--link" href={SIGN_IN_HREF}>
          Sign in
        </a>
      </p>
    </main>
  )
}

// 4. The app's own topbar, with Sign in where the avatar goes, over an empty
// page that says what happened.
export function SignedOutShell() {
  return (
    <div className="signed-out-shell">
      <header className="app-top">
        <span className="app-wordmark" role="img" aria-label="FortyMM">
          <span className="app-wordmark__ball" />
          <span className="app-wordmark__name">FortyMM</span>
        </span>
        <a className="fm-btn fm-btn--secondary signed-out-shell__sign-in" href={SIGN_IN_HREF}>
          Sign in
        </a>
      </header>
      <main className="page">
        <div className="fm-empty">
          <h1 className="signed-out__title">You’re signed out</h1>
          <span>
            You signed out of FortyMM on this browser. Sign in at the top
            right, or play as a guest.
          </span>
          <Link to="/" className="fm-btn fm-btn--primary">
            Play as a guest
          </Link>
        </div>
      </main>
    </div>
  )
}
