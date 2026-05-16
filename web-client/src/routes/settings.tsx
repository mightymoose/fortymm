import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { createFileRoute, useRouterState } from '@tanstack/react-router'

import { AppShell } from '@/components/app-shell'
import { pageTitle } from '@/lib/page-title'
import './settings.css'

export const Route = createFileRoute('/settings')({
  head: () => ({
    meta: [{ title: pageTitle('Settings') }],
  }),
  component: SettingsPage,
})

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/*  UI only — no backend wired up yet. State lives in the component.  */
/* ------------------------------------------------------------------ */

type EmailStatus = 'guest' | 'pending' | 'verified'

interface NotificationPrefs {
  matchInvites: boolean
  tournamentUpdates: boolean
  ratingChanges: boolean
  clubAnnouncements: boolean
  digestEmail: boolean
}

interface User {
  username: string
  email: string
  emailVerified: boolean
  homeClub: string | null
  notifications: NotificationPrefs
  sessionId: string
  sessionStartedAt: number
  location: string
  _lastSaved: {
    username: number | null
    email: number | null
    notifications: number | null
    club: number | null
    verified: number | null
  }
}

interface Club {
  id: string
  name: string
  city: string
  members: number
  dist: string
}

interface Validation {
  ok: boolean
  err?: string
}

/* ------------------------------------------------------------------ */
/*  Icons — tiny inline SVGs, ported from the design handoff          */
/* ------------------------------------------------------------------ */

interface IconProps {
  size?: number
  color?: string
}

const Icon = {
  Check: ({ size = 16, color = 'currentColor' }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12l5 5L20 7" />
    </svg>
  ),
  Search: ({ size = 16, color = 'currentColor' }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  ),
  Mail: ({ size = 16, color = 'currentColor' }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  ),
  Pin: ({ size = 16, color = 'currentColor' }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22s8-7.5 8-13a8 8 0 10-16 0c0 5.5 8 13 8 13z" />
      <circle cx="12" cy="9" r="2.5" />
    </svg>
  ),
  ChevronRight: ({ size = 16, color = 'currentColor' }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  Edit: ({ size = 16, color = 'currentColor' }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  ),
  Refresh: ({ size = 16, color = 'currentColor' }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 0115-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 01-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  ),
  Trash: ({ size = 16, color = 'currentColor' }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
    </svg>
  ),
  Globe: ({ size = 16, color = 'currentColor' }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
    </svg>
  ),
}

/* ------------------------------------------------------------------ */
/*  Fake data + helpers                                               */
/* ------------------------------------------------------------------ */

const CLUBS: Club[] = [
  { id: 'brk', name: 'Brooklyn Paddle Club', city: 'Brooklyn, NY', members: 184, dist: '2.1 mi' },
  { id: 'mhs', name: 'Manhattan Smash', city: 'New York, NY', members: 312, dist: '5.4 mi' },
  { id: 'bay', name: 'Bay Area Table Tennis', city: 'San Francisco, CA', members: 421, dist: '2,900 mi' },
  { id: 'mlt', name: 'Maple Leaf TTC', city: 'Toronto, ON', members: 246, dist: '470 mi' },
  { id: 'pgb', name: 'Pongtopia', city: 'Berlin, DE', members: 198, dist: '3,950 mi' },
  { id: 'elw', name: 'East London Spin', city: 'London, UK', members: 167, dist: '3,470 mi' },
  { id: 'atx', name: 'Austin Spin Club', city: 'Austin, TX', members: 142, dist: '1,510 mi' },
  { id: 'sea', name: 'Pacific Paddles', city: 'Seattle, WA', members: 209, dist: '2,420 mi' },
  { id: 'gns', name: 'Granite State TTC', city: 'Concord, NH', members: 88, dist: '230 mi' },
  { id: 'lkv', name: 'Lakeview Loopers', city: 'Chicago, IL', members: 261, dist: '750 mi' },
  { id: 'nct', name: 'North Country TT', city: 'Minneapolis, MN', members: 134, dist: '1,020 mi' },
  { id: 'wst', name: 'Westside Wallop', city: 'Los Angeles, CA', members: 277, dist: '2,460 mi' },
  { id: 'syd', name: 'Sydney Topspin', city: 'Sydney, AU', members: 158, dist: '9,950 mi' },
  { id: 'tky', name: 'Tokyo Loop Society', city: 'Tokyo, JP', members: 401, dist: '6,750 mi' },
]

function clubInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
}

