import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, ReactNode } from 'react'

import { Turnstile, type TurnstileHandle } from '@/components/turnstile'
import { HONEYPOT_STYLE, isValidEmail } from '@/lib/form-helpers'

import { Wordmark } from '@/components/wordmark'
import { Eyebrow, RedirectStrip } from './atoms'
import { btnGhost, btnPrimary, fineprint, linkInline } from './styles'
import './login.css'

// Sign-in / confirmation links live 15 minutes — mirrors the API's
// LOGIN_TOKEN_LIFETIME. The countdown owns this so routes only pass send time.
const LOGIN_LINK_TTL_MS = 15 * 60 * 1000

// Resend is throttled for a short window after each send so a rapid click
// burst can't hammer the (per-hour rate-limited) request endpoint into a 429.
// Anchored on `sentAt`, which re-stamps on every send.
const RESEND_COOLDOWN_MS = 30 * 1000

/* ─── Brand atoms ───────────────────────────────────────────────────── */

function Display({
  children,
  color = 'var(--fg-1)',
  size = 84,
}: {
  children: ReactNode
  color?: string
  size?: number
}) {
  return (
    <h1
      style={{
        fontFamily: "'Bebas Neue', sans-serif",
        fontSize: `clamp(44px, 9cqi, ${size}px)`,
        lineHeight: 0.92,
        letterSpacing: '0.01em',
        color,
        margin: 0,
        textTransform: 'uppercase',
      }}
    >
      {children}
    </h1>
  )
}

/* ─── Shell ─────────────────────────────────────────────────────────── */

function Shell({
  left,
  right,
  glow = true,
}: {
  left: ReactNode
  right: ReactNode
  glow?: boolean
}) {
  return (
    <div className="fortymm-theme fmm-login">
      <div className="fmm-shell-frame">
        <div className="fmm-shell">
          <div className="fortymm-grid-bg fmm-shell__grid" aria-hidden="true" />
          {glow && <div className="fmm-shell__halo" aria-hidden="true" />}
          <div className="fmm-shell__left">{left}</div>
          <div className="fmm-shell__right">{right}</div>
        </div>
      </div>
    </div>
  )
}

function HeroCol({
  eyebrow,
  h1a,
  h1b,
  showSolverLine = true,
}: {
  eyebrow: ReactNode
  h1a: ReactNode
  h1b: ReactNode
  showSolverLine?: boolean
}) {
  return (
    <>
      <Wordmark size={26} />

      <div className="fmm-hero__body">
        <Eyebrow>{eyebrow}</Eyebrow>
        <div style={{ marginTop: 20 }}>
          <Display size={84}>
            {h1a}
            <br />
            <span style={{ color: 'var(--ball-500)' }}>{h1b}</span>
          </Display>
        </div>

        {showSolverLine && (
          <div className="fmm-hero__solver">
            <span style={{ color: 'var(--serve-500)' }}>●</span>
            <span style={{ textTransform: 'uppercase' }}>The math is quiet.</span>
            <span style={{ color: 'var(--serve-500)' }}>●</span>
            <span style={{ textTransform: 'uppercase' }}>The rallies are loud.</span>
          </div>
        )}
      </div>

      <div className="fmm-hero__footer">
        <span>fortymm.com/login</span>
        <span style={{ flex: 1, height: 1, background: 'var(--ink-600)' }} />
        <span>v2.4.1 · web</span>
      </div>
    </>
  )
}

/* ─── Form column scaffolding ───────────────────────────────────────── */

