// Shared inline-style objects for the FortyMM login flow. Kept in a plain
// (component-free) module so both login-screens.tsx and the token-check page
// can reuse them without tripping react-refresh's "components only" rule.

import type { CSSProperties } from 'react'

export const btnPrimary: CSSProperties = {
  appearance: 'none',
  border: '1px solid var(--ball-500)',
  background: 'var(--ball-500)',
  color: 'var(--ink-950)',
  fontFamily: 'var(--font-ui)',
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: '0.01em',
  padding: '14px 18px',
  borderRadius: 'var(--r-md)',
  cursor: 'pointer',
  boxShadow: 'var(--shadow-glow)',
  textAlign: 'center',
  textDecoration: 'none',
  display: 'inline-block',
}

export const btnGhost: CSSProperties = {
  appearance: 'none',
  border: '1px solid var(--ink-500)',
  background: 'transparent',
  color: 'var(--fg-2)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  fontWeight: 600,
  padding: '14px 18px',
  borderRadius: 'var(--r-md)',
  cursor: 'pointer',
}

export const fineprint: CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: 12.5,
  lineHeight: 1.55,
  color: 'var(--fg-3)',
  marginTop: 2,
}

export const linkInline: CSSProperties = {
  color: 'var(--ball-500)',
  textDecoration: 'underline',
  textDecorationColor: 'rgba(255,122,26,0.4)',
  textUnderlineOffset: '2px',
  cursor: 'pointer',
}
