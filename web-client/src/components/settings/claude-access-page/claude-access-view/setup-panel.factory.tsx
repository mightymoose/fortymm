import { buildClaudeConnector } from '../claude-access-view.factory'
import type { SetupPanelProps } from './setup-panel'

/** The panel as the only player who ever sees it does: permitted, emailed, and
 * with nothing connected yet, on a deployment whose connector is configured. */
export function buildSetupPanelProps(
  overrides: Partial<SetupPanelProps> = {},
): SetupPanelProps {
  return {
    connector: buildClaudeConnector(),
    email: 'rita@example.com',
    ...overrides,
  }
}
