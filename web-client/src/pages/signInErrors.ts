import type { IconName } from '../components/Icon'

// The codes that GET /v1/auth/callback adds to return_to as `sign_in_error`,
// and `rate_limited`, which GET /v1/auth/login sends to /signed-out.
export type SignInErrorCode =
  | 'cancelled'
  | 'email_not_verified'
  | 'expired'
  | 'failed'
  | 'rate_limited'
  | 'used'

type Tone = 'error' | 'neutral'

export const signInErrors: Record<SignInErrorCode, { title: string; body: string; tone: Tone }> = {
  // Cancelling isn't a failure, so it gets no error colour.
  cancelled: {
    title: 'Sign-in cancelled',
    body: 'You didn’t finish signing in, so nothing changed.',
    tone: 'neutral',
  },
  email_not_verified: {
    title: 'Verify your email first',
    body: 'Your sign-in provider hasn’t verified this email address. Verify it with them, then try again.',
    tone: 'error',
  },
  expired: {
    title: 'Sign-in took too long',
    body: 'A sign-in has 10 minutes to finish. Start again.',
    tone: 'error',
  },
  failed: {
    title: 'Sign-in didn’t work',
    body: 'Something went wrong, and nothing changed. Try again.',
    tone: 'error',
  },
  // A sign-in with no session counts toward the API's guest account limit,
  // so a shared network, such as a club's wifi, can reach it. The alert adds
  // the time from `retry_after` when the URL has one.
  rate_limited: {
    title: 'Too many sign-ins from this network',
    body: 'Many people on this network are signing in at once. Wait a minute, then try again.',
    tone: 'error',
  },
  // A replay, such as Back to the provider after a sign-in that worked. The
  // person is often signed in already, so it gets no error colour.
  used: {
    title: 'Sign-in already finished',
    body: 'That sign-in already finished. If you’re not signed in, sign in again.',
    tone: 'neutral',
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

// When a rate-limited sign-in can try again: `retry_after` seconds from now,
// or null if the value isn't a positive number of seconds.
export function parseRetryAfter(value: unknown): Date | null {
  const seconds = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + seconds * 1000)
    : null
}
