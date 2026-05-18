import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createFileRoute, useRouterState } from '@tanstack/react-router'
import { Check, Mail } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  useResendEmailConfirmation,
  useSession,
  useSetEmail,
  useUpdateUsername,
} from '@/api/session'
import { AppShell } from '@/components/app-shell'
import { Turnstile, type TurnstileHandle } from '@/components/turnstile'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  HONEYPOT_STYLE,
  validateEmail,
  type Validation,
} from '@/lib/form-helpers'
import { pageTitle } from '@/lib/page-title'
import './settings.css'

export const Route = createFileRoute('/settings')({
  head: () => ({
    meta: [{ title: pageTitle('Settings') }],
  }),
  component: SettingsPage,
})

/* ------------------------------------------------------------------ */
/*  Types & helpers                                                   */
/* ------------------------------------------------------------------ */

type EmailStatus = 'guest' | 'pending' | 'verified'

// Mirrors api/app/schemas/session.py USERNAME_PATTERN. Client-side validation
// is for fast feedback; the server still enforces the same rules and returns
// 409 on duplicates.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,38}[a-z0-9])?$/
const USERNAME_MIN = 3
const USERNAME_MAX = 40

function validateUsername(u: string): Validation {
  if (!u) return { ok: false, err: 'Username is required.' }
  if (u.length < USERNAME_MIN) return { ok: false, err: `At least ${USERNAME_MIN} characters.` }
  if (u.length > USERNAME_MAX) return { ok: false, err: `No more than ${USERNAME_MAX} characters.` }
  if (!USERNAME_RE.test(u))
    return {
      ok: false,
      err: 'Lowercase letters, numbers, dots, hyphens and underscores. Must start and end with a letter or number.',
    }
  return { ok: true }
}

