import { useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Smartphone, X } from 'lucide-react'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

const MONO = "'JetBrains Mono', ui-monospace, monospace"

// Reappears every browser session. We don't gate harder than that — the
// design's whole point is a quiet recurring reminder, not a one-shot.
export const GUEST_PERSIST_DISMISS_KEY = 'fm:guest-persist:dismissed'

function isDismissedThisSession(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.sessionStorage.getItem(GUEST_PERSIST_DISMISS_KEY) === '1'
  } catch {
    // sessionStorage throws in some embed/private modes; treat as not
    // dismissed so the banner still surfaces.
    return false
  }
}

function rememberDismissal() {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(GUEST_PERSIST_DISMISS_KEY, '1')
  } catch {
    // Swallow — the visual dismissal is enough; we just won't persist it.
  }
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        font: `600 14px ${MONO}`,
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--chalk-50)',
        letterSpacing: '-0.01em',
      }}
    >
      {children}
    </span>
  )
}

type GuestPersistBannerProps = {
  matchCount: number
  rating: number | null
  style?: CSSProperties
}

// A dismissible "your data is local-only" nudge for guests. Built on the
// design-system Alert (it's a status message, not a content panel): bare
// leading icon, AlertDescription for the copy, and the AlertAction slot for
// the dismiss control. Tinted with the ball accent to match the rest of the
// guest-conversion surface.
export function GuestPersistBanner({
  matchCount,
  rating,
  style,
}: GuestPersistBannerProps) {
  const [dismissed, setDismissed] = useState(() => isDismissedThisSession())

  if (dismissed) return null

  return (
    <Alert
      data-testid="dashboard-guest-persist-banner"
      role="status"
      className="mb-5 border-[color:var(--ball-500)]/25 bg-[color:var(--ball-500)]/8"
      style={style}
    >
      <Smartphone className="text-[color:var(--ball-400)]" aria-hidden />
      <AlertDescription className="text-[color:var(--fg-2)]">
        <span>Your </span>
        <Mono>{matchCount}</Mono>
        <span> {matchCount === 1 ? 'match' : 'matches'}</span>
        {rating !== null && (
          <>
            <span> and rating </span>
            <Mono>{rating}</Mono>
          </>
        )}
        <span className="text-[color:var(--chalk-300)]"> live on this device only. </span>
        <Link
          to="/settings"
          hash="sec-email"
          className="font-semibold whitespace-nowrap text-[color:var(--ball-400)]"
        >
          Add an email to keep them →
        </Link>
      </AlertDescription>
      <AlertAction className="top-1/2 -translate-y-1/2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss for this session"
          className="text-[color:var(--chalk-500)]"
          onClick={() => {
            rememberDismissal()
            setDismissed(true)
          }}
        >
          <X />
        </Button>
      </AlertAction>
    </Alert>
  )
}
