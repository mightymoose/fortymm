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

/**
 * Stub `POST /v1/settings/agent-access/allow` — the way back out of the
 * `revoked` state.
 *
 * Answers with the same `AgentAccessResponse` as the GET, because that is what
 * the endpoint returns: the page's whole new state, so the client needs no
 * follow-up read. `handlers.ts` registers a default that flips the dev world to
 * `ready`; override here to fail the call, or to report a different state.
 */
export const mockAllowAgentAccessEndpoint = (
  backend: Backend,
  resolver: AgentAccessResolver,
) => backend.use(http.post('*/v1/settings/agent-access/allow', resolver))

/**
 * Stub `POST /v1/settings/agent-access/disconnect` — the connected card's
 * destructive action.
 *
 * Answers with the same `AgentAccessResponse` as the GET, for the same reason
 * the allow endpoint does: it returns the page's whole new state (ordinarily
 * `revoked`), so the client re-renders from the mutation's own result.
 * `handlers.ts` registers a default; override here to fail the call, or to
 * report a different state.
 */
export const mockDisconnectAgentAccessEndpoint = (
  backend: Backend,
  resolver: AgentAccessResolver,
) => backend.use(http.post('*/v1/settings/agent-access/disconnect', resolver))
