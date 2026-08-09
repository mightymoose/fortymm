import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
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
  // Mirrors `AgentAccessState` in `schema.d.ts`, member for member. `revoked`
  // is the player's own switch-off (see the disconnecting-an-agent ADR) and is
  // distinct from `gated`, which is the operator's.
  state: z.enum(['guest', 'gated', 'revoked', 'ready', 'connected']),
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
  /** The player switched agent access off themselves. Carries nothing: the row
   * is a sentence and one button, and neither needs an email — the way back is
   * "allow", not "sign in with X". */
  | { kind: 'revoked' }
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
   * none — in which case the panel must not render at all (rather than render
   * with empty fields). A `ready` player then reads `unavailable`; every other
   * state keeps its own row and its own action. */
  connector: ClaudeConnector | null
  /** Whether to render the "what you're granting" summary. Hidden once an agent
   * is connected: the grant has already been made, and the card above it says
   * so. */
  showsPermissionsSummary: boolean
}

/**
 * Project the BFF payload onto the page's view model.
 *
 * Two readings are deliberately fail-closed, and both collapse the **`ready`**
 * row — and only that row — to `unavailable`, the row that says "we couldn't
 * load your account and connector details":
 *
 * 1. **No connector.** The deployment has no MCP OAuth configuration, so there
 *    is nothing for the player to paste, and the setup panel is the whole of
 *    what `ready` means.
 * 2. **`ready` with no email.** The server cannot produce this (a player with no
 *    email resolves to `guest`), but the ready row's whole content is *which
 *    email to sign in with* — "Use —" is a dead end, so we decline to render it.
 *
 * Neither reading may outrank the other states, and a missing connector
 * emphatically must not: it once won over all five, which took the Disconnect
 * button off a `connected` page and the re-allow button off a `revoked` one —
 * a live agent with no off switch, under copy claiming we could not load the
 * account. What the *deployment* advertises says nothing about whether *this
 * player* is connected, and once they are, the action is the point.
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
  switch (payload.state) {
    case 'guest':
      return { kind: 'guest' }
    case 'gated':
      return { kind: 'gated' }
    case 'revoked':
      return { kind: 'revoked' }
    case 'ready':
      // `ready` is the ONE state a missing connector can empty out: the setup
      // panel is its whole content, so with nothing to paste there is nothing
      // to show but the fail-closed row. A missing email is the same dead end
      // ("Use —"), so both fail the same way.
      //
      // A missing connector must NOT outrank the states below it. It used to,
      // and that took the Disconnect button off a `connected` page and the
      // re-allow button off a `revoked` one — leaving a live agent with no off
      // switch, under copy claiming we could not load the account. Whether the
      // deployment advertises a connector says nothing about whether THIS
      // player is connected, and only the actions matter once they are.
      return payload.email === null || payload.connector === null
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

const allowAgentAccess = async (): Promise<AgentAccessPayload> =>
  agentAccessSchema.parse(
    unwrap(
      'allow Claude to connect',
      await api.POST('/v1/settings/agent-access/allow'),
    ),
  )

/**
 * The shape both of this page's writes share: the endpoint answers with the
 * page's whole new payload, not an acknowledgement, so the success path
 * **writes it into the cache** instead of invalidating.
 *
 * Two reasons: the server has just told us the answer, so a follow-up GET is a
 * round trip for a fact we already hold; and an invalidation would blank
 * nothing but would let a slow refetch re-render the *old* row after the player
 * has already been told the write worked. The payload is parsed on the way in —
 * a mutation response is as untrusted as any other network payload, and priming
 * the cache with an unparsed body would smuggle past the query's own boundary.
 */
function useAgentAccessMutation(mutationFn: () => Promise<AgentAccessPayload>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (payload) => {
      // The options object's own `queryKey`, so the write is type-checked
      // against what the query caches (the payload, before `select`) rather
      // than against a bare tuple.
      queryClient.setQueryData(claudeAccessQuery().queryKey, payload)
    },
  })
}

/**
 * `POST /v1/settings/agent-access/allow` — clear the player's own revocation.
 *
 * Revocation is deliberately sticky (there is no timer and no implicit clear),
 * so this is the *only* way back: a revoked player who follows the connector
 * setup steps again is refused by the MCP transport with a silent 401, forever.
 * Hence the control it drives is load-bearing rather than decorative.
 */
export function useAllowAgentAccess() {
  return useAgentAccessMutation(allowAgentAccess)
}

const disconnectAgentAccess = async (): Promise<AgentAccessPayload> =>
  agentAccessSchema.parse(
    unwrap(
      'disconnect Claude',
      await api.POST('/v1/settings/agent-access/disconnect'),
    ),
  )

/**
 * `POST /v1/settings/agent-access/disconnect` — switch agent access off.
 *
 * What it stops is wider than its name: revocation is recorded on the *user*,
 * so it cuts off every agent signed in with this account's email, and it holds
 * against tokens already issued (the MCP transport re-reads the flag per
 * request). See the disconnecting-an-agent ADR — the dialog's copy is making
 * that promise, and this is the call that keeps it.
 */
export function useDisconnectAgentAccess() {
  return useAgentAccessMutation(disconnectAgentAccess)
}
