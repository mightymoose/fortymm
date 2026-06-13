// Shared brand atoms + style objects for the FortyMM login flow. Lifted out of
// login-screens.tsx so the focused token-check page (link-check-page) can reuse
// the exact same vocabulary without copy-paste. Importing this module also pulls
// in login.css (the spin keyframe + decorative-chrome classes) for any consumer.

import type { ReactNode } from 'react'

import './login.css'

export function BallLogo({ size = 26 }: { size?: number }) {
  const gradId = `fmm-login-lg-${size}`
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <svg width={size} height={size} viewBox="0 0 80 80" aria-hidden="true">
        <defs>
          <radialGradient id={gradId} cx="35%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#FFB57A" />
            <stop offset="55%" stopColor="#FF7A1A" />
            <stop offset="100%" stopColor="#B94700" />
          </radialGradient>
        </defs>
        <circle cx="40" cy="40" r="36" fill={`url(#${gradId})`} />
        <ellipse cx="30" cy="28" rx="10" ry="6" fill="#FFF" fillOpacity="0.22" />
      </svg>
      <span
        style={{
          fontFamily: "'Bebas Neue', sans-serif",
          fontSize: size * 0.95,
          letterSpacing: '0.04em',
          color: 'var(--fg-1)',
          lineHeight: 1,
        }}
      >
        FORTYMM<span style={{ color: 'var(--ball-500)' }}>.</span>
      </span>
    </div>
  )
}

export function Eyebrow({
  children,
  color = 'var(--ball-500)',
}: {
  children: ReactNode
  color?: string
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0,
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color,
      }}
    >
      {children}
    </div>
  )
}

export function RedirectStrip({ dest }: { dest: string }) {
  return (
    <div
      style={{
        marginTop: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        borderRadius: 'var(--r-md)',
        background: 'rgba(0,226,154,0.08)',
        border: '1px solid rgba(0,226,154,0.3)',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          fontWeight: 700,
          color: 'var(--serve-500)',
          letterSpacing: '0.16em',
        }}
      >
        ● REDIRECTING
      </span>
      <span
        style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-2)' }}
      >
        {dest}
      </span>
      <span style={{ flex: 1 }} />
      <span
        style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-3)' }}
      >
        2s
      </span>
      <span
        style={{ fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--serve-500)' }}
      >
        →
      </span>
    </div>
  )
}
