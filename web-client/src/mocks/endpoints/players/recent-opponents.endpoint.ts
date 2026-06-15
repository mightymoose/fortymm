import { type HttpResponseResolver, http } from 'msw'
import type { components } from '@/api/schema'
import type { server } from '../../server'
import type { worker } from '../../browser'

type Backend = typeof server | typeof worker
type PlayerRead = components['schemas']['PlayerRead']

export type RecentOpponentsResolver = HttpResponseResolver<
  never,
  never,
  PlayerRead[]
>

export const mockRecentOpponentsEndpoint = (
  backend: Backend,
  resolver: RecentOpponentsResolver,
) => backend.use(http.get('*/v1/players/recent', resolver))