const TAKEN_USERNAMES = new Set([
  'admin',
  'fortymm',
  'forty',
  'mm',
  'support',
  'root',
  'nguyen',
  'okafor',
])

function validateUsername(u: string): Validation {
  if (!u) return { ok: false, err: 'Username is required.' }
  if (u.length < 3) return { ok: false, err: 'At least 3 characters.' }
  if (u.length > 20) return { ok: false, err: 'No more than 20 characters.' }
  if (!/^[a-z0-9._-]+$/i.test(u))
    return { ok: false, err: 'Letters, numbers, dots, hyphens and underscores only.' }
  if (/^[._-]|[._-]$/.test(u))
    return { ok: false, err: "Can't start or end with a dot, hyphen, or underscore." }
  if (TAKEN_USERNAMES.has(u.toLowerCase()))
    return { ok: false, err: "That one's taken. Pick another." }
  return { ok: true }
}

function validateEmail(e: string): Validation {
  if (!e) return { ok: false, err: 'Email is required to claim your account.' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e))
    return { ok: false, err: "That doesn't look like a valid email." }
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

function makeSessionId(): string {
  const hex = '0123456789abcdef'
  let s = ''
  for (let i = 0; i < 16; i++) s += hex[Math.floor(Math.random() * 16)]
  return `sess_${s.slice(0, 4)}·${s.slice(4, 8)}·${s.slice(8, 12)}·${s.slice(12, 16)}`
}

function makeGuestName(): string {
  const hex = '0123456789abcdef'
  let s = ''
  for (let i = 0; i < 5; i++) s += hex[Math.floor(Math.random() * 16)]
  return `guest-${s}`
}

function initialUser(): User {
  return {
    username: 'guest-7f3a2',
    email: '',
    emailVerified: false,
    homeClub: null,
    notifications: {
      matchInvites: true,
      tournamentUpdates: true,
      ratingChanges: true,
      clubAnnouncements: true,
      digestEmail: false,
    },
    sessionId: 'sess_7f3a·2c91·b40e·d18a',
    sessionStartedAt: Date.now() - 28 * 60 * 1000, // 28 min ago
    location: 'Brooklyn, NY',
    _lastSaved: {
      username: null,
      email: null,
      notifications: null,
      club: null,
      verified: null,
    },
  }
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

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="fmm-toggle"
      data-on={String(!!checked)}
      data-disabled={String(!!disabled)}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
    />
  )
}

