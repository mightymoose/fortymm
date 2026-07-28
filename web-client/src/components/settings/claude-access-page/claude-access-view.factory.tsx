import type {
  ClaudeAccessView as ClaudeAccessViewModel,
  ClaudeConnector,
} from './claude-access-query'
import type { ClaudeAccessViewProps } from './claude-access-view'

/** A configured deployment's connector pair. */
export function buildClaudeConnector(
  overrides: Partial<ClaudeConnector> = {},
): ClaudeConnector {
  return {
    url: 'https://fortymm.com/api/mcp/',
    client_id: 'aBcD1234eFgH5678',
    ...overrides,
  }
}

/**
 * The page as a permitted player with an email and nothing connected yet sees
 * it: ready to connect, connector configured, grant summary still to read.
 */
export function buildClaudeAccessView(
  overrides: Partial<ClaudeAccessViewModel> = {},
): ClaudeAccessViewModel {
  return {
    username: 'rita.kovac',
    status: { kind: 'ready', email: 'rita@example.com' },
    connector: buildClaudeConnector(),
    showsPermissionsSummary: true,
    ...overrides,
  }
}

/** Props for `ClaudeAccessView`. */
export function buildClaudeAccessViewProps(
  overrides: Partial<ClaudeAccessViewProps> = {},
): ClaudeAccessViewProps {
  return { view: buildClaudeAccessView(), ...overrides }
}