function FormCol({
  stepNo,
  stepLabel,
  title,
  subtitle,
  accent = 'var(--ball-500)',
  children,
}: {
  stepNo: string
  stepLabel: string
  title: ReactNode
  subtitle: ReactNode
  accent?: string
  children: ReactNode
}) {
  const numericStep = stepNo === '!!' ? -1 : parseInt(stepNo, 10)
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          marginBottom: 28,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.16em',
            color: accent,
            background: 'rgba(255,122,26,0.10)',
            border: '1px solid var(--ink-600)',
            padding: '4px 10px',
            borderRadius: 'var(--r-pill)',
          }}
        >
          {stepNo}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--fg-3)',
          }}
        >
          {stepLabel}
        </span>
        <span style={{ flex: 1, height: 1, background: 'var(--ink-600)' }} />
        <StepDots active={numericStep} />
      </div>

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          maxWidth: 440,
        }}
      >
        <h2
          style={{
            font: '600 26px/1.2 var(--font-ui)',
            letterSpacing: '-0.01em',
            color: 'var(--fg-1)',
            margin: 0,
          }}
        >
          {title}
        </h2>
        <p
          style={{
            font: '400 14.5px/1.55 var(--font-ui)',
            color: 'var(--fg-3)',
            margin: '0 0 8px',
            maxWidth: 420,
          }}
        >
          {subtitle}
        </p>
        {children}
      </div>
    </>
  )
}

function stepDotColor(n: number, active: number) {
  if (active === -1) return n === 4 ? 'var(--loss)' : 'var(--ink-500)'
  return n <= active ? 'var(--ball-500)' : 'var(--ink-600)'
}

function StepDots({ active }: { active: number }) {
  return (
    <div style={{ display: 'inline-flex', gap: 6 }}>
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          style={{
            width: n === active ? 18 : 6,
            height: 6,
            borderRadius: 999,
            background: stepDotColor(n, active),
            transition: 'all 200ms var(--ease-out)',
          }}
        />
      ))}
    </div>
  )
}

/* ─── Form parts ────────────────────────────────────────────────────── */

function EmailField({
  value,
  onChange,
  state = 'valid',
  autoFocus,
  readOnly = false,
}: {
  value: string
  onChange?: (next: string) => void
  state?: 'valid' | 'error' | 'neutral'
  autoFocus?: boolean
  readOnly?: boolean
}) {
  const error = state === 'error'
  // A pristine/incomplete field is neutral — show no badge rather than a
  // misleading green "VALID" on an empty input (#520).
  const neutral = state === 'neutral'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        background: 'var(--bg-card)',
        border: error
          ? '1px solid var(--loss)'
          : '1px solid var(--ink-500)',
        borderRadius: 'var(--r-md)',
        overflow: 'hidden',
        boxShadow: error
          ? '0 0 0 1px rgba(255,77,109,0.20), inset 0 1px 0 rgba(255,255,255,0.05)'
          : 'var(--shadow-inset)',
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 14px',
          borderRight: '1px solid var(--ink-600)',
          color: error ? 'var(--loss)' : 'var(--ball-500)',
          fontFamily: 'var(--font-mono)',
          fontSize: 14,
          fontWeight: 700,
          background: error ? 'rgba(255,77,109,0.06)' : 'rgba(255,122,26,0.06)',
        }}
      >
        @
      </span>
      <input
        type="email"
        autoComplete="email"
        autoFocus={autoFocus}
        value={value}
        readOnly={readOnly}
        onChange={readOnly ? undefined : (e) => onChange?.(e.target.value)}
        placeholder="you@yourclub.com"
        aria-label="Email address"
        aria-invalid={error || undefined}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          padding: '14px 14px',
          fontFamily: 'var(--font-mono)',
          fontSize: 15,
          fontWeight: 500,
          color: 'var(--fg-1)',
          letterSpacing: '0.01em',
        }}
      />
      {!neutral && (
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '0 14px',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: error ? 'var(--loss)' : 'var(--serve-500)',
            letterSpacing: '0.14em',
          }}
        >
          ● {error ? 'FAILED' : 'VALID'}
        </span>
      )}
    </div>
  )
}

function EmailReceipt({
  email,
  sender,
}: {
  email: string
  /** The bare address auth mail really sends from (`GET /v1/login/sender`),
   *  e.g. `noreply@fortymm.com` — undefined while loading, and `null` when
   *  the API has no address to give. Either way the From row is simply
   *  omitted rather than rendered broken or empty (#1466 defect 1). */
  sender?: string | null
}) {
  return (
    <div style={receiptCard}>
      <div style={receiptRow}>
        <span style={receiptK}>To</span>
        <span style={receiptV}>{email}</span>
      </div>
      <div style={receiptDiv} />
      <div style={receiptRow}>
        <span style={receiptK}>Subject</span>
        <span style={receiptV}>Your FortyMM sign-in link</span>
      </div>
      {sender && (
        <>
          <div style={receiptDiv} />
          <div style={receiptRow}>
            <span style={receiptK}>From</span>
            <span style={{ ...receiptV, color: 'var(--fg-3)' }}>{sender}</span>
          </div>
        </>
      )}
    </div>
  )
}

