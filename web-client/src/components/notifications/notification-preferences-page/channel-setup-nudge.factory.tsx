import type { ChannelSetupNudgeProps } from './channel-setup-nudge'
import { CHANNEL_SETUP_NUDGE } from './channel-setup-nudge-content'

/** Default scenario: the real email setup nudge (no confirmed address on file),
 * sourced from the production content map so the fixture can't drift from it. */
export function buildChannelSetupNudgeProps(
  overrides: Partial<ChannelSetupNudgeProps> = {},
): ChannelSetupNudgeProps {
  return { ...CHANNEL_SETUP_NUDGE.email!, ...overrides }
}