function relativeTime(ts: number): string {
  const diff = Math.max(0, (Date.now() - ts) / 1000)
  if (diff < 5) return 'just now'
  if (diff < 60) return `${Math.floor(diff)}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}


/* ------------------------------------------------------------------ */
/*  Toasts                                                            */
/* ------------------------------------------------------------------ */

type ToastKind = 'ok' | 'err'
type ToastPush = (msg: string, opts?: { kind?: ToastKind; ttl?: number }) => void

interface ToastItem {
  id: number
  msg: string
  kind: ToastKind
}

const ToastContext = createContext<ToastPush>(() => {})

function useToast(): ToastPush {
  return useContext(ToastContext)
}

function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const idRef = useRef(0)

  const push = useCallback<ToastPush>((msg, opts = {}) => {
    const id = ++idRef.current
    setToasts((arr) => [...arr, { id, msg, kind: opts.kind ?? 'ok' }])
    setTimeout(
      () => setToasts((arr) => arr.filter((t) => t.id !== id)),
      opts.ttl ?? 3200,
    )
  }, [])

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        style={{
          position: 'fixed',
          bottom: 20,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 2000,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`fmm-toast fmm-toast--${t.kind}`}
            style={{ pointerEvents: 'auto' }}
          >
            <span
              style={{
                fontFamily: 'var(--font-ui)',
                fontSize: 'var(--text-sm)',
                color: 'var(--fg-1)',
                fontWeight: 500,
              }}
            >
              {t.msg}
            </span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/* ------------------------------------------------------------------ */
/*  Primitives                                                        */
/* ------------------------------------------------------------------ */

function Spinner() {
  return <span className="fmm-spinner" />
}

function Avatar({ name, size = 32, dim = false }: { name: string; size?: number; dim?: boolean }) {
  const init =
    (name || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?'
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: dim
          ? 'var(--ink-700)'
          : 'linear-gradient(135deg, var(--ball-500), var(--ball-700))',
        color: dim ? 'var(--fg-3)' : 'var(--ink-950)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-mono)',
        fontSize: Math.round(size * 0.36),
        fontWeight: 700,
        letterSpacing: '0.02em',
        flexShrink: 0,
        boxShadow: dim ? 'none' : '0 0 0 2px rgba(255,122,26,0.18)',
      }}
    >
      {init}
    </div>
  )
}

const COMING_SOON_TRIGGER: CSSProperties = {
  opacity: 0.55,
  filter: 'saturate(0.75)',
  cursor: 'not-allowed',
}

// `inert` (not just pointer-events: none) is what keeps focus and AT
// out of the disabled subtree — without it, Tab still lands on inner
// buttons/links and screen readers still announce them as actionable.
const COMING_SOON_INNER: CSSProperties = { pointerEvents: 'none' }

function ComingSoon({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div style={COMING_SOON_TRIGGER}>
          <div inert style={COMING_SOON_INNER}>
            {children}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent>coming soon</TooltipContent>
    </Tooltip>
  )
}

function Field({
  label,
  hint,
  error,
  success,
  htmlFor,
  children,
  right,
}: {
  label: string
  hint?: string
  error?: string | null
  success?: string | null
  htmlFor?: string
  children: ReactNode
  right?: ReactNode
}) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <label
          htmlFor={htmlFor}
          style={{
            fontSize: 'var(--text-sm)',
            fontWeight: 600,
            color: 'var(--fg-2)',
            letterSpacing: '0.01em',
          }}
        >
          {label}
        </label>
        {right}
      </div>
      {children}
      {error ? (
        <div className="fmm-help fmm-help--err">{error}</div>
      ) : success ? (
        <div className="fmm-help fmm-help--ok">{success}</div>
      ) : hint ? (
        <div className="fmm-help">{hint}</div>
      ) : null}
    </div>
  )
}

interface SectionTag {
  label: string
  kind?: 'ok' | 'soon' | 'req'
}

function SectionCard({
  id,
  num,
  eyebrow,
  title,
  subtitle,
  tags,
  children,
  footer,
}: {
  id: string
  num: string
  eyebrow: string
  title: string
  subtitle?: string
  tags?: SectionTag[]
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section id={id} className="fmm-card" data-screen-label={`${num} ${title}`}>
      <header style={{ padding: '24px 28px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <span className="fmm-section-num">{num}</span>
          <span className="fmm-overline" style={{ color: 'var(--fg-muted)' }}>
            {eyebrow}
          </span>
          {tags && tags.length > 0 && (
            <div style={{ display: 'flex', gap: 6 }}>
              {tags.map((t) => (
                <span key={t.label} className={`fmm-tag fmm-tag--${t.kind ?? ''}`}>
                  {t.label}
                </span>
              ))}
            </div>
          )}
        </div>
        <h2
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--text-xl)',
            fontWeight: 600,
            letterSpacing: '-0.01em',
            color: 'var(--fg-1)',
            margin: '0 0 6px',
          }}
        >
          {title}
        </h2>
        {subtitle && (
          <p
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--fg-3)',
              margin: 0,
              maxWidth: 560,
              lineHeight: 'var(--lh-snug)',
            }}
          >
            {subtitle}
          </p>
        )}
      </header>
      <div className="fmm-card-body" style={{ padding: '24px 28px 28px' }}>
        {children}
      </div>
      {footer && (
        <div
          className="fmm-card-foot"
          style={{
            padding: '16px 28px',
            background: 'var(--bg-panel)',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
          }}
        >
          {footer}
        </div>
      )}
    </section>
  )
}

const MONO_LABEL_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 'var(--text-xs)',
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
}

function SaveBar({
  dirty,
  valid,
  saving,
  savedAt,
  onSave,
  onCancel,
  primaryLabel = 'Save changes',
}: {
  dirty: boolean
  valid: boolean
  saving: boolean
  savedAt: number | null
  onSave: () => void
  onCancel?: () => void
  primaryLabel?: string
}) {
  // Tick every second so "saved 12s ago" stays current.
  const [, force] = useState(0)
  useEffect(() => {
    if (!savedAt) return
    const i = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(i)
  }, [savedAt])

  const status =
    savedAt && !dirty ? (
      <span style={{ ...MONO_LABEL_STYLE, color: 'var(--fg-3)' }}>
        <Check size={14} color="var(--serve-500)" />
        Saved {relativeTime(savedAt)}
      </span>
    ) : dirty ? (
      <span style={{ ...MONO_LABEL_STYLE, color: 'var(--warn)' }}>
        <span className="ball-dot ball-dot--warn" style={{ width: 7, height: 7 }} />
        Unsaved
      </span>
    ) : (
      <span />
    )

  return (
    <>
      {status}
      <div style={{ flex: 1 }} />
      {onCancel && (
        <button
          type="button"
          className="fmm-btn fmm-btn--quiet"
          onClick={onCancel}
          disabled={!dirty || saving}
        >
          Discard
        </button>
      )}
      <button
        type="button"
        className="fmm-btn fmm-btn--primary"
        onClick={onSave}
        disabled={!dirty || !valid || saving}
      >
        {saving ? (
          <>
            <Spinner /> Saving…
          </>
        ) : (
          primaryLabel
        )}
      </button>
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Page header — large Bebas "SETTINGS"                              */
/* ------------------------------------------------------------------ */

function PageHeader({
  username,
  claimed,
}: {
  username: string
  claimed: boolean
}) {
  return (
    <header style={{ marginBottom: 28 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 14,
          fontSize: 'var(--text-xs)',
          color: 'var(--fg-muted)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        <span className="ball-dot" style={{ width: 7, height: 7 }} />
        Workspace
        <span style={{ color: 'var(--ink-600)' }}>/</span>
        <span style={{ color: 'var(--fg-2)' }}>Settings</span>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 16,
          justifyContent: 'space-between',
        }}
      >
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 64,
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
            color: 'var(--fg-1)',
            margin: 0,
            lineHeight: 1,
          }}
        >
          Settings
        </h1>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '6px 12px 6px 6px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--r-pill)',
            flexShrink: 0,
          }}
        >
          <Avatar name={username || '…'} size={26} dim={!claimed} />
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              color: 'var(--fg-2)',
              letterSpacing: '0.02em',
            }}
          >
            {username || '…'}
          </div>
          {claimed && <Check size={14} color="var(--serve-500)" />}
        </div>
      </div>
      <p
        style={{
          marginTop: 14,
          marginBottom: 0,
          color: 'var(--fg-3)',
          fontSize: 'var(--text-base)',
          maxWidth: 560,
        }}
      >
        Save each section on its own — we don't bundle changes you didn't ask for.
      </p>
    </header>
  )
}

/* ------------------------------------------------------------------ */
/*  Claim banner — shows until the account is verified                */
/* ------------------------------------------------------------------ */

function ClaimBanner({
  status,
  email,
  onJump,
}: {
  status: EmailStatus
  email: string
  onJump: () => void
}) {
  if (status === 'verified') return null
  const guest = status === 'guest'
  return (
    <div
      style={{
        position: 'relative',
        padding: '14px 18px',
        marginBottom: 24,
        borderRadius: 'var(--r-md)',
        background: guest
          ? 'linear-gradient(90deg, rgba(255,122,26,0.18), rgba(255,122,26,0.05) 70%)'
          : 'linear-gradient(90deg, rgba(255,196,61,0.18), rgba(255,196,61,0.04) 70%)',
        border: `1px solid ${guest ? 'rgba(255,122,26,0.35)' : 'rgba(255,196,61,0.3)'}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span
          className={guest ? 'ball-dot' : 'ball-dot ball-dot--warn'}
          style={{ width: 10, height: 10 }}
        />
        <div style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>
          {guest ? (
            <>
              <strong style={{ color: 'var(--fg-1)', fontWeight: 600 }}>
                You're playing as a guest.
              </strong>{' '}
              Add an email so we don't lose your ratings if you change devices.
            </>
          ) : (
            <>
              <strong style={{ color: 'var(--fg-1)', fontWeight: 600 }}>
                Check your inbox.
              </strong>{' '}
              We sent a verification link to{' '}
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-1)' }}>
                {email}
              </span>
              .
            </>
          )}
        </div>
        <button
          type="button"
          className={`fmm-btn fmm-btn--${guest ? 'primary' : 'ghost'} fmm-btn--sm`}
          onClick={onJump}
        >
          {guest ? 'Add email' : 'Verify now'}
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  01 — Username                                                     */
/* ------------------------------------------------------------------ */

