import { useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { X } from 'lucide-react'

const C = {
  ink800: 'var(--ink-800)',
  chalk50: 'var(--chalk-50)',
  chalk100: 'var(--chalk-100)',
  chalk300: 'var(--chalk-300)',
  chalk500: 'var(--chalk-500)',
  ball400: 'var(--ball-400)',
}

const UI = "'Space Grotesk', ui-sans-serif, system-ui, sans-serif"
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

function Mono({
  children,
  color = C.chalk50,
}: {
  children: ReactNode
  color?: string
}) {
  return (
    <span
      style={{
        font: `600 14px ${MONO}`,
        fontVariantNumeric: 'tabular-nums',
        color,
        letterSpacing: '-0.01em',
      }}
    >
      {children}
    </span>
  )
}

function DeviceIcon({ size = 15, color }: { size?: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <rect
        x="6.5"
        y="3"
        width="11"
        height="18"
        rx="2.25"
        fill="none"
        stroke={color}
        strokeWidth="1.75"
      />
      <path
        d="M11 18h2"
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <circle cx="12" cy="9.5" r="1.6" fill={color} />
    </svg>
  )
}

type GuestPersistBannerProps = {
  matchCount: number
  rating: number | null
  style?: CSSProperties
}

export function GuestPersistBanner({
  matchCount,
  rating,
  style,
}: GuestPersistBannerProps) {
  const [dismissed, setDismissed] = useState(() => isDismissedThisSession())

  if (dismissed) return null

  return (
    <div
      data-testid="dashboard-guest-persist-banner"
      role="status"
      style={{
        position: 'relative',
        background: `linear-gradient(180deg, rgba(255,122,26,0.055) 0%, rgba(255,122,26,0.02) 100%), ${C.ink800}`,
        border: '1px solid rgba(255,122,26,0.22)',
        borderRadius: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '11px 12px 11px 14px',
        marginBottom: 20,
        overflow: 'hidden',
        ...style,
      }}
    >
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 7,
          background: 'rgba(255,122,26,0.10)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <DeviceIcon color={C.ball400} />
      </div>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          font: `400 14px ${UI}`,
          color: C.chalk100,
          lineHeight: 1.4,
        }}
      >
        <span>Your </span>
        <Mono>{matchCount}</Mono>
        <span> {matchCount === 1 ? 'match' : 'matches'}</span>
        {rating !== null && (
          <>
            <span> and rating </span>
            <Mono>{rating}</Mono>
          </>
        )}
        <span style={{ color: C.chalk300 }}> live on this device only. </span>
        <Link
          to="/settings"
          hash="sec-email"
          style={{
            color: C.ball400,
            fontWeight: 600,
            textDecoration: 'none',
            borderBottom: `1px solid ${C.ball400}`,
            paddingBottom: 1,
            whiteSpace: 'nowrap',
          }}
        >
          Add an email to keep them
        </Link>
        <span style={{ color: C.ball400, fontWeight: 600, marginLeft: 5 }}>
          →
        </span>
      </div>

      <button
        type="button"
        aria-label="Dismiss for this session"
        onClick={() => {
          rememberDismissal()
          setDismissed(true)
        }}
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          background: 'transparent',
          border: 'none',
          color: C.chalk500,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}
