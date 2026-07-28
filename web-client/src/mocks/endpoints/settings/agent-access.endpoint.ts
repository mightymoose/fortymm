import { type HttpResponseResolver, http } from 'msw'
import type { components } from '@/api/schema'
import type { server } from '../../server'
import type { worker } from '../../browser'

type Backend = typeof server | typeof worker
type AgentAccessResponse = components['schemas']['AgentAccessResponse']

export type AgentAccessResolver = HttpResponseResolver<
  never,
  never,
  AgentAccessResponse
>

/**
 * Stub `GET /v1/settings/agent-access` — the Claude access page's BFF endpoint.
 *
 * `handlers.ts` registers a default (the `ready` state) so `npm run dev` and any
 * test that merely renders the page have something to answer with; override it
 * here to put the page in one of the other states, or to fail the load.
 */
export const mockAgentAccessEndpoint = (
  backend: Backend,
  resolver: AgentAccessResolver,
) => backend.use(http.get('*/v1/settings/agent-access', resolver))