function UsernameSection({ currentUsername }: { currentUsername: string }) {
  const toast = useToast()
  const updateUsername = useUpdateUsername()
  const [val, setVal] = useState(currentUsername)
  const [touched, setTouched] = useState(false)
  const [serverErr, setServerErr] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // The session query refetches in the background (window focus, post-save
  // setQueryData, etc.); most of those pass back the same username. Only
  // reset local input state when the upstream value actually changed —
  // otherwise we'd clobber the user's in-progress edits on every refetch.
  const lastSyncedRef = useRef(currentUsername)
  useEffect(() => {
    if (currentUsername === lastSyncedRef.current) return
    lastSyncedRef.current = currentUsername
    setVal(currentUsername)
    setTouched(false)
    setServerErr(null)
  }, [currentUsername])

  const clientV = useMemo(() => validateUsername(val), [val])
  const dirty = val !== currentUsername
  const displayedErr =
    serverErr ?? (touched && !clientV.ok ? (clientV.err ?? null) : null)

  const onSave = async () => {
    if (!clientV.ok || !dirty) return
    setServerErr(null)
    try {
      await updateUsername.mutateAsync(val)
      setSavedAt(Date.now())
      setTouched(false)
      toast('Username saved.')
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 422)) {
        setServerErr(err.detail ?? 'Server rejected this username.')
        return
      }
      toast(
        err instanceof Error
          ? `Couldn't update username: ${err.message}`
          : "Couldn't update username.",
        { kind: 'err' },
      )
    }
  }

  return (
    <SectionCard
      id="sec-username"
      num="01"
      eyebrow="Identity"
      title="Username"
      subtitle="This is how other players will find you. Change it any time."
      footer={
        <SaveBar
          dirty={dirty}
          valid={clientV.ok}
          saving={updateUsername.isPending}
          savedAt={savedAt}
          onSave={onSave}
          onCancel={() => {
            setVal(currentUsername)
            setTouched(false)
            setServerErr(null)
          }}
        />
      }
    >
      <Field
        label="Username"
        htmlFor="username"
        hint={`Lowercase letters, numbers, dots, hyphens and underscores. ${USERNAME_MIN}–${USERNAME_MAX} characters.`}
        error={displayedErr}
        success={dirty && clientV.ok && !serverErr ? 'Looks good. Save to make it stick.' : null}
        right={
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              color: val.length > USERNAME_MAX ? 'var(--loss)' : 'var(--fg-muted)',
              letterSpacing: '0.05em',
            }}
          >
            {val.length}/{USERNAME_MAX}
          </span>
        }
      >
        <div style={{ position: 'relative' }}>
          <span
            style={{
              position: 'absolute',
              left: 14,
              top: '50%',
              transform: 'translateY(-50%)',
              fontFamily: 'var(--font-mono)',
              color: 'var(--fg-muted)',
              fontSize: 'var(--text-base)',
              pointerEvents: 'none',
            }}
          >
            @
          </span>
          <input
            id="username"
            className={`fmm-input fmm-input--mono ${displayedErr ? 'fmm-input--err' : dirty && clientV.ok ? 'fmm-input--ok' : ''}`}
            value={val}
            onChange={(e) => {
              setVal(e.target.value.toLowerCase().replace(/\s/g, ''))
              if (serverErr) setServerErr(null)
            }}
            onBlur={() => setTouched(true)}
            placeholder="your-name"
            style={{ paddingLeft: 30 }}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!!displayedErr || undefined}
          />
        </div>
      </Field>

      <div
        style={{
          marginTop: 18,
          padding: '14px 16px',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-md)',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <Avatar name={val} size={36} dim={!clientV.ok} />
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--fg-muted)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              marginBottom: 2,
            }}
          >
            Preview
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-base)',
              color: 'var(--fg-1)',
            }}
          >
            {clientV.ok ? `@${val}` : '—'}
          </div>
        </div>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            color: 'var(--fg-muted)',
            letterSpacing: '0.08em',
          }}
        >
          fortymm.app/p/{clientV.ok ? val : '—'}
        </span>
      </div>
    </SectionCard>
  )
}

