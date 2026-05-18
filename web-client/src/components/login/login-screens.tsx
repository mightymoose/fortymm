import type { CSSProperties, ReactNode } from 'react'

import './login.css'

/* ─── Brand atoms ───────────────────────────────────────────────────── */

function BallLogo({ size = 26 }: { size?: number }) {
  const gradId = `fmm-login-lg-${size}`
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <svg width={size} height={size} viewBox="0 0 80 80">
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

function Eyebrow({
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
      <BallLogo size={26} />

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
            background:
              active === -1
                ? n === 4
                  ? 'var(--loss)'
                  : 'var(--ink-500)'
                : n <= active
                  ? 'var(--ball-500)'
                  : 'var(--ink-600)',
            transition: 'all 200ms var(--ease-out)',
          }}
        />
      ))}
    </div>
  )
}

/* ─── Form parts ────────────────────────────────────────────────────── */

function EmailField({
  defaultValue = '',
  state = 'valid',
}: {
  defaultValue?: string
  state?: 'valid' | 'error'
}) {
  const error = state === 'error'
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
        defaultValue={defaultValue}
        placeholder="you@yourclub.com"
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
    </div>
  )
}

function EmailReceipt({ email }: { email: string }) {
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
      <div style={receiptDiv} />
      <div style={receiptRow}>
        <span style={receiptK}>From</span>
        <span style={{ ...receiptV, color: 'var(--fg-3)' }}>
          no-reply@fortymm.com
        </span>
      </div>
    </div>
  )
}

function VerifyCard() {
  return (
    <div
      style={{
        ...receiptCard,
        borderColor: 'rgba(255,122,26,0.35)',
        boxShadow:
          '0 0 0 1px rgba(255,122,26,0.18), 0 8px 24px rgba(255,122,26,0.10)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '4px 0 14px',
        }}
      >
        <Spinner />
        <div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              fontWeight: 700,
              color: 'var(--ball-500)',
              letterSpacing: '0.18em',
            }}
          >
            ● VERIFYING TOKEN
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
            Confirming signature &amp; expiry…
          </div>
        </div>
      </div>
      <div style={receiptDiv} />
      <div style={receiptRow}>
        <span style={receiptK}>Issued</span>
        <span style={receiptV}>2 min ago · device match</span>
      </div>
    </div>
  )
}

function SolverLog() {
  const lines: Array<[string, string, string, string]> = [
    ['200', 'POST', '/auth/verify', 'token signature ok'],
    ['200', 'GET', '/auth/session', 'device fingerprint match'],
    ['…', '···', '/auth/grant', 'minting session…'],
  ]
  return (
    <div style={logCard}>
      {lines.map((l, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: '42px 56px 1fr auto',
            gap: 10,
          }}
        >
          <span
            style={{
              color: l[0] === '200' ? 'var(--serve-500)' : 'var(--warn)',
            }}
          >
            {l[0]}
          </span>
          <span style={{ color: 'var(--fg-2)' }}>{l[1]}</span>
          <span style={{ color: 'var(--ball-500)' }}>{l[2]}</span>
          <span style={{ color: 'var(--fg-muted)' }}>{l[3]}</span>
        </div>
      ))}
    </div>
  )
}

function FailedSolverLog() {
  const lines: Array<[string, string, string, string]> = [
    ['200', 'POST', '/auth/verify', 'token signature ok'],
    ['…', 'GET', '/auth/session', 'connecting…'],
    ['522', 'GET', '/auth/session', 'origin unreachable'],
    ['522', 'GET', '/auth/session', 'retry 2/3 · failed'],
    ['ERR', '···', '/auth/session', 'gave up after 12s'],
  ]
  return (
    <div style={logCard}>
      {lines.map((l, i) => {
        const c =
          l[0] === '200'
            ? 'var(--serve-500)'
            : l[0] === '…'
              ? 'var(--warn)'
              : 'var(--loss)'
        return (
          <div
            key={i}
            style={{
              display: 'grid',
              gridTemplateColumns: '42px 56px 1fr auto',
              gap: 10,
            }}
          >
            <span style={{ color: c }}>{l[0]}</span>
            <span style={{ color: 'var(--fg-2)' }}>{l[1]}</span>
            <span
              style={{
                color: c === 'var(--loss)' ? 'var(--loss)' : 'var(--ball-500)',
              }}
            >
              {l[2]}
            </span>
            <span style={{ color: 'var(--fg-muted)' }}>{l[3]}</span>
          </div>
        )
      })}
    </div>
  )
}