function Modal({
  onClose,
  children,
  ariaLabel,
}: {
  onClose: () => void
  children: ReactNode
  ariaLabel: string
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  return (
    <div className="fmm-modal-scrim" onClick={onClose} role="dialog" aria-label={ariaLabel}>
      <div className="fmm-modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
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
        <Icon.Check size={14} color="var(--serve-500)" />
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

function KVCard({
  k,
  v,
  sub,
  mono,
}: {
  k: string
  v: string
  sub?: string
  mono?: boolean
}) {
  return (
    <div
      style={{
        padding: '14px 16px',
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-md)',
      }}
    >
      <div className="fmm-overline" style={{ marginBottom: 6 }}>
        {k}
      </div>
      <div
        style={{
          fontSize: 'var(--text-md)',
          fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)',
          fontWeight: 500,
          color: 'var(--fg-1)',
          letterSpacing: mono ? '0.02em' : 'normal',
          wordBreak: 'break-all',
        }}
      >
        {v}
      </div>
      {sub && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-muted)', marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Page header — large Bebas "SETTINGS"                              */
/* ------------------------------------------------------------------ */

function PageHeader({ user, claimed }: { user: User; claimed: boolean }) {
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
          <Avatar name={user.username} size={26} dim={!claimed} />
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              color: 'var(--fg-2)',
              letterSpacing: '0.02em',
            }}
          >
            {user.username}
          </div>
          {claimed && <Icon.Check size={14} color="var(--serve-500)" />}
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
        Five sections. Save each on its own — we don't bundle changes you didn't ask for.
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
  const toast = useToast()
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
        {guest ? (
          <button type="button" className="fmm-btn fmm-btn--primary fmm-btn--sm" onClick={onJump}>
            Add email
          </button>
        ) : (
          <>
            <button
              type="button"
              className="fmm-btn fmm-btn--quiet fmm-btn--sm"
              onClick={() => toast(`Verification link re-sent to ${email}.`)}
            >
              Resend
            </button>
            <button
              type="button"
              className="fmm-btn fmm-btn--ghost fmm-btn--sm"
              onClick={onJump}
            >
              Verify now
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  01 — Username                                                     */
/* ------------------------------------------------------------------ */

function UsernameSection({
  user,
  setUser,
}: {
  user: User
  setUser: Dispatch<SetStateAction<User>>
}) {
  const toast = useToast()
  const [val, setVal] = useState(user.username)
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(user._lastSaved.username)

  const v = useMemo(() => validateUsername(val), [val])
  const dirty = val !== user.username
  const showErr = touched && !v.ok

  const onSave = async () => {
    if (!v.ok) return
    setSaving(true)
    await new Promise((r) => setTimeout(r, 700))
    const now = Date.now()
    setUser((u) => ({ ...u, username: val, _lastSaved: { ...u._lastSaved, username: now } }))
    setSavedAt(now)
    setSaving(false)
    setTouched(false)
    toast('Username saved.')
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
          valid={v.ok}
          saving={saving}
          savedAt={savedAt}
          onSave={onSave}
          onCancel={() => {
            setVal(user.username)
            setTouched(false)
          }}
        />
      }
    >
      <Field
        label="Username"
        htmlFor="username"
        hint="Lowercase letters, numbers, dots, hyphens and underscores. 3–20 characters."
        error={showErr ? v.err : null}
        success={dirty && v.ok ? 'Looks good. Save to make it stick.' : null}
        right={
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              color: val.length > 20 ? 'var(--loss)' : 'var(--fg-muted)',
              letterSpacing: '0.05em',
            }}
          >
            {val.length}/20
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
            className={`fmm-input fmm-input--mono ${showErr ? 'fmm-input--err' : dirty && v.ok ? 'fmm-input--ok' : ''}`}
            value={val}
            onChange={(e) => setVal(e.target.value.toLowerCase().replace(/\s/g, ''))}
            onBlur={() => setTouched(true)}
            placeholder="guest-7f3a2"
            style={{ paddingLeft: 30 }}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={showErr || undefined}
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
        <Avatar name={val} size={36} dim={!v.ok} />
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
            {v.ok ? `@${val}` : '—'}
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
          fortymm.app/p/{v.ok ? val : '—'}
        </span>
      </div>
    </SectionCard>
  )
}

/* ------------------------------------------------------------------ */
/*  02 — Email (required to claim)                                    */
/* ------------------------------------------------------------------ */

function EmailSection({
  user,
  setUser,
}: {
  user: User
  setUser: Dispatch<SetStateAction<User>>
}) {
  const toast = useToast()
  const [val, setVal] = useState(user.email)
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(user._lastSaved.email)

  const v = useMemo(() => validateEmail(val), [val])
  const dirty = val !== user.email
  const showErr = touched && !v.ok

  const status: EmailStatus = user.emailVerified
    ? 'verified'
    : user.email
      ? 'pending'
      : 'guest'

  const onSave = async () => {
    if (!v.ok) return
    setSaving(true)
    await new Promise((r) => setTimeout(r, 700))
    const now = Date.now()
    setUser((u) => ({
      ...u,
      email: val,
      emailVerified: false, // re-verify on any change
      _lastSaved: { ...u._lastSaved, email: now },
    }))
    setSavedAt(now)
    setSaving(false)
    setTouched(false)
    toast(`Verification link sent to ${val}.`)
  }

  const onVerify = async () => {
    setVerifying(true)
    await new Promise((r) => setTimeout(r, 900))
    setUser((u) => ({
      ...u,
      emailVerified: true,
      _lastSaved: { ...u._lastSaved, verified: Date.now() },
    }))
    setVerifying(false)
    toast('Email verified. Account claimed.')
  }

  const onResend = () => {
    toast(`Verification link re-sent to ${user.email}.`)
  }

  const onRemove = () => {
    setUser((u) => ({ ...u, email: '', emailVerified: false }))
    setVal('')
    setSavedAt(null)
    toast("Email removed. You're back to a guest session.", { kind: 'err' })
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
          valid={v.ok}
          saving={saving}
          savedAt={savedAt}
          onSave={onSave}
          onCancel={() => {
            setVal(user.email)
            setTouched(false)
          }}
          primaryLabel={user.email ? 'Update email' : 'Add email'}
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
        error={showErr ? v.err : null}
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
            <Icon.Mail size={16} color="var(--fg-muted)" />
          </span>
          <input
            id="email"
            type="email"
            className={`fmm-input fmm-input--mono ${showErr ? 'fmm-input--err' : status === 'verified' && !dirty ? 'fmm-input--ok' : ''}`}
            value={val}
            onChange={(e) => setVal(e.target.value.trim())}
            onBlur={() => setTouched(true)}
            placeholder="you@example.com"
            style={{ paddingLeft: 38 }}
            spellCheck={false}
            autoComplete="email"
            aria-invalid={showErr || undefined}
          />
        </div>
      </Field>

      {/* Verification state strip */}
      {user.email && (
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
              <Icon.Check size={16} color="var(--serve-500)" />
            </div>
          ) : (
            <span
              className="ball-dot ball-dot--warn"
              style={{ width: 12, height: 12, marginLeft: 8 }}
            />
          )}
          <div style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>
            {status === 'verified' ? (
              <>
                <div style={{ fontWeight: 600, color: 'var(--fg-1)' }}>Account claimed.</div>
                <div style={{ color: 'var(--fg-3)', marginTop: 2 }}>
                  Verified {relativeTime(user._lastSaved.verified ?? 0)}. You can sign in from
                  anywhere.
                </div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 600, color: 'var(--fg-1)' }}>
                  Waiting for verification.
                </div>
                <div style={{ color: 'var(--fg-3)', marginTop: 2 }}>
                  Open the link in your inbox. Or — for the demo — click verify.
                </div>
              </>
            )}
          </div>
          {status === 'pending' && (
            <>
              <button
                type="button"
                className="fmm-btn fmm-btn--quiet fmm-btn--sm"
                onClick={onResend}
              >
                Resend
              </button>
              <button
                type="button"
                className="fmm-btn fmm-btn--primary fmm-btn--sm"
                onClick={onVerify}
                disabled={verifying}
              >
                {verifying ? (
                  <>
                    <Spinner />
                    Verifying…
                  </>
                ) : (
                  'Verify'
                )}
              </button>
            </>
          )}
        </div>
      )}

      {user.email && (
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="fmm-btn fmm-btn--danger fmm-btn--sm"
            onClick={onRemove}
          >
            <Icon.Trash size={14} /> Remove email
          </button>
        </div>
      )}
    </SectionCard>
  )
}

