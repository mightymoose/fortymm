import type { ClaudeAccessStatus } from '../claude-access-query'
import type { StatusRowProps } from './status-row'

/** A player who is permitted, has an email, and has connected nothing yet —
 * the state the setup panel is written for, and the row's default. */
export function buildReadyStatus(
  overrides: Partial<Extract<ClaudeAccessStatus, { kind: 'ready' }>> = {},
): ClaudeAccessStatus {
  return { kind: 'ready', email: 'rita@example.com', ...overrides }
}

/** A player with an agent already linked, on 12 May 2026. */
export function buildConnectedStatus(
  overrides: Partial<Extract<ClaudeAccessStatus, { kind: 'connected' }>> = {},
): ClaudeAccessStatus {
  return {
    kind: 'connected',
    email: 'rita@example.com',
    connectedOn: 'May 12, 2026',
    ...overrides,
  }
}

/** Props for `StatusRow` — ready to connect unless a test says otherwise. */
export function buildStatusRowProps(
  overrides: Partial<StatusRowProps> = {},
): StatusRowProps {
  return { status: buildReadyStatus(), ...overrides }
}