function SuccessReceipt() {
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
            Tomás Fischer · Club 37 · seed 14
          </div>
        </div>
      </div>
      <div style={receiptDiv} />
      <div style={receiptRow}>
        <span style={receiptK}>Rating</span>
        <span style={{ ...receiptV, color: 'var(--serve-500)' }}>
          1842 ▲ +12
        </span>
      </div>
      <div style={receiptDiv} />
      <div style={receiptRow}>
        <span style={receiptK}>Next match</span>
        <span style={receiptV}>Tonight · 19:30 · Court 2</span>
      </div>
    </div>
  )
}

function InlineError({
  code,
  title,
  detail,
  statusUrl,
}: {
  code: string
  title: string
  detail: string
  statusUrl?: string
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
        {statusUrl && (
          <>
            {' '}
            <a style={linkInline}>{statusUrl}</a>
          </>
        )}
      </div>
    </div>
  )
}

function BounceReceipt({ email }: { email: string }) {
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
        <div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              fontWeight: 700,
              color: 'var(--loss)',
              letterSpacing: '0.18em',
            }}
          >
            ● ERR_HARD_BOUNCE
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
            Mailbox doesn’t exist
          </div>
        </div>
      </div>
      <div style={receiptDiv} />
      <div style={receiptRow}>
        <span style={receiptK}>To</span>
        <span style={{ ...receiptV, color: 'var(--loss)' }}>{email}</span>
      </div>
      <div style={receiptDiv} />
      <div style={receiptRow}>
        <span style={receiptK}>Reason</span>
        <span style={receiptV}>550 5.1.1 No such user</span>
      </div>
      <div style={receiptDiv} />
      <div style={receiptRow}>
        <span style={receiptK}>Server</span>
        <span style={{ ...receiptV, color: 'var(--fg-3)' }}>
          mx1.club37.de
        </span>
      </div>
    </div>
  )
}

function ErrorReceipt({ code }: { code: string }) {
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
        <div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              fontWeight: 700,
              color: 'var(--loss)',
              letterSpacing: '0.18em',
            }}
          >
            ● TOKEN REJECTED
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
            {code}
          </div>
        </div>
      </div>
      <div style={receiptDiv} />
      <div style={receiptRow}>
        <span style={receiptK}>Issued</span>
        <span style={{ ...receiptV, color: 'var(--fg-2)' }}>18 min ago</span>
      </div>
      <div style={receiptDiv} />
      <div style={receiptRow}>
        <span style={receiptK}>Expired</span>
        <span style={{ ...receiptV, color: 'var(--loss)' }}>
          3 min ago · ttl 15m
        </span>
      </div>
      <div style={receiptDiv} />
      <div style={receiptRow}>
        <span style={receiptK}>For</span>
        <span style={receiptV}>tomas.fischer@club37.de</span>
      </div>
    </div>
  )
}

function ExpiresCountdown({
  minutes,
  seconds,
}: {
  minutes: number
  seconds: number
}) {
  const t = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
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
        border: '1px solid var(--ink-600)',
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
        Link expires in
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 18,
          fontWeight: 700,
          color: 'var(--ball-500)',
          letterSpacing: '0.06em',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {t}
      </span>
      <span style={{ flex: 1 }} />
      <ProgressBar pct={97} />
    </div>
  )
}