function SuccessReceipt({
  username,
  email,
}: {
  username: string
  email: string | null
}) {
  return (
    <div
      style={{
        ...receiptCard,
        borderColor: 'rgba(0,226,154,0.35)',
        boxShadow: 'var(--shadow-live-glow)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '4px 0 12px',
        }}
      >
        <CheckBadge />
        <div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              fontWeight: 700,
              color: 'var(--serve-500)',
              letterSpacing: '0.18em',
            }}
          >
            ● SESSION OPENED
          </div>
          <div
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              fontWeight: 500,
              color: 'var(--fg-1)',
              marginTop: 4,
            }}
          >
            {username}
          </div>
        </div>
      </div>
      {email && (
        <>
          <div style={receiptDiv} />
          <div style={receiptRow}>
            <span style={receiptK}>Email</span>
            <span style={receiptV}>{email}</span>
          </div>
        </>
      )}
    </div>
  )
}

function InlineError({
  code,
  title,
  detail,
}: {
  code: string
  title: string
  detail: string
}) {
  return (
    <div
      style={{
        ...receiptCard,
        borderColor: 'rgba(255,77,109,0.35)',
        boxShadow:
          '0 0 0 1px rgba(255,77,109,0.18), 0 8px 24px rgba(255,77,109,0.10)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '4px 0 12px',
        }}
      >
        <XBadge />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              fontWeight: 700,
              color: 'var(--loss)',
              letterSpacing: '0.18em',
            }}
          >
            ● {code}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              fontWeight: 500,
              color: 'var(--fg-1)',
              marginTop: 4,
            }}
          >
            {title}
          </div>
        </div>
      </div>
      <div style={receiptDiv} />
      <div
        style={{
          padding: '10px 0 4px',
          fontFamily: 'var(--font-ui)',
          fontSize: 12.5,
          lineHeight: 1.55,
          color: 'var(--fg-3)',
        }}
      >
        {detail}
      </div>
    </div>
  )
}

/** Seconds left on the resend cooldown for a link sent at `sentAt` (epoch-ms),
 *  ticking down to 0. Mirrors ExpiresCountdown's derive-now-during-render
 *  approach so a fresh send time takes effect immediately. */
function useResendCooldown(sentAt: number) {
  const readyAt = sentAt + RESEND_COOLDOWN_MS
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= readyAt) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [readyAt])

  return Math.max(0, Math.ceil((readyAt - now) / 1000))
}

/** Single source of truth for a sign-in link's remaining lifetime. `sentAt` is
 *  the epoch-ms send time; this owns the link lifetime (matches the API's
 *  LOGIN_TOKEN_LIFETIME) and ticks once a second. Both the subtitle copy and
 *  `ExpiresCountdown` read the `expired` flag this returns, rather than each
 *  computing its own "is it expired" from `sentAt` — that's what keeps the
 *  body copy and the countdown from silently disagreeing. */
function useLinkExpiry(sentAt: number, enabled = true) {
  const expiresAt = sentAt + LOGIN_LINK_TTL_MS
  // Track "now" and derive the remaining time during render — that way a new
  // send time reflects immediately, and there's no setState in the effect body.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Nothing reads these values when the send time is unknown, and the
    // fallback timestamp they'd tick against is meaningless anyway — don't
    // re-render the whole screen once a second for 15 minutes to compute them.
    if (!enabled) return
    const id = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= expiresAt) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [expiresAt, enabled])

  const remaining = Math.max(0, expiresAt - now)
  const expired = remaining <= 0
  return { remaining, expired }
}

/** Live countdown to a sign-in link's expiry, driven by `useLinkExpiry`'s
 *  output — at zero it flips to a spent "Link expired" treatment (the Resend
 *  control on the screen is the recovery path). Takes the computed
 *  remaining/expired values as props (not `sentAt`) so it always shows the
 *  exact same state as any other copy reading the same link's expiry. */
