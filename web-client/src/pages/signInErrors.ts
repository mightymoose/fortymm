import type { IconName } from '../components/Icon'

// The codes that GET /v1/auth/callback adds to return_to as `sign_in_error`.
export type SignInErrorCode = 'cancelled' | 'email_not_verified' | 'expired' | 'failed' | 'used'

type Tone = 'error' | 'neutral'

// `action` labels the link that starts another sign-in.
export const signInErrors: Record<
  SignInErrorCode,
  { title: string; body: string; tone: Tone; action: string }
> = {
  // Cancelling isn't a failure, so it gets no error colour.
  cancelled: {
    title: 'Sign-in cancelled',
    body: 'You didn’t finish signing in, so nothing changed.',
    tone: 'neutral',
    action: 'Try again',
  },
  email_not_verified: {
    title: 'Verify your email first',
    body: 'Your sign-in provider hasn’t verified this email address. Verify it with them, then try again.',
    tone: 'error',
    action: 'Try again',
  },
  expired: {
    title: 'Sign-in took too long',
    body: 'A sign-in has 10 minutes to finish. Start again.',
    tone: 'error',
    action: 'Try again',
  },
  failed: {
    title: 'Sign-in didn’t work',
    body: 'Something went wrong, and nothing changed. Try again.',
    tone: 'error',
    action: 'Try again',
  },
  // A replay, such as Back to the provider after a sign-in that worked. The
  // person is often signed in already, so it gets no error colour, and
  // nothing failed to try again.
  used: {
    title: 'Sign-in already finished',
    body: 'If you’re not signed in, sign in again.',
    tone: 'neutral',
    action: 'Sign in',
  },
}

// An error is announced at once. A neutral message waits its turn.
export const tones: Record<Tone, { className: string; icon: IconName; role: 'alert' | 'status' }> =
  {
    error: { className: 'fm-alert fm-alert--error', icon: 'error', role: 'alert' },
    neutral: { className: 'fm-alert', icon: 'info', role: 'status' },
  }

// The code in a `sign_in_error` search param, or null without one. A code
// this client doesn't know, e.g. from a newer API, reads as `failed`.
export function parseSignInError(value: unknown): SignInErrorCode | null {
  if (value === undefined) return null
  return typeof value === 'string' && Object.hasOwn(signInErrors, value)
    ? (value as SignInErrorCode)
    : 'failed'
}
