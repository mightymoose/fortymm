import type { ChannelSetupNudgeProps } from './channel-setup-nudge'
import { channelSetupNudge } from './channel-setup-nudge-content'

/** Default scenario: the real "add an email" nudge (no address on file),
 * sourced from the production resolver so the fixture can't drift from it. */
export function buildChannelSetupNudgeProps(
  overrides: Partial<ChannelSetupNudgeProps> = {},
): ChannelSetupNudgeProps {
  return { ...channelSetupNudge('email', null)!, ...overrides }
}