/* ------------------------------------------------------------------ */
/*  03 — Home club                                                    */
/* ------------------------------------------------------------------ */

function HomeClubSection({
  user,
  setUser,
}: {
  user: User
  setUser: Dispatch<SetStateAction<User>>
}) {
  const toast = useToast()
  const [open, setOpen] = useState(false)

  const club = user.homeClub ? (CLUBS.find((c) => c.id === user.homeClub) ?? null) : null

  const onPick = (clubId: string) => {
    const c = CLUBS.find((x) => x.id === clubId)
    setUser((u) => ({ ...u, homeClub: clubId, _lastSaved: { ...u._lastSaved, club: Date.now() } }))
    setOpen(false)
    if (c) toast(`Home club set to ${c.name}.`)
  }

  const onClear = () => {
    setUser((u) => ({ ...u, homeClub: null, _lastSaved: { ...u._lastSaved, club: Date.now() } }))
    toast('Home club cleared.')
  }

  return (
    <SectionCard
      id="sec-club"
      num="03"
      eyebrow="Location"
      title="Home club"
      subtitle="Pick the place you mostly play. We'll surface their matches, ladders, and tournaments first."
    >
      {club ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            padding: '18px 20px',
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--r-md)',
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 'var(--r-md)',
              background: 'linear-gradient(135deg, var(--ball-500), var(--ball-700))',
              color: 'var(--ink-950)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--font-display)',
              fontSize: 22,
              letterSpacing: '0.04em',
              fontWeight: 600,
            }}
          >
            {clubInitials(club.name)}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--fg-1)' }}>
              {club.name}
            </div>
            <div
              style={{
                display: 'flex',
                gap: 14,
                marginTop: 4,
                fontSize: 'var(--text-sm)',
                color: 'var(--fg-3)',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon.Pin size={13} color="var(--fg-muted)" /> {club.city}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>·</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-3)' }}>
                {club.members} members
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>·</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-3)' }}>
                {club.dist}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="fmm-btn fmm-btn--ghost fmm-btn--sm"
            onClick={() => setOpen(true)}
          >
            <Icon.Edit size={14} /> Change
          </button>
          <button type="button" className="fmm-btn fmm-btn--quiet fmm-btn--sm" onClick={onClear}>
            Clear
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="fmm-clubpick"
          onClick={() => setOpen(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            width: '100%',
            padding: '20px 22px',
            borderRadius: 'var(--r-md)',
            color: 'var(--fg-2)',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 'var(--r-md)',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon.Pin size={18} color="var(--ball-500)" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, color: 'var(--fg-1)' }}>Pick your home club</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-3)', marginTop: 2 }}>
              Search by name or city. Don't see yours? You can skip.
            </div>
          </div>
          <Icon.ChevronRight size={18} color="var(--fg-muted)" />
        </button>
      )}

      {open && (
        <ClubPickerModal
          onClose={() => setOpen(false)}
          selectedId={user.homeClub}
          onPick={onPick}
        />
      )}
    </SectionCard>
  )
}