function ExpiresCountdown({
  remaining,
  expired,
}: {
  remaining: number
  expired: boolean
}) {
  const totalSeconds = Math.ceil(remaining / 1000)
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0')
  const ss = String(totalSeconds % 60).padStart(2, '0')
  const pct = Math.max(0, Math.min(100, (remaining / LOGIN_LINK_TTL_MS) * 100))

  return (
    <div
      style={{
        marginTop: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        borderRadius: 'var(--r-md)',
        background: 'var(--ink-900)',
        border: `1px solid ${expired ? 'var(--loss)' : 'var(--ink-600)'}`,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          color: 'var(--fg-3)',
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
        }}
      >
        {expired ? 'Link expired' : 'Link expires in'}
      </span>
      <span
        role="timer"
        aria-label={expired ? 'Link expired' : `Link expires in ${mm}:${ss}`}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 18,
          fontWeight: 700,
          color: expired ? 'var(--loss)' : 'var(--ball-500)',
          letterSpacing: '0.06em',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {`${mm}:${ss}`}
      </span>
      <span style={{ flex: 1 }} />
      <ProgressBar pct={pct} expired={expired} />
    </div>
  )
}

function ProgressBar({ pct, expired = false }: { pct: number; expired?: boolean }) {
  return (
    <span
      style={{
        width: 100,
        height: 4,
        borderRadius: 999,
        background: 'var(--ink-700)',
        overflow: 'hidden',
        display: 'inline-block',
      }}
    >
      <span
        style={{
          display: 'block',
          width: `${pct}%`,
          height: '100%',
          background: expired
            ? 'var(--loss)'
            : 'linear-gradient(90deg, var(--ball-500), var(--ball-400))',
          transition: 'width 1s linear',
        }}
      />
    </span>
  )
}

function CheckBadge() {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 36,
        height: 36,
        borderRadius: '50%',
        background: 'rgba(0,226,154,0.16)',
        border: '1.5px solid var(--serve-500)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path
          d="M5 12.5l4 4 10-10"
          stroke="#00E29A"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

function XBadge() {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 36,
        height: 36,
        borderRadius: '50%',
        background: 'rgba(255,77,109,0.16)',
        border: '1.5px solid var(--loss)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path
          d="M6 6l12 12M18 6L6 18"
          stroke="#FF4D6D"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
    </div>
  )
}

function Divider({ label }: { label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        margin: '4px 0 -2px',
      }}
    >
      <span style={{ flex: 1, height: 1, background: 'var(--ink-600)' }} />
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          color: 'var(--fg-muted)',
          letterSpacing: '0.2em',
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1, height: 1, background: 'var(--ink-600)' }} />
    </div>
  )
}

/* ─── Shared style objects ──────────────────────────────────────────── */

// Reset for <button> elements that should render as inline text-link. Lets
// app actions live in <button> (correct semantics, no scroll-jump, no `#`
// in history) while still looking like the underlined links around them.
const linkButtonStyle: CSSProperties = {
  ...linkInline,
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  padding: 0,
  font: 'inherit',
}

function LinkButton({
  onClick,
  children,
}: {
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <button type="button" style={linkButtonStyle} onClick={onClick}>
      {children}
    </button>
  )
}

const mono: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  color: 'var(--ball-500)',
  fontWeight: 600,
}

const receiptCard: CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--ink-600)',
  borderRadius: 'var(--r-md)',
  padding: '14px 16px',
}

const receiptRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '6px 0',
}

const receiptK: CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-3)',
  width: 78,
  flexShrink: 0,
}

const receiptV: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  color: 'var(--fg-1)',
  fontVariantNumeric: 'tabular-nums',
}

const receiptDiv: CSSProperties = { height: 1, background: 'var(--ink-700)' }

/* ─── Screens ───────────────────────────────────────────────────────── */

export interface ScreenEmailProps {
  initialEmail?: string
  submitting?: boolean
  errorMessage?: string | null
  onSubmit: (input: {
    email: string
    captchaToken: string
    honeypot: string
  }) => void
}

