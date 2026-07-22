import { type HttpResponseResolver, http } from 'msw'

import type { components } from '@/api/schema'

import type { worker } from '../../browser'
import type { server } from '../../server'

type Backend = typeof server | typeof worker
type LinkStatus = components['schemas']['LinkStatus']

export type Auth0LinkResolver = HttpResponseResolver<never, never, LinkStatus>

/** Stub `GET /v1/auth0/link` — whether the current user has an Auth0 identity
 * bound. Drives the Settings "Agent access" section's Connect/Connected split. */
export const mockAuth0LinkStatusEndpoint = (
  backend: Backend,
  resolver: Auth0LinkResolver,
) => backend.use(http.get('*/v1/auth0/link', resolver))

/** Stub `DELETE /v1/auth0/link` — the Unlink action. Replies with the
 * now-cleared status. */
export const mockAuth0UnlinkEndpoint = (
  backend: Backend,
  resolver: Auth0LinkResolver,
) => backend.use(http.delete('*/v1/auth0/link', resolver))