/* ------------------------------------------------------------------ */
/*  02 — Email (required to claim)                                    */
/* ------------------------------------------------------------------ */

function EmailSection({
  email,
  confirmedAt,
}: {
  email: string | null
  confirmedAt: string | null
}) {
  const toast = useToast()
  const setEmail = useSetEmail()
  const resendEmail = useResendEmailConfirmation()
  const current = email ?? ''
  const [val, setVal] = useState(current)
  const [touched, setTouched] = useState(false)
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [honeypot, setHoneypot] = useState('')
  const [serverErr, setServerErr] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const captchaRef = useRef<TurnstileHandle | null>(null)

  // Reset the local input when the underlying session value changes (e.g. on
  // refetch after another tab confirmed). Avoid clobbering in-progress edits.
  const lastSyncedRef = useRef(current)
  useEffect(() => {
    if (current === lastSyncedRef.current) return
    lastSyncedRef.current = current
    setVal(current)
    setTouched(false)
    setServerErr(null)
  }, [current])

  const v = useMemo(() => validateEmail(val), [val])
  const dirty = val !== current
  const showErr = serverErr ?? (touched && !v.ok ? v.err : null)

  const status: EmailStatus = confirmedAt
    ? 'verified'
    : email
      ? 'pending'
      : 'guest'

  const resetCaptcha = () => {
    captchaRef.current?.reset()
    setCaptchaToken(null)
  }

  const onSave = async () => {
    if (!v.ok || !dirty) return
    if (!captchaToken) {
      setServerErr('Please complete the CAPTCHA above.')
      return
    }
    setServerErr(null)
    try {
      await setEmail.mutateAsync({
        email: val,
        captchaToken,
        honeypot,
      })
      setSavedAt(Date.now())
      setTouched(false)
      resetCaptcha()
      toast(`Verification link sent to ${val}.`)
    } catch (err) {
      resetCaptcha()
      if (err instanceof ApiError && err.status && err.status < 500) {
        setServerErr(err.detail ?? 'Server rejected this email.')
        return
      }
      toast(
        err instanceof Error
          ? `Couldn't update email: ${err.message}`
          : "Couldn't update email.",
        { kind: 'err' },
      )
    }
  }

  const onResend = async () => {
    if (!captchaToken) {
      toast('Complete the CAPTCHA, then click Resend.', { kind: 'err' })
      return
    }
    try {
      await resendEmail.mutateAsync({ captchaToken, honeypot })
      resetCaptcha()
      toast(`Verification link re-sent to ${email}.`)
    } catch (err) {
      resetCaptcha()
      toast(
        err instanceof ApiError && err.detail
          ? err.detail
          : "Couldn't resend confirmation.",
        { kind: 'err' },
      )
    }
  }

  return (
    <SectionCard
      id="sec-email"
      num="02"
      eyebrow="Account claim"
      title="Email address"
      subtitle="Required to keep your account beyond this session. We use it for sign-in and recovery — nothing else. No newsletters, no tracking pixels."
      tags={[
        status === 'verified'
          ? { label: 'Verified', kind: 'ok' }
          : status === 'pending'
            ? { label: 'Pending', kind: 'soon' }
            : { label: 'Required', kind: 'req' },
      ]}
      footer={
        <SaveBar
          dirty={dirty}
          valid={v.ok && !!captchaToken}
          saving={setEmail.isPending}
          savedAt={savedAt}
          onSave={onSave}
          onCancel={() => {
            setVal(current)
            setTouched(false)
            setServerErr(null)
          }}
          primaryLabel={email ? 'Update email' : 'Add email'}
        />
      }
    >
      <Field
        label="Email"
        htmlFor="email"
        hint={
          status === 'verified'
            ? "Verified. You can change it any time — we'll send a fresh link."
            : "We'll send a link to verify it's yours. No marketing, ever."
        }
        error={showErr ?? null}
      >
        <div style={{ position: 'relative' }}>
          <span
            style={{
              position: 'absolute',
              left: 14,
              top: '50%',
              transform: 'translateY(-50%)',
              display: 'flex',
              pointerEvents: 'none',
            }}
          >
            <Mail size={16} color="var(--fg-muted)" />
          </span>
          <input
            id="email"
            type="email"
            className={`fmm-input fmm-input--mono ${showErr ? 'fmm-input--err' : status === 'verified' && !dirty ? 'fmm-input--ok' : ''}`}
            value={val}
            onChange={(e) => {
              setVal(e.target.value.trim())
              if (serverErr) setServerErr(null)
            }}
            onBlur={() => setTouched(true)}
            placeholder="you@example.com"
            style={{ paddingLeft: 38 }}
            spellCheck={false}
            autoComplete="email"
            aria-invalid={!!showErr || undefined}
          />
        </div>
      </Field>

      {/* Honeypot. The field name deliberately avoids identity-profile
          names ("website", "address") because Chrome / 1Password / Bitwarden
          ignore autoComplete="off" for those and would splash real users'
          saved data into the trap. */}
      <div style={HONEYPOT_STYLE} aria-hidden="true">
        <label htmlFor="email-fmm-hp">Leave this empty</label>
        <input
          id="email-fmm-hp"
          type="text"
          name="fmm_hp_token"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
          data-testid="email-honeypot"
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <Turnstile
          handleRef={(h) => {
            captchaRef.current = h
          }}
          onToken={(t) => setCaptchaToken(t)}
          onExpire={() => setCaptchaToken(null)}
          onError={() => setCaptchaToken(null)}
        />
      </div>

      {email && (
        <div
          style={{
            marginTop: 16,
            padding: '14px 16px',
            background:
              status === 'verified' ? 'rgba(0,226,154,0.06)' : 'rgba(255,196,61,0.06)',
            border: `1px solid ${status === 'verified' ? 'rgba(0,226,154,0.3)' : 'rgba(255,196,61,0.3)'}`,
            borderRadius: 'var(--r-md)',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          {status === 'verified' ? (
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: 'rgba(0,226,154,0.18)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Check size={16} color="var(--serve-500)" />
            </div>
          ) : (
            <span
              className="ball-dot ball-dot--warn"
              style={{ width: 12, height: 12, marginLeft: 8 }}
            />
          )}
          <div style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>
            {status === 'verified' && confirmedAt ? (
              <>
                <div style={{ fontWeight: 600, color: 'var(--fg-1)' }}>Account claimed.</div>
                <div style={{ color: 'var(--fg-3)', marginTop: 2 }}>
                  Verified {relativeTime(new Date(confirmedAt).getTime())}. You can sign in
                  from anywhere.
                </div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 600, color: 'var(--fg-1)' }}>
                  Waiting for verification.
                </div>
                <div style={{ color: 'var(--fg-3)', marginTop: 2 }}>
                  Open the link we just sent to{' '}
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{email}</span>.
                </div>
              </>
            )}
          </div>
          {status === 'pending' && (
            <button
              type="button"
              className="fmm-btn fmm-btn--quiet fmm-btn--sm"
              onClick={onResend}
              disabled={resendEmail.isPending || !captchaToken}
            >
              {resendEmail.isPending ? (
                <>
                  <Spinner /> Resending…
                </>
              ) : (
                'Resend'
              )}
            </button>
          )}
        </div>
      )}
    </SectionCard>
  )
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

function scrollToSection(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  const y = el.getBoundingClientRect().top + window.scrollY - 24
  window.scrollTo({ top: y, behavior: 'smooth' })
}

function SettingsPage() {
  const session = useSession()
  const sessionUser = session.data?.data.user
  const sessionUsername = sessionUser?.username ?? ''
  const sessionEmail = sessionUser?.email ?? null
  const sessionConfirmedAt = sessionUser?.confirmed_at ?? null
  const hash = useRouterState({ select: (s) => s.location.hash })

  const effectiveStatus: EmailStatus = sessionConfirmedAt
    ? 'verified'
    : sessionEmail
      ? 'pending'
      : 'guest'
  const claimed = effectiveStatus === 'verified'

  // Honor /settings#sec-* deep links from external nav.
  useEffect(() => {
    const id = hash.replace(/^#/, '')
    if (id) scrollToSection(id)
  }, [hash])

  return (
    <AppShell>
      <div className="fmm-settings">
        <ToastProvider>
          <TooltipProvider>
            <div className="fmm-main-inner">
              <PageHeader username={sessionUsername} claimed={claimed} />

              <ClaimBanner
                status={effectiveStatus}
                email={sessionEmail ?? ''}
                onJump={() => scrollToSection('sec-email')}
              />

              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <UsernameSection currentUsername={sessionUsername} />
                <EmailSection
                  email={sessionEmail}
                  confirmedAt={sessionConfirmedAt}
                />
              </div>

              <ComingSoon>
                <div
                  style={{
                    marginTop: 32,
                    paddingTop: 20,
                    borderTop: '1px solid var(--border-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    fontSize: 'var(--text-xs)',
                    color: 'var(--fg-muted)',
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.06em',
                  }}
                >
                  <span>v2.4.1 · made by players · no trackers</span>
                  <div style={{ flex: 1 }} />
                  <a className="fmm-link" style={{ fontSize: 'var(--text-xs)' }}>
                    Privacy
                  </a>
                  <a className="fmm-link" style={{ fontSize: 'var(--text-xs)' }}>
                    Sign out
                  </a>
                </div>
              </ComingSoon>
            </div>
          </TooltipProvider>
        </ToastProvider>
      </div>
    </AppShell>
  )
}