export function ScreenEmail({
  initialEmail = '',
  submitting = false,
  errorMessage = null,
  onSubmit,
}: ScreenEmailProps) {
  const [email, setEmail] = useState(initialEmail)
  const [touched, setTouched] = useState(false)
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [captchaFailed, setCaptchaFailed] = useState(false)
  const [honeypot, setHoneypot] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const captchaRef = useRef<TurnstileHandle | null>(null)

  const valid = isValidEmail(email)
  const showError = errorMessage ?? localError ?? (touched && !valid
    ? "That doesn't look like a valid email."
    : null)

  // The Turnstile token needs a script fetch, a widget render and a challenge
  // solve — a second or more on a cold load — so the submit button waits,
  // visibly, until the token lands (#1462). A disabled button with no
  // explanation is a dead end; the waiting label (and, after a failure, the
  // alert below) is that explanation. `onExpire` nulls the token, which lands
  // back here and treats a mid-form re-solve exactly like the initial wait.
  const captchaWaiting = !captchaToken && !captchaFailed

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    setTouched(true)
    if (!valid) return
    if (!captchaToken) {
      setLocalError('Complete the check above so we know you’re not a bot.')
      return
    }
    setLocalError(null)
    onSubmit({ email: email.trim(), captchaToken, honeypot })
  }

  return (
    <Shell
      left={
        <HeroCol
          eyebrow="● No passwords · No bullshit · No tracking"
          h1a="Show us"
          h1b="your serve."
        />
      }
      right={
        <FormCol
          stepNo="01"
          stepLabel="Sign in"
          title="Your email"
          subtitle="Drop your email. We send a one-tap link — open it and you’re in. We never made a password, so we can’t lose yours."
        >
          <form
            onSubmit={handleSubmit}
            style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
            noValidate
          >
            <EmailField
              value={email}
              onChange={(next) => {
                setEmail(next)
                if (localError) setLocalError(null)
              }}
              state={showError ? 'error' : valid ? 'valid' : 'neutral'}
              autoFocus
            />
            {showError && (
              <p className="fmm-help fmm-help--err" role="alert">
                {showError}
              </p>
            )}

            <div style={HONEYPOT_STYLE} aria-hidden="true">
              <label htmlFor="login-fmm-hp">Leave this empty</label>
              <input
                id="login-fmm-hp"
                name="fmm_hp_token"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
                data-testid="login-honeypot"
              />
            </div>

            <div>
              <Turnstile
                handleRef={(h) => {
                  captchaRef.current = h
                }}
                onToken={(token) => {
                  setCaptchaToken(token)
                  if (localError) setLocalError(null)
                }}
                onExpire={() => setCaptchaToken(null)}
                onError={() => {
                  setCaptchaToken(null)
                  setCaptchaFailed(true)
                }}
                onLoadError={() => setCaptchaFailed(true)}
              />
            </div>

            {captchaFailed && (
              <p className="fmm-help fmm-help--err" role="alert">
                The anti-bot check hit a snag. Reload this page and try again.
              </p>
            )}

            <button
              type="submit"
              style={{
                ...btnPrimary,
                opacity: submitting || captchaWaiting ? 0.7 : 1,
                cursor: submitting ? 'wait' : captchaWaiting
                  ? 'not-allowed'
                  : 'pointer',
              }}
              disabled={submitting || !captchaToken}
            >
              {submitting
                ? 'Sending the link…'
                : captchaWaiting
                  ? 'Getting ready…'
                  : 'Send the link'}
            </button>
          </form>
          <Divider label="OR" />
          <div style={fineprint}>
            New here? Same flow — we’ll create your account when you confirm.
            <br />
            <span style={{ color: 'var(--fg-muted)' }}>
              By signing in you agree to play fair. That’s it.{' '}
              {/* House rules / Privacy pages don't exist yet — render as plain
                  text (not focusable LinkButtons) so we don't advertise
                  interactive controls that fire nothing. Convert back to
                  <a href="…"> once the pages land (#227). */}
              <span style={linkInline}>House rules</span> ·{' '}
              <span style={linkInline}>Privacy</span>
            </span>
          </div>
        </FormCol>
      }
    />
  )
}

