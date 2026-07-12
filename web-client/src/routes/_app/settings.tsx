import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  createFileRoute,
  useBlocker,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import { Check, Mail } from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

import { ApiError } from '@/api/client'
import { useSendTestNotification } from '@/api/notifications'
import {
  deriveEmailStatus,
  useLogout,
  useResendEmailConfirmation,
  useSession,
  useSetEmail,
  useUpdateUsername,
  type EmailStatus,
} from '@/api/session'
import { Turnstile, type TurnstileHandle } from '@/components/turnstile'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { UserAvatar } from '@/components/ui/user-avatar'
import {
  HONEYPOT_STYLE,
  validateEmail,
  type Validation,
} from '@/lib/form-helpers'
import { pageTitle } from '@/lib/page-title'
import './settings.css'

export const Route = createFileRoute('/_app/settings')({
  head: () => ({
    meta: [{ title: pageTitle('Settings') }],
  }),
  component: SettingsPage,
})

/* ------------------------------------------------------------------ */
/*  Types & helpers                                                   */
/* ------------------------------------------------------------------ */

// Mirrors api/app/schemas/session.py USERNAME_PATTERN. Client-side validation
// is for fast feedback; the server still enforces the same rules and returns
// 409 on duplicates.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,38}[a-z0-9])?$/
const USERNAME_MIN = 3
const USERNAME_MAX = 40

