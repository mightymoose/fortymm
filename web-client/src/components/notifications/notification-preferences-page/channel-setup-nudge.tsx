import { Link } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

export interface ChannelSetupNudgeProps {
  /** The payoff headline for finishing setup. */
  title: string
  /** One-line supporting detail under the headline. */
  body: string
  /** The call-to-action. It deep-links to the settings section that does the
   * real work (the captcha-protected email form, or the push instructions) —
   * we don't duplicate either flow here. */
  cta: {
    label: string
    /** Settings-page section anchor, e.g. `sec-email`. The settings route
     * honours `/settings#sec-*` deep links (and focuses the email field). */
    hash: string
    Icon: LucideIcon
  }
}

/** An inline prompt under a channel "sign-up" card, shown when the channel is
 * available but the user hasn't finished setting it up (no confirmed email; no
 * registered push devices). Built on the design-system Alert — it's a status
 * nudge, not a content panel — and tinted with the ball accent so it reads as
 * an opportunity rather than an error. */
export function ChannelSetupNudge({ title, body, cta }: ChannelSetupNudgeProps) {
  const { Icon } = cta
  return (
    <Alert
      role="status"
      className="mt-3 border-[color:var(--ball-500)]/28 bg-[color:var(--ball-500)]/8"
    >
      <AlertTitle className="text-[13.5px] font-semibold text-[color:var(--ball-200)]">
        {title}
      </AlertTitle>
      <AlertDescription className="text-[13px] text-[color:var(--fg-3)]">
        {body}
      </AlertDescription>
      <Button asChild size="sm" className="mt-3 w-fit">
        <Link to="/settings" hash={cta.hash}>
          <Icon />
          {cta.label}
        </Link>
      </Button>
    </Alert>
  )
}
