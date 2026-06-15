import { type HttpResponseResolver, http } from 'msw'
import type { components } from '@/api/schema'
import type { server } from '../../server'
import type { worker } from '../../browser'

type Backend = typeof server | typeof worker
type PlayerRead = components['schemas']['PlayerRead']

export type PlayerSearchResolver = HttpResponseResolver<
  never,
  never,
  PlayerRead[]
>

export const mockPlayerSearchEndpoint = (
  backend: Backend,
  resolver: PlayerSearchResolver,
) => backend.use(http.get('*/v1/players/search', resolver))
