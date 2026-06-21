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

// RFC 5321 caps a forward-path address at 254 characters. The API enforces
// this and 422s with a raw pydantic message ("...The email address is too
// long (N characters too many)"); mirror the cap here so the badge flips to
// FAILED before submit instead of leaking that server string.
export const MAX_EMAIL_LENGTH = 254

// RFC 5321 §4.5.3.1.1 also caps the local part (before the @) at 64 chars. The
// API rejects an oversize local part with a 422 (#615); mirror it so the badge
// flips to FAILED before submit instead of leaking that server string.
export const MAX_EMAIL_LOCAL_PART_LENGTH = 64

export interface Validation {
  ok: boolean
  err?: string
}

export function validateEmail(e: string): Validation {
  if (!e) return { ok: false, err: 'Email is required to claim your account.' }
  if (!isValidEmail(e))
    return { ok: false, err: "That doesn't look like a valid email." }
  return { ok: true }
}

export function isValidEmail(e: string): boolean {
  // EMAIL_RE guarantees a single '@', so the local part is everything before it.
  return (
    e.length <= MAX_EMAIL_LENGTH &&
    EMAIL_RE.test(e) &&
    e.slice(0, e.lastIndexOf('@')).length <= MAX_EMAIL_LOCAL_PART_LENGTH
  )
}