/* ------------------------------------------------------------------ */
/*  Club picker modal                                                 */
/* ------------------------------------------------------------------ */

function ClubPickerModal({
  onClose,
  onPick,
  selectedId,
}: {
  onClose: () => void
  onPick: (id: string) => void
  selectedId: string | null
}) {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return CLUBS
    return CLUBS.filter(
      (c) => c.name.toLowerCase().includes(s) || c.city.toLowerCase().includes(s),
    )
  }, [q])

  return (
    <Modal onClose={onClose} ariaLabel="Pick your home club">
      <header style={{ padding: '20px 24px 0' }}>
        <div className="fmm-overline" style={{ color: 'var(--ball-500)', marginBottom: 8 }}>
          ● Home club
        </div>
        <h3
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--text-xl)',
            fontWeight: 600,
            margin: '0 0 12px',
            color: 'var(--fg-1)',
          }}
        >
          Pick your club
        </h3>
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}>
            <Icon.Search size={16} color="var(--fg-muted)" />
          </span>
          <input
            ref={inputRef}
            className="fmm-input"
            placeholder="Search by name or city"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ paddingLeft: 38 }}
          />
        </div>
      </header>

      <div style={{ padding: '4px 14px', overflowY: 'auto', flex: 1 }}>
        {filtered.length === 0 ? (
          <div
            style={{
              padding: '40px 16px',
              textAlign: 'center',
              color: 'var(--fg-3)',
              fontSize: 'var(--text-sm)',
            }}
          >
            No clubs match "<span style={{ color: 'var(--fg-1)' }}>{q}</span>".
            <br />
            <span style={{ color: 'var(--fg-muted)' }}>
              You can skip — we'll ask again later.
            </span>
          </div>
        ) : (
          filtered.map((c) => (
            <div
              key={c.id}
              className="fmm-clubrow"
              data-selected={String(c.id === selectedId)}
              onClick={() => onPick(c.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onPick(c.id)
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 'var(--r-md)',
                  background:
                    c.id === selectedId
                      ? 'linear-gradient(135deg, var(--ball-500), var(--ball-700))'
                      : 'var(--bg-raised)',
                  color: c.id === selectedId ? 'var(--ink-950)' : 'var(--fg-2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                {clubInitials(c.name)}
              </div>
              <div>
                <div
                  className="fmm-clubrow-name"
                  style={{
                    fontSize: 'var(--text-base)',
                    fontWeight: 500,
                    color: 'var(--fg-1)',
                    marginBottom: 1,
                  }}
                >
                  {c.name}
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>
                  {c.city} · <span style={{ fontFamily: 'var(--font-mono)' }}>{c.members}</span>{' '}
                  members
                </div>
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-xs)',
                  color: c.id === selectedId ? 'var(--ball-500)' : 'var(--fg-muted)',
                  letterSpacing: '0.04em',
                }}
              >
                {c.id === selectedId ? '● selected' : c.dist}
              </div>
            </div>
          ))
        )}
      </div>

      <footer
        style={{
          padding: '14px 20px',
          background: 'var(--bg-panel)',
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--fg-muted)',
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.08em',
          }}
        >
          {filtered.length} of {CLUBS.length} clubs
        </span>
        <button type="button" className="fmm-btn fmm-btn--ghost fmm-btn--sm" onClick={onClose}>
          Close
        </button>
      </footer>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/*  04 — Notifications                                                */
