import { type HttpResponseResolver, http } from 'msw'
import type { components } from '@/api/schema'
import type { server } from '../../server'
import type { worker } from '../../browser'

type Backend = typeof server | typeof worker
type PlayerDetail = components['schemas']['PlayerDetail']

export type PlayerDetailResolver = HttpResponseResolver<
  { playerId: string },
  never,
  PlayerDetail
>

/**
 * Stub `GET /v1/players/:playerId` — the profile BFF bundle. Every card on the
 * profile projects off this one response (`playerByIdQueryOptions` + a `select`),
 * so this is the only endpoint a hero/rating-panel test needs to stub.
 */
export const mockPlayerDetailEndpoint = (
  backend: Backend,
  resolver: PlayerDetailResolver,
) => backend.use(http.get('*/v1/players/:playerId', resolver))
