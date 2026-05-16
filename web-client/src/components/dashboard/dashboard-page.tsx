import type { CSSProperties, ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { format, formatDistanceToNowStrict } from 'date-fns'
import {
  ArrowRight,
  Calendar,
  Check,
  ChevronRight,
  Plus,
  Trophy,
  Users,
  X,
} from 'lucide-react'
import { useDashboard } from '@/api/dashboard'
import type {
  DashboardNextMatch,
  DashboardRecentResult,
  DashboardScoreBanner,
} from '@/api/dashboard'
import { scoringNewRoute } from '@/api/matches'
import { useSession } from '@/api/session'

const C = {
  ink950: 'var(--ink-950)',
  ink900: 'var(--ink-900)',
  ink800: 'var(--ink-800)',
  ink700: 'var(--ink-700)',
  ink600: 'var(--ink-600)',
  ink500: 'var(--ink-500)',
  chalk50: 'var(--chalk-50)',
  chalk100: 'var(--chalk-100)',
  chalk300: 'var(--chalk-300)',
  chalk500: 'var(--chalk-500)',
  ball200: 'var(--ball-200)',
  ball400: 'var(--ball-400)',
  ball500: 'var(--ball-500)',
  serve500: 'var(--serve-500)',
  warn: 'var(--warn)',
  loss: 'var(--loss)',
}

const UI = "'Space Grotesk', ui-sans-serif, system-ui, sans-serif"
const MONO = "'JetBrains Mono', ui-monospace, monospace"


function Overline({
  children,
  color = C.chalk300,
  style,
}: {
  children: ReactNode
  color?: string
  style?: CSSProperties
}) {
  return (
    <div
      style={{
        font: `600 10px ${UI}`,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function Mono({
  children,
  size = 14,
  weight = 500,
  color = C.chalk50,
  style,
}: {
  children: ReactNode
  size?: number
  weight?: number
  color?: string
  style?: CSSProperties
}) {
  return (
    <span
      style={{
        font: `${weight} ${size}px ${MONO}`,
        fontVariantNumeric: 'tabular-nums',
        color,
        letterSpacing: '-0.01em',
        ...style,
      }}
    >
      {children}
    </span>
  )
}

type PillTone = 'default' | 'soft' | 'accent' | 'live' | 'warn' | 'win' | 'loss'
const pillTones: Record<PillTone, { bg: string; fg: string; border: string }> = {
  default: { bg: 'transparent', fg: C.chalk300, border: C.ink500 },
  soft: { bg: 'rgba(255,255,255,0.04)', fg: C.chalk100, border: C.ink500 },
  accent: { bg: 'rgba(255,122,26,0.12)', fg: C.ball400, border: 'rgba(255,122,26,0.35)' },
  live: { bg: 'rgba(0,226,154,0.12)', fg: C.serve500, border: 'rgba(0,226,154,0.3)' },
  warn: { bg: 'rgba(255,196,61,0.12)', fg: C.warn, border: 'rgba(255,196,61,0.3)' },
  win: { bg: 'rgba(0,226,154,0.12)', fg: C.serve500, border: 'transparent' },
  loss: { bg: 'rgba(255,77,109,0.12)', fg: C.loss, border: 'transparent' },
}

function Pill({
  children,
  tone = 'default',
  mono = false,
  style,
}: {
  children: ReactNode
  tone?: PillTone
  mono?: boolean
  style?: CSSProperties
}) {
  const t = pillTones[tone]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 9px',
        borderRadius: 999,
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.border}`,
        font: `${mono ? 500 : 600} 11px ${mono ? MONO : UI}`,
        letterSpacing: mono ? '0.04em' : '0.08em',
        textTransform: mono ? 'none' : 'uppercase',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  )
}

function BallDot({
  live = false,
  color = C.ball500,
  size = 8,
}: {
  live?: boolean
  color?: string
  size?: number
}) {
  const isGreen = color === C.serve500
  const glow = isGreen ? 'rgba(0,226,154,0.65)' : 'rgba(255,122,26,0.55)'
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        boxShadow: `0 0 ${size + 2}px ${glow}`,
        animation: live ? 'ball-pulse 1.4s ease-in-out infinite' : 'none',
        flexShrink: 0,
      }}
    />
  )
}

function Avatar({
  name,
  size = 40,
  ring = false,
  ringColor = C.ball500,
}: {
  name: string
  size?: number
  ring?: boolean
  ringColor?: string
}) {
  const initials = name
    .split(/[ -]/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  let hue = 0
  for (let i = 0; i < name.length; i++) hue = (hue * 31 + name.charCodeAt(i)) % 360
  const bg = `hsl(${hue}, 28%, 28%)`
  const fg = `hsl(${hue}, 60%, 78%)`
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: bg,
        color: fg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        font: `600 ${Math.round(size * 0.42)}px ${UI}`,
        letterSpacing: '0.03em',
        boxShadow: ring
          ? `0 0 0 2px ${C.ink950}, 0 0 0 ${size > 40 ? 3 : 2.5}px ${ringColor}`
          : 'none',
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  )
}

function Sparkline({
  data,
  w = 280,
  h = 48,
  color = C.ball500,
}: {
  data: number[]
  w?: number
  h?: number
  color?: string
}) {
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const pad = 2
  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2)
    const y = h - pad - ((v - min) / range) * (h - pad * 2)
    return [x, y] as const
  })
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(' ')
  const last = points[points.length - 1]
  const areaPath = `${path} L${last[0]} ${h} L${pad} ${h} Z`
  const gradId = `dash-spark-${color.replace(/[^a-z0-9]/gi, '')}`
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r="2.6" fill={color} />
      <circle cx={last[0]} cy={last[1]} r="5" fill={color} opacity="0.25" />
    </svg>
  )
}

type ButtonKind = 'primary' | 'secondary' | 'ghost'
type ButtonSize = 'sm' | 'md' | 'lg'

const buttonSizes = {
  sm: { h: 32, px: 12, font: 13 },
  md: { h: 40, px: 16, font: 14 },
  lg: { h: 52, px: 24, font: 16 },
}

const buttonKinds: Record<ButtonKind, CSSProperties> = {
  primary: {
    background: C.ball500,
    color: C.ink950,
    border: '1px solid transparent',
    boxShadow:
      '0 4px 14px rgba(255,122,26,0.35), inset 0 1px 0 rgba(255,255,255,0.18)',
  },
  secondary: {
    background: 'transparent',
    color: C.chalk100,
    border: `1px solid ${C.ink500}`,
  },
  ghost: {
    background: 'transparent',
    color: C.chalk300,
    border: '1px solid transparent',
  },
}

type ButtonProps = {
  children: ReactNode
  kind?: ButtonKind
  size?: ButtonSize
  iconLeft?: ReactNode
  iconRight?: ReactNode
  fullWidth?: boolean
  style?: CSSProperties
  /** When set, renders a TanStack Router Link with the same styling instead of a <button>. */
  to?: string
}

function Button({
  children,
  kind = 'primary',
  size = 'md',
  iconLeft,
  iconRight,
  fullWidth = false,
  style,
  to,
}: ButtonProps) {
  const s = buttonSizes[size]
  const composed: CSSProperties = {
    height: s.h,
    padding: `0 ${s.px}px`,
    borderRadius: 8,
    font: `600 ${s.font}px ${UI}`,
    letterSpacing: '0.005em',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    width: fullWidth ? '100%' : 'auto',
    textDecoration: 'none',
    ...buttonKinds[kind],
    ...style,
  }
  const body = (
    <>
      {iconLeft}
      <span>{children}</span>
      {iconRight}
    </>
  )
  if (to) {
    return (
      <Link to={to} style={composed}>
        {body}
      </Link>
    )
  }
  return (
    <button type="button" style={composed}>
      {body}
    </button>
  )
}

function Card({
  children,
  padding = 20,
  style,
}: {
  children: ReactNode
  padding?: number | string
  style?: CSSProperties
}) {
  return (
    <div
      style={{
        background: C.ink800,
        border: `1px solid ${C.ink600}`,
        borderRadius: 10,
        padding,
        position: 'relative',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function SectionHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 14, gap: 12 }}>
      <h2
        style={{
          margin: 0,
          font: `600 18px ${UI}`,
          color: C.chalk50,
          letterSpacing: '-0.005em',
        }}
      >
        {title}
      </h2>
      {subtitle && (
        <span style={{ font: `400 13px ${UI}`, color: C.chalk500 }}>{subtitle}</span>
      )}
      <div style={{ flex: 1 }} />
      {action && (
        <a
          href="#"
          style={{
            font: `500 13px ${UI}`,
            color: C.chalk300,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {action}
          <ChevronRight size={12} strokeWidth={1.75} />
        </a>
      )}
    </div>
  )
}


function SkeletonCard({
  label,
  height,
}: {
  label: string
  height: number
}) {
  return (
    <div
      role="status"
      aria-busy
      aria-label={label}
      style={{
        background: C.ink800,
        border: `1px solid ${C.ink600}`,
        borderRadius: 10,
        minHeight: height,
      }}
    />
  )
}

function EmptyCard({ overline, body }: { overline: string; body: string }) {
  return (
    <Card>
      <Overline color={C.chalk500}>{overline}</Overline>
      <div
        style={{
          marginTop: 10,
          font: `400 13px ${UI}`,
          color: C.chalk300,
        }}
      >
        {body}
      </div>
    </Card>
  )
}

function PageTitle({
  greeting,
  subtitle,
}: {
  greeting: string
  subtitle: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', marginBottom: 24, gap: 16 }}>
      <div>
        <Overline color={C.chalk500} style={{ marginBottom: 8 }}>
          Dashboard · Tuesday, April 22
        </Overline>
        <h1
          style={{
            margin: 0,
            font: `700 32px ${UI}`,
            letterSpacing: '-0.015em',
            color: C.chalk50,
            lineHeight: 1.05,
          }}
        >
          {greeting}
          <span style={{ color: C.ball500 }}>.</span>
        </h1>
        <div style={{ marginTop: 6, font: `400 14px ${UI}`, color: C.chalk300 }}>
          {subtitle}
        </div>
      </div>
      <div style={{ flex: 1 }} />
      <Button
        kind="secondary"
        size="md"
        iconLeft={<Plus size={16} strokeWidth={1.75} />}
        to="/matches/new"
      >
        Log a match
      </Button>
    </div>
  )
}


function PaddleBadge({ accent }: { accent: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: -4,
        right: -6,
        width: 26,
        height: 26,
        borderRadius: '50%',
        background: C.ink900,
        border: `1.5px solid ${accent}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
        <circle
          cx="10"
          cy="10"
          r="7"
          fill="none"
          stroke={accent}
          strokeWidth="1.75"
        />
        <path
          d="M14.5 14.5L20 20"
          fill="none"
          stroke={accent}
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    </div>
  )
}

function ScoreBanner({ banner }: { banner: DashboardScoreBanner }) {
  const accent = C.ball500
  const opponent = banner.opponent_username ?? 'guest'
  const scoringRoute = scoringNewRoute(banner.match_id, banner.current_game_id)
  return (
    <div
      data-testid="dashboard-score-banner"
      className="banner-glow"
      style={{
        position: 'relative',
        background: `linear-gradient(180deg, rgba(255,122,26,0.10) 0%, rgba(11,13,18,0) 100%), ${C.ink800}`,
        border: '1px solid rgba(255,122,26,0.42)',
        borderRadius: 14,
        overflow: 'hidden',
        marginBottom: 32,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: `linear-gradient(90deg, ${accent} 0%, ${accent} 60%, transparent 100%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          backgroundImage:
            'radial-gradient(circle at center, rgba(255,122,26,0.09) 1.2px, transparent 1.8px)',
          backgroundSize: '40px 40px',
          maskImage: 'linear-gradient(180deg, rgba(0,0,0,0.7), transparent)',
          WebkitMaskImage: 'linear-gradient(180deg, rgba(0,0,0,0.7), transparent)',
        }}
      />

      <div style={{ position: 'relative', padding: '22px 26px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 14,
            flexWrap: 'wrap',
          }}
        >
          <BallDot live size={9} />
          <span
            style={{
              font: `700 11px ${MONO}`,
              letterSpacing: '0.18em',
              color: accent,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            SCORE NEEDED
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              flex: '1 1 360px',
              minWidth: 0,
            }}
          >
            <div style={{ position: 'relative' }}>
              <Avatar name={opponent} size={64} ring ringColor={accent} />
              <PaddleBadge accent={accent} />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <h1
                style={{
                  margin: 0,
                  font: `700 28px ${UI}`,
                  letterSpacing: '-0.01em',
                  color: C.chalk50,
                  lineHeight: 1.1,
                }}
              >
                vs {opponent}
              </h1>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 8,
              flex: '0 0 auto',
            }}
          >
            <Link
              {...scoringRoute}
              style={{
                height: 44,
                padding: '0 22px',
                borderRadius: 8,
                font: `600 15px ${UI}`,
                letterSpacing: '0.005em',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                textDecoration: 'none',
                minWidth: 220,
                background: C.ball500,
                color: C.ink950,
                border: '1px solid transparent',
                boxShadow:
                  '0 4px 14px rgba(255,122,26,0.35), inset 0 1px 0 rgba(255,255,255,0.18)',
              }}
            >
              <span>Enter final score</span>
              <ArrowRight size={18} strokeWidth={1.75} />
            </Link>
          </div>
        </div>
      </div>

      <button
        type="button"
        aria-label="Dismiss"
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          width: 28,
          height: 28,
          background: 'transparent',
          border: 'none',
          color: C.chalk500,
          cursor: 'pointer',
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}


type Deadline = { name: string; detail: string; closes: string; urgent?: boolean }

function NextMatchCard({ match }: { match: DashboardNextMatch }) {
  const opponent = match.opponent_username ?? 'guest'
  return (
    <Card
      padding={0}
      style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
    >
      <div
        data-testid="dashboard-next-match"
        style={{
          padding: '14px 18px 0',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <Overline color={C.chalk500}>Your next match</Overline>
        <div style={{ flex: 1 }} />
        <Pill mono tone="soft">
          Best of {match.best_of}
        </Pill>
      </div>
      <div
        style={{
          padding: '14px 18px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <Avatar name="You" size={44} />
        <div
          style={{
            font: `400 18px var(--font-display)`,
            color: C.ball500,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          VS
        </div>
        <Avatar name={opponent} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{ font: `600 16px ${UI}`, color: C.chalk50, lineHeight: 1.2 }}
          >
            {opponent}
          </div>
          <div
            style={{ font: `400 13px ${UI}`, color: C.chalk300, marginTop: 2 }}
          >
            Created {formatDistanceToNowStrict(new Date(match.created_at), {
              addSuffix: true,
            })}
          </div>
        </div>
      </div>
      <div
        style={{
          background: C.ink900,
          borderTop: `1px solid ${C.ink600}`,
          padding: '12px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <div style={{ flex: 1 }} />
        <Link
          to="/matches/$matchId"
          params={{ matchId: match.match_id }}
          style={{
            height: 32,
            padding: '0 14px',
            borderRadius: 8,
            font: `600 13px ${UI}`,
            letterSpacing: '0.005em',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            textDecoration: 'none',
            background: 'transparent',
            color: C.chalk100,
            border: `1px solid ${C.ink500}`,
          }}
        >
          <span>View match</span>
          <ChevronRight size={14} strokeWidth={1.75} />
        </Link>
      </div>
    </Card>
  )
}

function CheckinCard({
  event,
  closesIn,
}: {
  event: string
  closesIn: string
}) {
  return (
    <Card
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        borderColor: 'rgba(255,196,61,0.32)',
        background: `linear-gradient(180deg, rgba(255,196,61,0.06) 0%, transparent 60%), ${C.ink800}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <BallDot live color={C.warn} />
        <Overline color={C.warn}>Check in · closes {closesIn}</Overline>
      </div>
      <div style={{ font: `600 16px ${UI}`, color: C.chalk50, lineHeight: 1.25 }}>
        {event}
      </div>
      <div style={{ font: `400 13px ${UI}`, color: C.chalk300 }}>
        Confirm you're at the venue so the draw can start on time.
      </div>
      <div style={{ flex: 1 }} />
      <Button
        kind="secondary"
        size="md"
        iconRight={<Check size={16} strokeWidth={1.75} />}
        style={{ borderColor: 'rgba(255,196,61,0.4)', color: C.warn }}
      >
        Check in now
      </Button>
    </Card>
  )
}

function DeadlineStack({ deadlines }: { deadlines: Deadline[] }) {
  return (
    <Card padding={0} style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '14px 18px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Calendar size={14} color={C.chalk500} strokeWidth={1.75} />
        <Overline color={C.chalk500}>Watching</Overline>
        <div style={{ flex: 1 }} />
        <span style={{ font: `500 11px ${UI}`, color: C.chalk500 }}>
          {deadlines.length}
        </span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {deadlines.map((d, i) => (
          <div
            key={d.name}
            style={{
              padding: '10px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              borderTop: i === 0 ? 'none' : `1px solid ${C.ink700}`,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  font: `500 13px ${UI}`,
                  color: C.chalk50,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {d.name}
              </div>
              <div
                style={{ font: `400 11px ${UI}`, color: C.chalk500, marginTop: 1 }}
              >
                {d.detail}
              </div>
            </div>
            <Mono size={11} color={d.urgent ? C.warn : C.chalk300}>
              {d.closes}
            </Mono>
          </div>
        ))}
      </div>
    </Card>
  )
}

function UpNextRow({
  match,
  isLoading,
  checkin,
  deadlines,
}: {
  match: DashboardNextMatch | null
  isLoading: boolean
  checkin: { event: string; closesIn: string }
  deadlines: Deadline[]
}) {
  return (
    <section style={{ marginBottom: 36 }}>
      <SectionHeader
        title="Up next"
        subtitle="Matches, check-ins, deadlines"
        action="Full schedule"
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr 1fr',
          gap: 14,
        }}
      >
        {isLoading ? (
          <SkeletonCard label="Loading next match" height={160} />
        ) : match ? (
          <NextMatchCard match={match} />
        ) : (
          <EmptyCard
            overline="Your next match"
            body="No upcoming match yet."
          />
        )}
        <CheckinCard event={checkin.event} closesIn={checkin.closesIn} />
        <DeadlineStack deadlines={deadlines} />
      </div>
    </section>
  )
}



function Stat({
  label,
  value,
}: {
  label: string
  value: number | string
}) {
  return (
    <div
      style={{
        padding: '10px 12px',
        background: C.ink900,
        borderRadius: 8,
        border: `1px solid ${C.ink700}`,
      }}
    >
      <Overline color={C.chalk500} style={{ fontSize: 9 }}>
        {label}
      </Overline>
      <Mono size={16} weight={700} style={{ marginTop: 3, display: 'block' }}>
        {value}
      </Mono>
    </div>
  )
}

function RatingCard({
  current,
  delta,
  rd,
  vol,
  peak,
  percentile,
  sparkData,
  streak,
}: {
  current: number
  delta: number
  rd: number
  vol: number
  peak: number
  percentile: number
  sparkData: number[]
  streak: { kind: 'W' | 'L'; n: number }
}) {
  return (
    <Card padding={20} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Overline color={C.chalk500}>Current rating</Overline>
        <div style={{ flex: 1 }} />
        <Pill tone={streak.kind === 'W' ? 'win' : 'loss'} mono>
          {streak.kind}
          {streak.n}
        </Pill>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <Mono size={56} weight={700} color={C.chalk50} style={{ lineHeight: 0.9 }}>
          {current}
        </Mono>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Pill tone={delta >= 0 ? 'win' : 'loss'} mono>
            {delta >= 0 ? '+' : ''}
            {delta} last match
          </Pill>
          <span style={{ font: `400 11px ${UI}`, color: C.chalk500 }}>
            Top{' '}
            <Mono size={11} color={C.chalk300}>
              {percentile}%
            </Mono>{' '}
            in your club
          </span>
        </div>
      </div>
      <div
        style={{
          padding: '10px 12px',
          background: C.ink900,
          borderRadius: 8,
          border: `1px solid ${C.ink700}`,
        }}
      >
        <Sparkline data={sparkData} w={280} h={48} />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 6,
            font: `400 10px ${MONO}`,
            color: C.chalk500,
            letterSpacing: '0.08em',
          }}
        >
          <span>30 days ago</span>
          <span>Today · peak {peak}</span>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <Stat label="RD" value={rd} />
        <Stat label="Volatility" value={vol.toFixed(3)} />
        <Stat label="Peak" value={peak} />
      </div>
    </Card>
  )
}

function RecentResultsCard({ rows }: { rows: DashboardRecentResult[] }) {
  const wins = rows.filter((r) => r.is_win).length
  return (
    <Card padding={0}>
      <div
        data-testid="dashboard-recent-results"
        style={{
          padding: '14px 18px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: `1px solid ${C.ink700}`,
        }}
      >
        <Overline color={C.chalk500}>Recent matches</Overline>
        <div style={{ flex: 1 }} />
        <span style={{ font: `500 11px ${UI}`, color: C.chalk500 }}>
          <Mono size={11} color={C.chalk100}>
            {wins}-{rows.length - wins}
          </Mono>{' '}
          · last {rows.length}
        </span>
      </div>
      {rows.length === 0 ? (
        <div
          style={{
            padding: '20px 18px',
            font: `400 13px ${UI}`,
            color: C.chalk300,
          }}
        >
          No completed matches yet.
        </div>
      ) : (
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            font: `400 13px ${UI}`,
            color: C.chalk100,
          }}
        >
          <thead>
            <tr
              style={{
                font: `600 10px ${UI}`,
                color: C.chalk500,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
              }}
            >
              <th style={{ textAlign: 'left', padding: '10px 18px 8px', fontWeight: 600 }}>
                Opponent
              </th>
              <th style={{ textAlign: 'right', padding: '10px 8px 8px', fontWeight: 600 }}>
                Score
              </th>
              <th style={{ textAlign: 'right', padding: '10px 18px 8px', fontWeight: 600 }}>
                When
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const opponent = r.opponent_username ?? 'guest'
              const score = `${r.my_games_won}-${r.opponent_games_won}`
              return (
                <tr
                  key={r.match_id}
                  style={{ borderTop: i === 0 ? 'none' : `1px solid ${C.ink700}` }}
                >
                  <td style={{ padding: '11px 18px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: r.is_win ? C.serve500 : C.loss,
                          boxShadow: `0 0 6px ${r.is_win ? 'rgba(0,226,154,0.5)' : 'rgba(255,77,109,0.5)'}`,
                        }}
                      />
                      <Avatar name={opponent} size={24} />
                      <span
                        style={{
                          color: C.chalk50,
                          fontWeight: 500,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {opponent}
                      </span>
                    </div>
                  </td>
                  <td style={{ padding: '11px 8px', textAlign: 'right' }}>
                    <Mono size={13} weight={500} color={r.is_win ? C.serve500 : C.loss}>
                      {score}
                    </Mono>
                  </td>
                  <td style={{ padding: '11px 18px', textAlign: 'right' }}>
                    <Mono size={11} color={C.chalk500}>
                      {format(new Date(r.completed_at), 'MMM d')}
                    </Mono>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function YourGameRow({
  rating,
  recent,
  isLoading,
  streak,
}: {
  rating: {
    current: number
    delta: number
    rd: number
    vol: number
    peak: number
    percentile: number
    sparkData: number[]
  }
  recent: DashboardRecentResult[]
  isLoading: boolean
  streak: { kind: 'W' | 'L'; n: number }
}) {
  return (
    <section style={{ marginBottom: 36 }}>
      <SectionHeader
        title="Your game"
        subtitle="Glicko-2 · last 30 days"
        action="Full history"
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.15fr 1.85fr',
          gap: 14,
        }}
      >
        <RatingCard {...rating} streak={streak} />
        {isLoading ? (
          <SkeletonCard label="Loading recent matches" height={260} />
        ) : (
          <RecentResultsCard rows={recent} />
        )}
      </div>
    </section>
  )
}


type ClubActivity = { who: string; verb: string; target: string; when: string; live?: boolean }
type Tournament = {
  day: string
  month: string
  name: string
  location: string
  format: string
  range: string
  featured?: boolean
}
type Suggestion = { name: string; rating: number; club: string; mutual: number; myRating: number }

function ClubActivityCard({
  name,
  ladderPos,
  ladderTotal,
  activity,
}: {
  name: string
  ladderPos: number
  ladderTotal: number
  activity: ClubActivity[]
}) {
  return (
    <Card padding={0}>
      <div
        style={{
          padding: '14px 18px',
          borderBottom: `1px solid ${C.ink700}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: C.ink900,
            border: `1px solid ${C.ink600}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Users size={16} color={C.chalk300} strokeWidth={1.75} />
        </div>
        <div>
          <div style={{ font: `600 13px ${UI}`, color: C.chalk50 }}>{name}</div>
          <div style={{ font: `400 11px ${UI}`, color: C.chalk500 }}>
            Ladder · #
            <Mono size={11} color={C.chalk100}>
              {ladderPos}
            </Mono>{' '}
            of{' '}
            <Mono size={11} color={C.chalk300}>
              {ladderTotal}
            </Mono>
          </div>
        </div>
      </div>
      <div style={{ padding: '4px 0' }}>
        {activity.map((a) => (
          <div
            key={`${a.who}-${a.when}`}
            style={{
              padding: '8px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              font: `400 12px ${UI}`,
              color: C.chalk300,
            }}
          >
            <BallDot color={a.live ? C.serve500 : C.ball500} live={a.live} size={5} />
            <span style={{ color: C.chalk100, fontWeight: 500 }}>{a.who}</span>
            <span style={{ color: C.chalk500 }}>{a.verb}</span>
            <span style={{ color: C.chalk100, fontWeight: 500 }}>{a.target}</span>
            <div style={{ flex: 1 }} />
            <Mono size={11} color={C.chalk500}>
              {a.when}
            </Mono>
          </div>
        ))}
      </div>
    </Card>
  )
}

function TournamentDiscoveryCard({ tournaments }: { tournaments: Tournament[] }) {
  return (
    <Card padding={0}>
      <div
        style={{
          padding: '14px 18px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: `1px solid ${C.ink700}`,
        }}
      >
        <Trophy size={14} color={C.chalk500} strokeWidth={1.75} />
        <Overline color={C.chalk500}>Tournaments for you</Overline>
        <div style={{ flex: 1 }} />
        <span style={{ font: `400 11px ${UI}`, color: C.chalk500 }}>
          By rating · location
        </span>
      </div>
      {tournaments.map((t, i) => (
        <div
          key={t.name}
          style={{
            padding: '12px 18px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            borderTop: i === 0 ? 'none' : `1px solid ${C.ink700}`,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 8,
              background: t.featured ? 'rgba(255,122,26,0.12)' : C.ink900,
              border: `1px solid ${t.featured ? 'rgba(255,122,26,0.35)' : C.ink600}`,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Mono
              size={16}
              weight={700}
              color={t.featured ? C.ball500 : C.chalk50}
              style={{ lineHeight: 1 }}
            >
              {t.day}
            </Mono>
            <span
              style={{
                font: `600 9px ${UI}`,
                color: t.featured ? C.ball400 : C.chalk500,
                letterSpacing: '0.1em',
                marginTop: 1,
              }}
            >
              {t.month}
            </span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 2,
              }}
            >
              <span style={{ font: `600 13px ${UI}`, color: C.chalk50 }}>{t.name}</span>
              {t.featured && (
                <Pill tone="accent" mono>
                  FIT
                </Pill>
              )}
            </div>
            <div style={{ font: `400 11px ${UI}`, color: C.chalk500 }}>
              {t.location} · {t.format} ·{' '}
              <Mono size={11} color={C.chalk300}>
                {t.range}
              </Mono>
            </div>
          </div>
          <Button
            kind="ghost"
            size="sm"
            iconRight={<ChevronRight size={14} strokeWidth={1.75} />}
            style={{ padding: '0 6px', color: C.chalk300 }}
          >
            Register
          </Button>
        </div>
      ))}
    </Card>
  )
}

function PlayerSuggestionCard({ name, rating, club, mutual, myRating }: Suggestion) {
  const diff = Math.abs(rating - myRating)
  return (
    <Card padding={18} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Overline color={C.chalk500}>Closely matched</Overline>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Avatar name={name} size={48} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: `600 14px ${UI}`, color: C.chalk50 }}>{name}</div>
          <div style={{ font: `400 12px ${UI}`, color: C.chalk500 }}>
            <Mono size={12} color={C.chalk300}>
              {rating}
            </Mono>{' '}
            · {club}
          </div>
        </div>
      </div>
      <div
        style={{
          font: `400 12px ${UI}`,
          color: C.chalk300,
          padding: '10px 12px',
          background: C.ink900,
          borderRadius: 8,
          lineHeight: 1.45,
          border: `1px solid ${C.ink700}`,
        }}
      >
        {diff < 20 ? `Within ${diff} pts of you. ` : ''}
        Plays Tuesday evenings ·{' '}
        <Mono size={11} color={C.chalk100}>
          {mutual}
        </Mono>{' '}
        mutual opponents.
      </div>
      <Button
        kind="secondary"
        size="sm"
        iconRight={<ArrowRight size={14} strokeWidth={1.75} />}
        fullWidth
      >
        Challenge to a match
      </Button>
    </Card>
  )
}

function AroundYouRow({
  club,
  tournaments,
  suggestion,
}: {
  club: {
    name: string
    ladderPos: number
    ladderTotal: number
    activity: ClubActivity[]
  }
  tournaments: Tournament[]
  suggestion: Suggestion
}) {
  return (
    <section style={{ marginBottom: 24 }}>
      <SectionHeader title="Around you" subtitle="Your club, your radius" action="Explore" />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.1fr 1.3fr 1fr',
          gap: 14,
        }}
      >
        <ClubActivityCard {...club} />
        <TournamentDiscoveryCard tournaments={tournaments} />
        <PlayerSuggestionCard {...suggestion} />
      </div>
    </section>
  )
}


const DATA = {
  checkin: { event: 'April Spring Open', closesIn: 'in 18m' },
  deadlines: [
    {
      name: 'Westside Spring Cup',
      detail: 'Singles · Open draw',
      closes: 'closes Fri',
      urgent: true,
    },
    { name: 'Bay Area Open', detail: 'Singles · 1700–2100', closes: 'June 1' },
    { name: 'Coastal Smash', detail: 'Doubles · need partner', closes: 'June 14' },
  ] satisfies Deadline[],
  rating: {
    current: 1847,
    delta: 12,
    rd: 63,
    vol: 0.058,
    peak: 1862,
    percentile: 88,
    sparkData: [
      1801, 1795, 1788, 1812, 1808, 1820, 1815, 1827, 1834, 1828, 1842, 1835, 1847,
    ],
  },
  streak: { kind: 'W' as const, n: 2 },
  club: {
    name: 'Westside TTC',
    ladderPos: 4,
    ladderTotal: 42,
    activity: [
      { who: 'Priya R.', verb: 'beat', target: 'Tom W.', when: '4m' },
      { who: 'Devon M.', verb: 'is playing', target: 'Jin H.', when: 'now', live: true },
      { who: 'Aimee C.', verb: 'climbed to', target: '#4', when: '1h' },
      { who: 'Lin S.', verb: 'beat', target: 'Marco B.', when: '3h' },
    ] satisfies ClubActivity[],
  },
  tournaments: [
    {
      day: '24',
      month: 'MAY',
      name: 'Westside Spring Cup',
      location: '2.1 mi',
      format: 'Singles · DE',
      range: '1700–2000',
      featured: true,
    },
    {
      day: '07',
      month: 'JUN',
      name: 'Bay Area Open',
      location: '14 mi',
      format: 'Singles · RR+DE',
      range: '1600–2100',
    },
    {
      day: '22',
      month: 'JUN',
      name: 'Coastal Smash',
      location: '31 mi',
      format: 'Doubles · DE',
      range: 'Open',
    },
  ] satisfies Tournament[],
  suggestion: {
    name: 'Priya Raman',
    rating: 1839,
    club: 'Westside TTC',
    mutual: 4,
    myRating: 1847,
  } satisfies Suggestion,
}


export function DashboardPage() {
  // /v1/dashboard requires an established session; wait for /v1/session
  // (which mints one) to resolve before firing the dashboard query.
  const session = useSession()
  const dashboard = useDashboard({ enabled: session.isSuccess })
  const isLoading = !session.isSuccess || dashboard.isPending
  const data = dashboard.data
  return (
    <div
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '28px 32px 40px',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <PageTitle greeting="Hi, Aimee" subtitle="3 things need your attention" />
      {isLoading ? (
        <SkeletonCard label="Loading score banner" height={140} />
      ) : data?.score_banner ? (
        <ScoreBanner banner={data.score_banner} />
      ) : null}
      <UpNextRow
        match={data?.next_match ?? null}
        isLoading={isLoading}
        checkin={DATA.checkin}
        deadlines={DATA.deadlines}
      />
      <YourGameRow
        rating={DATA.rating}
        recent={data?.recent_results ?? []}
        isLoading={isLoading}
        streak={DATA.streak}
      />
      <AroundYouRow
        club={DATA.club}
        tournaments={DATA.tournaments}
        suggestion={DATA.suggestion}
      />
    </div>
  )
}
