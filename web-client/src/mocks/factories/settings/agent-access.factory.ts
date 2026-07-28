import type { components } from '@/api/schema'

export type AgentAccessResponse = components['schemas']['AgentAccessResponse']
export type AgentAccessConnector = components['schemas']['AgentAccessConnector']

/** A configured deployment's connector pair — the two values a player pastes
 * into Claude's "Add custom connector". */
export function buildAgentAccessConnector(
  overrides: Partial<AgentAccessConnector> = {},
): AgentAccessConnector {
  return {
    url: 'https://fortymm.com/api/mcp/',
    client_id: 'aBcD1234eFgH5678',
    ...overrides,
  }
}

/**
 * `GET /v1/settings/agent-access` for a permitted player with a confirmed email
 * who has connected nothing yet — the `ready` state, on a deployment whose
 * connector is configured.
 *
 * `connected_on` is null here because nothing is linked; the `connected` state
 * is the one that carries it.
 */
export function buildAgentAccess(
  overrides: Partial<AgentAccessResponse> = {},
): AgentAccessResponse {
  return {
    state: 'ready',
    email: 'rita@example.com',
    username: 'rita.kovac',
    connected_on: null,
    connector: buildAgentAccessConnector(),
    ...overrides,
  }
}