function validateUsername(u: string): Validation {
  if (!u) return { ok: false, err: 'Username is required.' }
  // Surface the specific reason a username is invalid so the user knows what
  // to fix — rather than a generic "allowed characters" hint that they have
  // to decode against what they typed. Char checks come before length checks
  // so "Fo" reads as "uppercase isn't allowed" rather than "too short".
  if (/[A-Z]/.test(u)) return { ok: false, err: 'Lowercase letters only — no uppercase.' }
  if (/\s/.test(u)) return { ok: false, err: 'No spaces — try a dot, hyphen or underscore instead.' }
  if (u.length > USERNAME_MAX) return { ok: false, err: `No more than ${USERNAME_MAX} characters.` }
  if (u.length < USERNAME_MIN) return { ok: false, err: `At least ${USERNAME_MIN} characters.` }
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
/*  Primitives                                                        */
/* ------------------------------------------------------------------ */

function Spinner() {
  return <span className="fmm-spinner" />
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
  // Styles live in settings.css (`.fmm-page-header*`), not inline: this row has
  // to respond to the viewport (see the comment there) and an inline `style`
  // object cannot carry a media query (#890).
  const display = username || '…'
  return (
    <header className="fmm-page-header">
      <div className="fmm-page-header__crumbs">
        <span className="ball-dot" style={{ width: 7, height: 7 }} />
        Workspace
        <span className="fmm-page-header__crumbs-sep">/</span>
        <span className="fmm-page-header__crumbs-current">Settings</span>
      </div>
      <div className="fmm-page-header__row">
        <h1 className="fmm-page-header__title">Settings</h1>
        <div className="fmm-page-header__pill" data-testid="settings-user-pill">
          <UserAvatar name={display} size={26} dim={!claimed} />
          {/* `title` so a truncated long username is still readable on hover. */}
          <div className="fmm-page-header__pill-name" title={display}>
            {display}
          </div>
          {claimed && (
            <Check
              size={14}
              color="var(--serve-500)"
              style={{ flexShrink: 0 }}
            />
          )}
        </div>
      </div>
      <p className="fmm-page-header__lede">
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
        border: `1px solid ${guest ? 'var(--ball-500)' : 'rgba(255,196,61,0.3)'}`,
        // Guest is the urgent, act-now state — give it the Featured accent glow
        // (matches the match-details acceptance / save-your-match cards). The
        // pending "check your inbox" state is informational, so it stays flat.
        boxShadow: guest ? 'var(--shadow-glow)' : undefined,
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

function UsernameSection({
  currentUsername,
  onDirtyChange,
}: {
  currentUsername: string
  onDirtyChange: (dirty: boolean) => void
}) {
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
  // Report dirtiness up so the page can guard against reload / navigation
  // away while an edit is in flight (#440). Reset to clean on unmount so a
  // stale flag can't keep the guard armed after the section is gone.
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  // If the value contains a disallowed character (e.g. uppercase, whitespace,
  // punctuation outside the allowed set), surface that immediately — the user
  // just typed it and we want them to know it's not going through. Length
  // errors stay gated on blur so we don't nag while they're still typing.
  const hasInvalidChar = /[^a-z0-9._-]/.test(val)
  const displayedErr =
    serverErr ?? ((touched || hasInvalidChar) && !clientV.ok ? (clientV.err ?? null) : null)

  const onSave = async () => {
    if (!clientV.ok || !dirty) return
    setServerErr(null)
    try {
      await updateUsername.mutateAsync(val)
      setSavedAt(Date.now())
      setTouched(false)
      toast.success('Username saved.')
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 422)) {
        setServerErr(err.detail ?? 'Server rejected this username.')
        return
      }
      toast.error(
        err instanceof Error
          ? `Couldn't update username: ${err.message}`
          : "Couldn't update username.",
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
              setVal(e.target.value)
              if (serverErr) setServerErr(null)
            }}
            onBlur={() => setTouched(true)}
            placeholder="your-name"
            style={{ paddingLeft: 30 }}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
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
          minWidth: 0,
        }}
      >
        <UserAvatar name={val} size={36} dim={!clientV.ok} />
        <div style={{ flex: 1, minWidth: 0 }}>
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
              overflowWrap: 'anywhere',
            }}
          >
            {clientV.ok ? `@${val}` : '—'}
          </div>
        </div>
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
  pendingEmail,
  onDirtyChange,
}: {
  email: string | null
  confirmedAt: string | null
  pendingEmail: string | null
  onDirtyChange: (dirty: boolean) => void
}) {
  const setEmail = useSetEmail()
  const resendEmail = useResendEmailConfirmation()
  const displayAddress = pendingEmail ?? email ?? ''
  const hasAddress = Boolean(email || pendingEmail)
  const [val, setVal] = useState(displayAddress)
  const [touched, setTouched] = useState(false)
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [honeypot, setHoneypot] = useState('')
  const [serverErr, setServerErr] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const captchaRef = useRef<TurnstileHandle | null>(null)

  // Reset the local input when the underlying session value changes (e.g. on
  // refetch after another tab confirmed). Avoid clobbering in-progress edits.
  const lastSyncedRef = useRef(displayAddress)
  useEffect(() => {
    if (displayAddress === lastSyncedRef.current) return
    lastSyncedRef.current = displayAddress
    setVal(displayAddress)
    setTouched(false)
    setServerErr(null)
  }, [displayAddress])

  const v = useMemo(() => validateEmail(val), [val])
  const dirty = val !== displayAddress
  // Report dirtiness up so the page can guard reload / navigation away (#440).
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  const showErr = serverErr ?? (touched && !v.ok ? v.err : null)

  const status = deriveEmailStatus({ email, confirmedAt, pendingEmail })

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
      toast.success(`Verification link sent to ${val}.`)
    } catch (err) {
      resetCaptcha()
      if (err instanceof ApiError && err.status && err.status < 500) {
        // A 422 carries a raw pydantic message ("...The email address is too
        // long (N characters too many)"); show friendly copy instead of
        // echoing it. Other 4xx detail is already operator-safe.
        if (err.status === 422) {
          setServerErr("That doesn't look like a valid email.")
          return
        }
        setServerErr(err.detail ?? 'Server rejected this email.')
        return
      }
      toast.error(
        err instanceof Error
          ? `Couldn't update email: ${err.message}`
          : "Couldn't update email.",
      )
    }
  }

  const onResend = async () => {
    if (!captchaToken) {
      toast.error('Complete the CAPTCHA, then click Resend.')
      return
    }
    try {
      await resendEmail.mutateAsync({ captchaToken, honeypot })
      resetCaptcha()
      toast.success(`Verification link re-sent to ${displayAddress}.`)
    } catch (err) {
      resetCaptcha()
      toast.error(
        err instanceof ApiError && err.detail
          ? err.detail
          : "Couldn't resend confirmation.",
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
            setVal(displayAddress)
            setTouched(false)
            setServerErr(null)
          }}
          primaryLabel={hasAddress ? 'Update email' : 'Add email'}
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

      {hasAddress && (
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
                  <span style={{ fontFamily: 'var(--font-mono)' }}>
                    {pendingEmail ?? email}
                  </span>
                  .
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
/*  03 — Notifications (test push to iOS)                             */
/* ------------------------------------------------------------------ */

function NotificationsSection() {
  const sendTest = useSendTestNotification()
  // Inline note for the non-error "nothing to send / not set up" outcomes;
  // genuine delivery is confirmed with a toast.
  const [note, setNote] = useState<string | null>(null)

  const onSend = async () => {
    setNote(null)
    try {
      const result = await sendTest.mutateAsync()
      if (result.sent === 0) {
        setNote(
          'No devices registered yet. Install the FortyMM iOS app, sign in with this account and allow notifications, then try again.',
        )
        return
      }
      const plural = result.sent === 1 ? 'device' : 'devices'
      toast.success(`Test notification sent to ${result.sent} ${plural}.`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setNote("Push notifications aren't configured on the server yet.")
        return
      }
      toast.error(
        err instanceof Error
          ? `Couldn't send test notification: ${err.message}`
          : "Couldn't send test notification.",
      )
    }
  }

  return (
    <SectionCard
      id="sec-notifications"
      num="03"
      eyebrow="Devices"
      title="Push notifications"
      subtitle="Send a test notification to your iOS devices to confirm push is working. It goes to every device where you're signed into this account with the app installed."
    >
      <button
        type="button"
        className="fmm-btn fmm-btn--primary"
        onClick={onSend}
        disabled={sendTest.isPending}
      >
        {sendTest.isPending ? (
          <>
            <Spinner /> Sending…
          </>
        ) : (
          'Send test notification'
        )}
      </button>
      {note && (
        <div className="fmm-help" style={{ marginTop: 12 }}>
          {note}
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
  // scrollIntoView honors the section's `scroll-margin-top` (set in settings.css
  // to clear the sticky topbar), so the heading lands below the bar instead of
  // behind it — same offset native hash navigation uses, one source of truth (#162).
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function focusEmailInput() {
  // preventScroll so focus() doesn't fight the smooth scroll above.
  document.getElementById('email')?.focus({ preventScroll: true })
}

function SettingsPage() {
  const session = useSession()
  const logout = useLogout()
  const navigate = useNavigate()
  const sessionUser = session.data?.data.user
  const sessionUsername = sessionUser?.username ?? ''
  const sessionEmail = sessionUser?.email ?? null
  const sessionConfirmedAt = sessionUser?.confirmed_at ?? null
  const sessionPendingEmail = sessionUser?.pending_email ?? null
  const hash = useRouterState({ select: (s) => s.location.hash })

  const effectiveStatus = deriveEmailStatus({
    email: sessionEmail,
    confirmedAt: sessionConfirmedAt,
    pendingEmail: sessionPendingEmail,
  })
  const claimed = effectiveStatus === 'verified'

  // Honor /settings#sec-* deep links from external nav. When the email
  // section is the target and the account isn't already claimed, focus
  // the input so users arriving from a recovery nudge can start typing.
  // Wait for the session to resolve before deciding — otherwise verified
  // users hitting a stale #sec-email URL would briefly look like guests
  // and get their soft keyboard popped before we know better.
  const sessionLoaded = !!sessionUser
  useEffect(() => {
    const id = hash.replace(/^#/, '')
    if (!id) return
    scrollToSection(id)
    if (id === 'sec-email' && sessionLoaded && !claimed) focusEmailInput()
  }, [hash, sessionLoaded, claimed])

  // Aggregate each section's dirtiness so we can warn before a reload, tab
  // close, or in-app navigation silently discards an in-progress edit (#440).
  const [usernameDirty, setUsernameDirty] = useState(false)
  const [emailDirty, setEmailDirty] = useState(false)
  const anyDirty = usernameDirty || emailDirty

  // `enableBeforeUnload` arms the native reload/close prompt; `withResolver`
  // lets us replace the in-app browser confirm() with a design-system dialog.
  const blocker = useBlocker({
    shouldBlockFn: () => anyDirty,
    enableBeforeUnload: () => anyDirty,
    withResolver: true,
  })

  return (
    <>
      <div className="fmm-settings">
        <TooltipProvider>
          <div className="fmm-main-inner">
            <PageHeader username={sessionUsername} claimed={claimed} />

            <ClaimBanner
              status={effectiveStatus}
              email={sessionPendingEmail ?? sessionEmail ?? ''}
              onJump={() => {
                scrollToSection('sec-email')
                focusEmailInput()
              }}
            />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <UsernameSection
                currentUsername={sessionUsername}
                onDirtyChange={setUsernameDirty}
              />
              <EmailSection
                email={sessionEmail}
                confirmedAt={sessionConfirmedAt}
                pendingEmail={sessionPendingEmail}
                onDirtyChange={setEmailDirty}
              />
              <NotificationsSection />
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
              </div>
            </ComingSoon>
            {/*
              "Sign out" is a real, available action (the user-menu "Log out"
              uses the same flow), so it lives outside the coming-soon footer
              placeholder as a genuine, keyboard-focusable button. See #378.
            */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                marginTop: 12,
              }}
            >
              <button
                type="button"
                className="fmm-link"
                data-testid="settings-footer-sign-out"
                disabled={logout.isPending}
                onClick={() => {
                  logout.mutate(undefined, {
                    onSuccess: () => {
                      void navigate({ to: '/', search: { landing: false } })
                    },
                  })
                }}
                style={{
                  fontSize: 'var(--text-xs)',
                  fontFamily: 'inherit',
                  letterSpacing: 'inherit',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        </TooltipProvider>
      </div>
      <AlertDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          // Radix fires onOpenChange(false) on overlay click / Escape — treat
          // that as "stay on the page" so a stray dismiss never discards edits.
          if (!open) blocker.reset?.()
        }}
      >
        <AlertDialogContent data-testid="unsaved-changes-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have changes that haven't been saved. If you leave now, they'll
              be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>
              Stay on this page
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => blocker.proceed?.()}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
