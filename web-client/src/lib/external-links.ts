/**
 * Off-site URLs the app links to from more than one surface. One name, one
 * place — a URL written twice drifts, and half the app then points at a dead
 * beta.
 */

/**
 * The app's public TestFlight beta — anyone with the link can join, no invite
 * needed. Linked from the signed-in sidebar footer (`app-shell.tsx`) and the
 * landing page's CTA band (`App.tsx`), which must agree.
 */
export const TESTFLIGHT_URL = 'https://testflight.apple.com/join/5pGVbku3'
