import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'

import { api, unwrap } from '@/api/client'
import { fmtDate } from '@/lib/dates'

/** What a value reads as when the server sent us nothing for it. */
const EM_DASH = '—'

/** The pair a player pastes into Claude's "Add custom connector".
 *
 * All-or-nothing on the wire: the server resolves it from *its own*
 * configuration, so it is absent whenever either half is missing, in every
 * player state. A half-filled connector would have a player paste an empty
 * client id and hit an inscrutable failure. */
const connectorSchema = z.object({
  url: z.string(),
  client_id: z.string(),
})

/**
 * `GET /v1/settings/agent-access`, parsed.
 *
 * The generated `schema.d.ts` types this at compile time; this is the runtime
 * guarantee (`.claude/rules/parse-at-boundaries.md`). A payload that doesn't
 * match fails here, at the fetch boundary, rather than surfacing as an empty
 * consent screen — which is the one failure mode this page must not have.
 */
const agentAccessSchema = z.object({
  state: z.enum(['guest', 'gated', 'ready', 'connected']),
  email: z.string().nullable(),
  username: z.string(),
  connected_on: z.string().nullable(),
  connector: connectorSchema.nullable(),
})

/** The parsed `GET /v1/settings/agent-access` payload. */
export type AgentAccessPayload = z.infer<typeof agentAccessSchema>

/** The connector pair, once parsed. */
export type ClaudeConnector = z.infer<typeof connectorSchema>

/**
 * Which status row the page renders — exactly one, chosen here so the display
 * never re-derives it from a handful of nullable fields.
 *
 * `unavailable` is not one of the server's states: it is this client's
 * fail-closed reading of a response it cannot act on (see `selectClaudeAccess`).
 */
export type ClaudeAccessStatus =
  | { kind: 'unavailable' }
  | { kind: 'guest' }
  | { kind: 'gated' }
  | { kind: 'ready'; email: string }
  /** `email` / `connectedOn` are display-ready — an em dash when the server sent
   * null, never an empty field. */
  | { kind: 'connected'; email: string; connectedOn: string }

/** Everything the Claude access page renders below its header. */
export interface ClaudeAccessView {
  /** The account every agent action will appear under. Empty only when the load
   * failed, in which case `showsPermissionsSummary` is false and no copy needs
   * it. */
  username: string
  /** The one status row to render. */
  status: ClaudeAccessStatus
  /** The connector pair for the setup panel, or `null` when this deployment has
   * none — in which case `status` is `unavailable` and the panel must not
   * render at all (rather than render with empty fields). */
  connector: ClaudeConnector | null
  /** Whether to render the "what you're granting" summary. Hidden once an agent
   * is connected: the grant has already been made, and the card above it says
   * so. */
  showsPermissionsSummary: boolean
}

/**
 * Project the BFF payload onto the page's view model.
 *
 * Two readings are deliberately fail-closed, and both collapse to
 * `unavailable` — the row that says "we couldn't load your account and
 * connector details":
 *
 * 1. **No connector.** The deployment has no MCP OAuth configuration, so there
 *    is nothing for the player to paste. Reported independently of the player's
 *    own state, so it wins over all four of them.
 * 2. **`ready` with no email.** The server cannot produce this (a player with no
 *    email resolves to `guest`), but the ready row's whole content is *which
 *    email to sign in with* — "Use —" is a dead end, so we decline to render it.
 *
 * `connected` is never collapsed, even with fields missing: telling a player an
 * agent is connected is more important than the two facts about it, so those
 * degrade to an em dash instead.
 */
export function selectClaudeAccess(
  payload: AgentAccessPayload,
): ClaudeAccessView {
  return {
    username: payload.username,
    status: resolveStatus(payload),
    connector: payload.connector,
    // Keyed off the SERVER's state, not off the resolved status: a connected
    // player on a deployment with no connector still has nothing left to grant,
    // and a player whose connector is missing for any other reason still
    // deserves to read what connecting would mean.
    showsPermissionsSummary: payload.state !== 'connected',
  }
}

function resolveStatus(payload: AgentAccessPayload): ClaudeAccessStatus {
  if (payload.connector === null) return { kind: 'unavailable' }
  switch (payload.state) {
    case 'guest':
      return { kind: 'guest' }
    case 'gated':
      return { kind: 'gated' }
    case 'ready':
      return payload.email === null
        ? { kind: 'unavailable' }
        : { kind: 'ready', email: payload.email }
    case 'connected':
      return {
        kind: 'connected',
        email: payload.email ?? EM_DASH,
        connectedOn: fmtDate(payload.connected_on),
      }
  }
}

/**
 * The view for a load that failed outright — same fail-closed row as a missing
 * connector, and with no username to name we also drop the permissions summary
 * (its first line is "everything appears under {username}").
 */
export function claudeAccessLoadFailedView(): ClaudeAccessView {
  return {
    username: '',
    status: { kind: 'unavailable' },
    connector: null,
    showsPermissionsSummary: false,
  }
}

/** The one place this cache's key is spelled. */
export const claudeAccessQueryKey = () =>
  [{ scope: 'settings', version: 'v1', entity: 'agent-access' }] as const

const fetchAgentAccess = async (): Promise<AgentAccessPayload> =>
  agentAccessSchema.parse(
    unwrap('load Claude access', await api.GET('/v1/settings/agent-access')),
  )

/** The Claude access page's BFF query, projected onto its view model. */
export function claudeAccessQuery() {
  return queryOptions({
    queryKey: claudeAccessQueryKey(),
    queryFn: fetchAgentAccess,
    select: selectClaudeAccess,
  })
}
