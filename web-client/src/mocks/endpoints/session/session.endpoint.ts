import { type HttpResponseResolver, http } from 'msw'

import type { components } from '@/api/schema'

import type { worker } from '../../browser'
import type { server } from '../../server'

type Backend = typeof server | typeof worker
type SessionResponse = components['schemas']['SessionResponse']

export type SessionResolver = HttpResponseResolver<never, never, SessionResponse>

/**
 * Stub `GET /v1/session` — who is *looking* at the page.
 *
 * Needed by anything viewer-aware (ADR-0915): the profile's confidence card
 * turns its copy to the second person when the session's own `user.id` is the
 * id of the player being viewed, so a test of that behavior has to be able to
 * say who the caller is.
 *
 * `handlers.ts` registers a global session handler, so an unstubbed test still
 * gets *a* session — just not one whose id you chose. Override it here when the
 * identity is the thing under test.
 */
export const mockSessionEndpoint = (backend: Backend, resolver: SessionResolver) =>
  backend.use(http.get('*/v1/session', resolver))
