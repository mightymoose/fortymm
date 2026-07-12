import { type HttpResponseResolver, http } from 'msw'
import type { components } from '@/api/schema'
import type { server } from '../../server'
import type { worker } from '../../browser'

type Backend = typeof server | typeof worker
type PlayerMatchListResponse = components['schemas']['PlayerMatchListResponse']

export type PlayerMatchesResolver = HttpResponseResolver<
  { playerId: string },
  never,
  PlayerMatchListResponse
>

/**
 * Stub `GET /v1/players/:playerId/matches` — the **paginated match history**,
 * which backs `/players/$userId/matches` and nothing else.
 *
 * The profile does *not* use it: its Recent-matches card reads the six rows the
 * profile bundle already carries. A profile test that wants to prove that can't
 * do it by leaving this endpoint unstubbed — `handlers.ts` registers a global
 * handler for it, which `resetHandlers()` restores between tests, so MSW would
 * answer it happily. It has to override the handler with a *watching* one and
 * assert it was never called.
 */
export const mockPlayerMatchesEndpoint = (
  backend: Backend,
  resolver: PlayerMatchesResolver,
) => backend.use(http.get('*/v1/players/:playerId/matches', resolver))