function RedirectStrip({ dest }: { dest: string }) {
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
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          color: 'var(--fg-2)',
        }}
      >
        {dest}
      </span>
      <span style={{ flex: 1 }} />
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          color: 'var(--fg-3)',
        }}
      >
        2s
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 18,
          color: 'var(--serve-500)',
        }}
      >
        →
      </span>
    </div>
  )
}

function ProgressBar({ pct }: { pct: number }) {
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
          background: 'linear-gradient(90deg, var(--ball-500), var(--ball-400))',
        }}
      />
    </span>
  )
}

function Spinner() {
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: '50%',
        border: '3px solid rgba(255,122,26,0.20)',
        borderTopColor: 'var(--ball-500)',
        borderRightColor: 'var(--ball-500)',
        animation: 'fmm-login-spin 1s linear infinite',
      }}
    />
  )
}

function CheckBadge() {
  return (
    <div
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

const btnPrimary: CSSProperties = {
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
}

const btnGhost: CSSProperties = {
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

const fineprint: CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: 12.5,
  lineHeight: 1.55,
  color: 'var(--fg-3)',
  marginTop: 2,
}

const linkInline: CSSProperties = {
  color: 'var(--ball-500)',
  textDecoration: 'underline',
  textDecorationColor: 'rgba(255,122,26,0.4)',
  textUnderlineOffset: '2px',
  cursor: 'pointer',
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

const logCard: CSSProperties = {
  marginTop: 4,
  background: 'var(--ink-950)',
  border: '1px solid var(--ink-600)',
  borderRadius: 'var(--r-md)',
  padding: 14,
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  color: 'var(--fg-3)',
  lineHeight: 1.7,
}

/* ─── Screens ───────────────────────────────────────────────────────── */

export function ScreenEmail() {
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
          <EmailField defaultValue="" />
          <button style={btnPrimary}>Send the link</button>
          <Divider label="OR" />
          <div style={fineprint}>
            New here? Same flow — we’ll create your account when you confirm.
            <br />
            <span style={{ color: 'var(--fg-muted)' }}>
              By signing in you agree to play fair. That’s it.{' '}
              <a style={linkInline}>House rules</a> ·{' '}
              <a style={linkInline}>Privacy</a>
            </span>
          </div>
        </FormCol>
      }
    />
  )
}

export function ScreenSent() {
  const email = 'tomas.fischer@club37.de'
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
            <>
              A sign-in link is flying toward <span style={mono}>{email}</span>{' '}
              right now. Open it on this device. Expires in 15 — like a real
              rally.
            </>
          }
        >
          <EmailReceipt email={email} />

          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button style={{ ...btnPrimary, flex: 1 }}>Open inbox</button>
            <button style={btnGhost}>Resend</button>
          </div>

          <div style={{ ...fineprint, marginTop: 10 }}>
            No link? Check spam. Or hit resend, we don’t mind.
            <br />
            <span style={{ color: 'var(--fg-muted)' }}>
              Wrong address? <a style={linkInline}>Start over</a>.
            </span>
          </div>

          <ExpiresCountdown minutes={14} seconds={32} />
        </FormCol>
      }
    />
  )
}

export function ScreenVerify() {
  return (
    <Shell
      left={
        <HeroCol
          eyebrow="● Checking the score"
          h1a="Hold up."
          h1b="Reading your link."
        />
      }
      right={
        <FormCol
          stepNo="03"
          stepLabel="Verifying link"
          title="Confirming your sign-in"
          subtitle="Just a sec — confirming you’re you."
        >
          <VerifyCard />
          <SolverLog />
        </FormCol>
      }
    />
  )
}

export function ScreenSuccess() {
  return (
    <Shell
      left={
        <HeroCol
          eyebrow="● You’re in"
          h1a="Welcome back,"
          h1b="Tomás."
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
          <SuccessReceipt />
          <RedirectStrip dest="/dashboard" />
        </FormCol>
      }
    />
  )
}

