import type { components } from '@/api/schema'

type LinkStatus = components['schemas']['LinkStatus']

/**
 * The `GET`/`DELETE /v1/auth0/link` wire payload. Defaults to the **linked**
 * scenario (a user whose Auth0 identity is bound) — the state that shows the
 * Connected badge + Unlink control. Pass `{ linked: false }` for the
 * not-connected/Connect state.
 */
export function buildLinkStatus(overrides: Partial<LinkStatus> = {}): LinkStatus {
  return { linked: true, ...overrides }
}
