import { Mail, Smartphone } from 'lucide-react'
import type { NotificationChannel } from '@/api/notifications'
import type { ChannelSetupNudgeProps } from './channel-setup-nudge'

/** Per-channel nudge copy + deep-link target. Both CTAs deep-link into the
 * settings page rather than re-implementing the work: `sec-email` is the
 * captcha-protected add-email form (which auto-focuses on the deep link), and
 * `sec-notifications` carries the iOS install + allow instructions and the
 * test-push button. */

const PUSH_SETUP_NUDGE: ChannelSetupNudgeProps = {
  title: 'Turn on push to get pinged the second your match is called.',
  body: 'Install the FortyMM app and allow notifications to start receiving pushes.',
  cta: { label: 'Set up push', hash: 'sec-notifications', Icon: Smartphone },
}

const EMAIL_ADD_NUDGE: ChannelSetupNudgeProps = {
  title: 'Add your email to get match results in your inbox.',
  body: "We'll send a sign-in link to confirm it. No marketing — ever.",
  cta: { label: 'Add email', hash: 'sec-email', Icon: Mail },
}

/** When an address is on file but not yet confirmed, the channel still can't
 * deliver — but "add an email" is wrong (they already did). Acknowledge the
 * pending address and point them at the confirm/resend controls. */
function emailPendingNudge(address: string): ChannelSetupNudgeProps {
  return {
    title: 'Confirm your email to start getting results.',
    body: `We sent a link to ${address}. Click it to finish — or resend it from settings.`,
    cta: { label: 'Manage email', hash: 'sec-email', Icon: Mail },
  }
}

/** The setup nudge to show under a channel card, or `undefined` if the channel
 * has no nudge. Email has two sub-states: no address (add) vs. an address
 * awaiting confirmation (`pendingEmail`). In-app and SMS never nudge. */
export function channelSetupNudge(
  channel: NotificationChannel,
  pendingEmail: string | null,
): ChannelSetupNudgeProps | undefined {
  if (channel === 'push') return PUSH_SETUP_NUDGE
  if (channel === 'email') {
    return pendingEmail ? emailPendingNudge(pendingEmail) : EMAIL_ADD_NUDGE
  }
  return undefined
}