export function ScreenError() {
  return (
    <Shell
      left={
        <HeroCol
          eyebrow="● Net out"
          h1a="That one missed."
          h1b="Try again."
        />
      }
      right={
        <FormCol
          stepNo="!!"
          stepLabel="Link invalid"
          title="This link can’t be used"
          subtitle="Your link expired or was already used. Links are good for 15 minutes and one tap — strict for a reason. We’ll send a fresh one."
          accent="var(--loss)"
        >
          <ErrorReceipt code="ERR_TOKEN_EXPIRED" />
          <button style={btnPrimary}>Hit me with a new link</button>
          <div style={{ ...fineprint, marginTop: 6 }}>
            Still stuck? <a style={linkInline}>Email support</a> — we read every
            one.
          </div>
        </FormCol>
      }
    />
  )
}

export function ScreenEmailSendFailed() {
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
          <EmailField defaultValue="tomas.fischer@club37.de" state="error" />

          <InlineError
            code="ERR_MAIL_PROVIDER_5XX"
            title="Mail gateway returned 503"
            detail="Postmark · upstream timed out after 8s. Status: degraded."
            statusUrl="status.fortymm.com"
          />

          <div style={{ display: 'flex', gap: 10 }}>
            <button style={{ ...btnPrimary, flex: 1 }}>Try again</button>
            <button style={btnGhost}>Try magic-code instead</button>
          </div>

          <div style={fineprint}>
            We auto-retry in{' '}
            <span
              style={{ color: 'var(--fg-1)', fontFamily: 'var(--font-mono)' }}
            >
              00:14
            </span>
            .
            <br />
            <span style={{ color: 'var(--fg-muted)' }}>
              Still broken in 5 min? <a style={linkInline}>Email support</a> or
              check <a style={linkInline}>status.fortymm.com</a>.
            </span>
          </div>
        </FormCol>
      }
    />
  )
}

export function ScreenSentBounced() {
  const email = 'tomas.fischr@club37.de'
  return (
    <Shell
      left={
        <HeroCol
          eyebrow="● Returned to sender"
          h1a="No mailbox"
          h1b="at that address."
        />
      }
      right={
        <FormCol
          stepNo="02"
          stepLabel="Inbox · bounced"
          title={`Couldn’t deliver to ${email}`}
          subtitle="Their server bounced our email right back. Probably a typo. Try a different address."
          accent="var(--loss)"
        >
          <BounceReceipt email={email} />

          <div style={{ display: 'flex', gap: 10 }}>
            <button style={{ ...btnPrimary, flex: 1 }}>
              Use a different email
            </button>
            <button style={btnGhost}>Retry same address</button>
          </div>

          <div style={fineprint}>
            Did you mean <a style={linkInline}>tomas.fischer@club37.de</a>?
            <br />
            <span style={{ color: 'var(--fg-muted)' }}>
              If your address is right, it might be on a blocklist.{' '}
              <a style={linkInline}>Tell us</a>.
            </span>
          </div>
        </FormCol>
      }
    />
  )
}

export function ScreenVerifyNetError() {
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
          title="Couldn’t reach the auth server"
          subtitle="Couldn’t reach the server. Check your connection — your link is still good for a few more minutes."
          accent="var(--loss)"
        >
          <InlineError
            code="ERR_NETWORK_UNREACHABLE"
            title="auth.fortymm.com is unreachable"
            detail="3 attempts · timed out after 12s. Your device looks online; our edge node may be down."
            statusUrl="status.fortymm.com"
          />

          <FailedSolverLog />

          <div style={{ display: 'flex', gap: 10 }}>
            <button style={{ ...btnPrimary, flex: 1 }}>
              Retry verification
            </button>
            <button style={btnGhost}>Send a new link</button>
          </div>
        </FormCol>
      }
    />
  )
}