export interface ScreenSentProps {
  email: string
  /** Epoch-ms time the sign-in link was sent; drives the live expiry
   *  countdown. Defaults to first render when the caller doesn't know it. */
  sentAt?: number
  /** The bare address auth mail really sends from — see `EmailReceipt`. */
  sender?: string | null
  onResend?: () => void
  onStartOver?: () => void
  resending?: boolean
  resendMessage?: string | null
  resendError?: string | null
}

export function ScreenSent({
  email,
  sentAt,
  sender,
  onResend,
  onStartOver,
  resending = false,
  resendMessage = null,
  resendError = null,
}: ScreenSentProps) {
  // Whether we actually know when the link was sent (false when this screen
  // is opened cold, e.g. from a bookmark). This must NOT be conflated with
  // the fallback timestamp below: knowing "some" time isn't the same as
  // knowing the link is fresh, and the body copy has to tell them apart.
  const knowsSentAt = sentAt !== undefined
  // Stable fallback so the countdown/cooldown don't reset every render when
  // no send time was threaded in. This exists only so those two timers have
  // SOME timestamp to compute against — it must never feed a claim in the
  // visible copy that the link is fresh, since it could be arbitrarily old.
  const [fallbackSentAt] = useState(() => Date.now())
  const effectiveSentAt = sentAt ?? fallbackSentAt
  // Throttle Resend right after a send so rapid clicks can't bounce the user
  // off this screen (the request endpoint is rate-limited); show the wait.
  const cooldown = useResendCooldown(effectiveSentAt)
  const resendDisabled = resending || !onResend || cooldown > 0
  // Single source of truth for the link's remaining lifetime — the subtitle
  // and ExpiresCountdown both read `expired` from here so they can't drift.
  const { remaining, expired } = useLinkExpiry(effectiveSentAt, knowsSentAt)
  return (
    <Shell
      left={
        <HeroCol
          eyebrow="● The ball is in your inbox"
          h1a="Sent."
          h1b="Go fetch."
        />
      }
      right={
        <FormCol
          stepNo="02"
          stepLabel="Check inbox"
          title={`Link sent to ${email}`}
          subtitle={
            !knowsSentAt ? (
              <>
                If you requested a sign-in link, check{' '}
                <span style={mono}>{email}</span> for it. Open the most
                recent message on this device — links last 15 minutes and
                work once.
              </>
            ) : expired ? (
              <>
                That link to <span style={mono}>{email}</span> may have
                expired. Hit resend below for a fresh one.
              </>
            ) : (
              <>
                A sign-in link is flying toward{' '}
                <span style={mono}>{email}</span> right now. Open it on this
                device. Expires in 15 — like a real rally.
              </>
            )
          }
        >
          <EmailReceipt email={email} sender={sender} />

          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button
              type="button"
              style={{
                ...btnGhost,
                flex: 1,
                opacity: resendDisabled ? 0.7 : 1,
                cursor: resending
                  ? 'wait'
                  : resendDisabled
                    ? 'not-allowed'
                    : 'pointer',
              }}
              onClick={onResend}
              disabled={resendDisabled}
            >
              {resending
                ? 'Resending…'
                : cooldown > 0
                  ? `Resend in ${cooldown}s`
                  : 'Resend'}
            </button>
            <button
              type="button"
              style={btnGhost}
              onClick={onStartOver}
              disabled={!onStartOver}
            >
              Start over
            </button>
          </div>

          {resendMessage && (
            <p
              className="fmm-help fmm-help--ok"
              role="status"
              style={{ marginTop: 6 }}
            >
              {resendMessage}
            </p>
          )}

          {resendError && (
            <p
              className="fmm-help fmm-help--err"
              role="alert"
              style={{ marginTop: 6 }}
            >
              {resendError}
            </p>
          )}

          <div style={{ ...fineprint, marginTop: 10 }}>
            No link? Check spam. Or hit resend, we don’t mind.
            <br />
            <span style={{ color: 'var(--fg-muted)' }}>
              Wrong address?{' '}
              <LinkButton onClick={onStartOver}>Start over</LinkButton>.
            </span>
          </div>

          {knowsSentAt && (
            <ExpiresCountdown remaining={remaining} expired={expired} />
          )}
        </FormCol>
      }
    />
  )
}

