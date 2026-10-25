import { DetailList } from '../components/DetailList'
import { Icon } from '../components/Icon'
import type { SignInPromptDesign } from './signInPromptDesigns'

// A full page load, not a router link: the API answers with a 302 to the
// identity provider, and the browser must follow it.
const signInHref = '/api/v1/auth/login?return_to=/'

// The prompt that asks a guest to sign in, in one of the designs under review
// (#61). Styled by `.sign-in-*` in styles/base.css and the kit's classes.
export function SignInPrompt({
  design,
  displayName,
}: {
  design: SignInPromptDesign
  displayName: string | undefined
}) {
  switch (design) {
    case 'alert':
      return (
        <section className="fm-alert sign-in-alert" aria-labelledby="sign-in-title">
          <Icon name="user" />
          <h2 className="fm-alert__title" id="sign-in-title">
            Sign in to keep your results
          </h2>
          <p className="fm-alert__body">
            You’re playing as a guest, so your results stay on this browser. Sign in with your
            email or Google to keep them on any device. If you’re new, this makes your account.
          </p>
          <div className="fm-alert__actions">
            <a className="fm-btn fm-btn--primary" href={signInHref}>
              Sign in
            </a>
          </div>
        </section>
      )
    case 'notice':
      return (
        <p className="fm-notice">
          <Icon name="info" />
          <span>
            You’re playing as a guest.{' '}
            <a className="fm-btn fm-btn--link" href={signInHref}>
              Sign in
            </a>{' '}
            to keep your results on any device.
          </span>
        </p>
      )
    case 'card':
      return (
        <section className="fm-card sign-in-card" aria-labelledby="sign-in-title">
          <div className="fm-card__head">
            <div>
              <h2 className="fm-card__title" id="sign-in-title">
                Sign in to keep your results
              </h2>
              <p className="fm-card__sub">Your guest account lives on this browser only.</p>
            </div>
          </div>
          <div className="fm-card__body">
            <DetailList
              details={[
                { term: 'Playing as', value: displayName ?? 'Guest' },
                { term: 'Account', value: 'Guest' },
                { term: 'Saved on', value: 'This browser' },
              ]}
            />
          </div>
          <div className="fm-card__foot">
            <a className="fm-btn fm-btn--primary" href={signInHref}>
              Sign in
            </a>
            <span className="meta">Email or Google. New here? This makes your account.</span>
          </div>
        </section>
      )
    case 'hero':
      return (
        <section className="sign-in-hero" aria-labelledby="sign-in-title">
          <h2 className="sign-in-hero__title" id="sign-in-title">
            Sign in to keep your results.
          </h2>
          <p className="sign-in-hero__lead">
            You’re playing as a guest, so your results stay on this browser. Sign in with your
            email or Google, and they follow you to any device.
          </p>
          <a className="fm-btn fm-btn--primary fm-btn--lg" href={signInHref}>
            Sign in
          </a>
          <p className="meta">No password. If you’re new, this makes your account.</p>
        </section>
      )
    case 'strip':
      return (
        <aside className="sign-in-strip" aria-label="Sign in">
          <p>
            <b>Playing as a guest.</b> Sign in to keep your results on any device.
          </p>
          <a className="fm-btn fm-btn--primary fm-btn--sm" href={signInHref}>
            Sign in
          </a>
        </aside>
      )
  }
}