/* ------------------------------------------------------------------ */

interface NotifItem {
  key: keyof NotificationPrefs
  label: string
  desc: string
  needsEmail?: boolean
}

const NOTIF_ITEMS: NotifItem[] = [
  { key: 'matchInvites', label: 'Match invites', desc: 'When another player challenges you.' },
  {
    key: 'tournamentUpdates',
    label: 'Tournament updates',
    desc: 'Draws posted, schedule shifts, your call to court.',
  },
  { key: 'ratingChanges', label: 'Rating changes', desc: 'After every rated match.' },
  {
    key: 'clubAnnouncements',
    label: 'Club announcements',
    desc: 'News from your home club only.',
  },
  {
    key: 'digestEmail',
    label: 'Weekly digest email',
    desc: 'Quiet recap — Sunday morning. Email only.',
    needsEmail: true,
  },
]

function NotificationsSection({
  user,
  setUser,
}: {
  user: User
  setUser: Dispatch<SetStateAction<User>>
}) {
  const toast = useToast()
  const [draft, setDraft] = useState<NotificationPrefs>(user.notifications)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(user._lastSaved.notifications)

  const dirty = NOTIF_ITEMS.some((it) => draft[it.key] !== user.notifications[it.key])

  const onSave = async () => {
    setSaving(true)
    await new Promise((r) => setTimeout(r, 500))
    const now = Date.now()
    setUser((u) => ({
      ...u,
      notifications: { ...draft },
      _lastSaved: { ...u._lastSaved, notifications: now },
    }))
    setSavedAt(now)
    setSaving(false)
    toast('Notification preferences saved.')
  }

  const hasEmail = !!user.email
  const anyOn = Object.values(draft).some(Boolean)

  return (
    <SectionCard
      id="sec-notifications"
      num="04"
      eyebrow="Notifications"
      title="What you want to hear from us"
      subtitle="Push goes to whichever device you've signed in on. Email needs a verified address."
      footer={
        <SaveBar
          dirty={dirty}
          valid={true}
          saving={saving}
          savedAt={savedAt}
          onSave={onSave}
          onCancel={() => setDraft(user.notifications)}
        />
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {NOTIF_ITEMS.map((it) => {
          const disabled = !!it.needsEmail && !hasEmail
          return (
            <div key={it.key} className="fmm-notif-row">
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 'var(--text-base)',
                    fontWeight: 500,
                    color: disabled ? 'var(--fg-disabled)' : 'var(--fg-1)',
                  }}
                >
                  {it.label}
                  {it.needsEmail && (
                    <span
                      className="fmm-tag"
                      style={{ color: disabled ? 'var(--fg-disabled)' : 'var(--fg-3)' }}
                    >
                      Email
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 'var(--text-sm)',
                    color: disabled ? 'var(--fg-disabled)' : 'var(--fg-3)',
                    marginTop: 2,
                    maxWidth: 480,
                  }}
                >
                  {it.desc}
                  {disabled && ' · Add a verified email to enable.'}
                </div>
              </div>
              <Toggle
                checked={!!draft[it.key] && !disabled}
                disabled={disabled}
                onChange={(value) => setDraft((d) => ({ ...d, [it.key]: value }))}
                label={it.label}
              />
            </div>
          )
        })}
      </div>

      {!anyOn && (
        <div
          style={{
            marginTop: 16,
            padding: '12px 14px',
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--r-md)',
            fontSize: 'var(--text-sm)',
            color: 'var(--fg-3)',
          }}
        >
          Everything's off. You'll only hear from us when you open the app. That's allowed.
        </div>
      )}
    </SectionCard>
  )
}