export interface ScreenSuccessProps {
  username?: string
  email?: string | null
  redirectTo?: string
}

export function ScreenSuccess({
  username = '',
  email = null,
  redirectTo = '/dashboard',
}: ScreenSuccessProps) {
  return (
    <Shell
      left={
        <HeroCol
          eyebrow="● You’re in"
          h1a="Welcome back"
          h1b={username ? `${username}.` : '.'}
        />
      }
      right={
        <FormCol
          stepNo="04"
          stepLabel="Signed in"
          title="Account verified"
          subtitle="Warming up the courts."
          accent="var(--serve-500)"
        >
          <SuccessReceipt username={username} email={email} />
          <RedirectStrip dest={redirectTo} />
        </FormCol>
      }
    />
  )
}

export interface ScreenEmailSendFailedProps {
  email?: string
  detail?: string
  onTryAgain?: () => void
}

export function ScreenEmailSendFailed({
  email = '',
  detail,
  onTryAgain,
}: ScreenEmailSendFailedProps) {
  return (
    <Shell
      left={
        <HeroCol
          eyebrow="● Service out"
          h1a="Mail service"
          h1b="is down."
        />
      }
      right={
        <FormCol
          stepNo="01"
          stepLabel="Sign in · send failed"
          title="We couldn’t send your link"
          subtitle="Our email gateway isn’t answering. Not your fault. Give it a minute and try again — we’re already on it."
          accent="var(--loss)"
        >
          <EmailField value={email} state="error" readOnly />

          <InlineError
            code="ERR_MAIL_PROVIDER"
            title="Email service unavailable"
            detail={
              detail ??
              'Our mail provider didn’t answer. Give it a minute and try again.'
            }
          />

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              style={{ ...btnPrimary, flex: 1 }}
              onClick={onTryAgain}
              disabled={!onTryAgain}
            >
              Try again
            </button>
          </div>

          <div style={fineprint}>
            <span style={{ color: 'var(--fg-muted)' }}>
              Still broken?{' '}
              <a href="mailto:support@fortymm.com" style={linkInline}>
                Email support
              </a>{' '}
              or check{' '}
              <a
                href="https://status.fortymm.com"
                target="_blank"
                rel="noopener noreferrer"
                style={linkInline}
              >
                status.fortymm.com
              </a>
              .
            </span>
          </div>
        </FormCol>
      }
    />
  )
}

export interface ScreenVerifyNetErrorProps {
  onRetry?: () => void
  onSendNewLink?: () => void
  retrying?: boolean
}

export function ScreenVerifyNetError({
  onRetry,
  onSendNewLink,
  retrying = false,
}: ScreenVerifyNetErrorProps) {
  return (
    <Shell
      left={
        <HeroCol
          eyebrow="● Off the table"
          h1a="Lost signal."
          h1b="Retry."
        />
      }
      right={
        <FormCol
          stepNo="03"
          stepLabel="Verifying · failed"
          title="Couldn’t reach FortyMM to verify your link"
          subtitle="The request didn’t get through. Check your connection and give it another go."
          accent="var(--loss)"
        >
          {/* Only what we actually know: the request didn't get through. No
              invented hostnames, status codes, timings or request logs — and no
              claim about the link's fate we can't stand behind, since a failed
              request tells us nothing about what the server did (#226). */}
          <InlineError
            code="ERR_NETWORK"
            title="We couldn’t reach FortyMM"
            detail="The verification didn’t go through. Your link should still be good — retry it, or send yourself a new one."
          />

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              style={{ ...btnPrimary, flex: 1 }}
              onClick={onRetry}
              disabled={retrying || !onRetry}
            >
              {retrying ? 'Retrying…' : 'Retry verification'}
            </button>
            <button
              type="button"
              style={btnGhost}
              onClick={onSendNewLink}
              disabled={!onSendNewLink}
            >
              Send a new link
            </button>
          </div>
        </FormCol>
      }
    />
  )
}
