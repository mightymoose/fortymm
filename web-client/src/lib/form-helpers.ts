import type { CSSProperties } from 'react'

// Off-screen but still focusable so AT users hear "Leave this empty" — bots
// pattern-match every visible field, then fill blanks anyway. Honeypots work
// by being targeted by automation, not by being invisible to humans.
export const HONEYPOT_STYLE: CSSProperties = {
  position: 'absolute',
  left: '-9999px',
  width: 1,
  height: 1,
  opacity: 0,
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export interface Validation {
  ok: boolean
  err?: string
}

export function validateEmail(e: string): Validation {
  if (!e) return { ok: false, err: 'Email is required to claim your account.' }
  if (!EMAIL_RE.test(e))
    return { ok: false, err: "That doesn't look like a valid email." }
  return { ok: true }
}

export function isValidEmail(e: string): boolean {
  return EMAIL_RE.test(e)
}
