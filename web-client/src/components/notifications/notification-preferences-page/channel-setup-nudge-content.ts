import { Mail, Smartphone } from 'lucide-react'
import type { NotificationChannel } from '@/api/notifications'
import type { ChannelSetupNudgeProps } from './channel-setup-nudge'

/** Per-channel nudge copy + deep-link target, keyed by channel. Only the
 * channels a user can fail to set up appear here; the preferences view looks a
 * channel up and renders the nudge when the server marks it `setup_required`.
 *
 * Both CTAs deep-link into the settings page rather than re-implementing the
 * work: `sec-email` is the captcha-protected add-email form (which auto-focuses
 * on the deep link), and `sec-notifications` carries the iOS install + allow
 * instructions and the test-push button. */
export const CHANNEL_SETUP_NUDGE: Partial<
  Record<NotificationChannel, ChannelSetupNudgeProps>
> = {
  email: {
    title: 'Add your email to get match results in your inbox.',
    body: "We'll send a sign-in link to confirm it. No marketing — ever.",
    cta: { label: 'Add email', hash: 'sec-email', Icon: Mail },
  },
  push: {
    title: 'Turn on push to get pinged the second your match is called.',
    body: 'Install the FortyMM app and allow notifications to start receiving pushes.',
    cta: { label: 'Set up push', hash: 'sec-notifications', Icon: Smartphone },
  },
}