/* ------------------------------------------------------------------ */
/*  05 — Session                                                      */
/* ------------------------------------------------------------------ */

function SessionSection({
  user,
  onResetSession,
}: {
  user: User
  onResetSession: () => void
}) {
  return (
    <SectionCard
      id="sec-session"
      num="05"
      eyebrow="This session"
      title="Devices & session"
      subtitle="One device per session for now. We don't track you across sites; sessions are device-local."
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 14,
          marginBottom: 16,
        }}
      >
        <KVCard
          k="Session ID"
          v={user.sessionId}
          mono
          sub={`Started ${relativeTime(user.sessionStartedAt)}`}
        />
        <KVCard k="This device" v="Chrome · macOS" sub={user.location} />
      </div>

      <div
        style={{
          padding: '14px 16px',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-md)',
          fontSize: 'var(--text-sm)',
          color: 'var(--fg-2)',
          lineHeight: 'var(--lh-snug)',
        }}
      >
        <strong style={{ color: 'var(--fg-1)' }}>What we keep:</strong> your username, your home
        club, your ratings, your match history.{' '}
        <strong style={{ color: 'var(--fg-1)' }}>What we don't:</strong> location beyond city, ad
        IDs, cross-site cookies, anything we'd be embarrassed about.{' '}
        <a className="fmm-link">Read the privacy promise →</a>
      </div>

      <div style={{ marginTop: 18, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button type="button" className="fmm-btn fmm-btn--ghost fmm-btn--sm">
          <Icon.Globe size={14} /> Export my data
        </button>
        <button
          type="button"
          className="fmm-btn fmm-btn--danger fmm-btn--sm"
          onClick={onResetSession}
        >
          <Icon.Refresh size={14} /> Reset session
        </button>
      </div>
    </SectionCard>
  )
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

function SettingsPage() {
  const [user, setUser] = useState<User>(initialUser)
  const hash = useRouterState({ select: (s) => s.location.hash })

  const effectiveStatus: EmailStatus = user.emailVerified
    ? 'verified'
    : user.email
      ? 'pending'
      : 'guest'
  const claimed = effectiveStatus === 'verified'

  // Smooth-scroll to a section when the sidebar links to /settings#sec-*.
  useEffect(() => {
    const id = hash.replace(/^#/, '')
    if (!id) return
    const el = document.getElementById(id)
    if (!el) return
    const y = el.getBoundingClientRect().top + window.scrollY - 24
    window.scrollTo({ top: y, behavior: 'smooth' })
  }, [hash])

  const onJump = (id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    const y = el.getBoundingClientRect().top + window.scrollY - 24
    window.scrollTo({ top: y, behavior: 'smooth' })
  }

  const onResetSession = () => {
    setUser({
      ...initialUser(),
      username: makeGuestName(),
      sessionId: makeSessionId(),
      sessionStartedAt: Date.now(),
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // The section components keep a local draft of their field; re-keying on the
  // session id remounts them with fresh state after "Reset session".
  const sessionKey = user.sessionId

  return (
    <AppShell>
      <div className="fmm-settings">
        <ToastProvider>
          <div className="fmm-main-inner">
            <PageHeader user={user} claimed={claimed} />

            <ClaimBanner
              status={effectiveStatus}
              email={user.email}
              onJump={() => onJump('sec-email')}
            />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <UsernameSection key={`u-${sessionKey}`} user={user} setUser={setUser} />
              <EmailSection key={`e-${sessionKey}`} user={user} setUser={setUser} />
              <HomeClubSection user={user} setUser={setUser} />
              <NotificationsSection key={`n-${sessionKey}`} user={user} setUser={setUser} />
              <SessionSection user={user} onResetSession={onResetSession} />
            </div>

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
          </div>
        </ToastProvider>
      </div>
    </AppShell>
  )
}
