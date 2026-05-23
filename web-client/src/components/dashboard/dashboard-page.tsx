import type { CSSProperties, ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight, ChevronRight, Plus, User as UserIcon, X } from 'lucide-react'
import { useDashboard } from '@/api/dashboard'
import type {
  DashboardRating,
  DashboardRecentResult,
  DashboardScoreBanner,
} from '@/api/dashboard'
import { scoringNewRoute } from '@/api/matches'
import { useSession } from '@/api/session'
import { Overline } from '@/components/overline'
import { fmtDateShort, fmtLongDate } from '@/lib/dates'
import { formatRatingDelta } from '@/lib/rating'

// Used everywhere an opponent slot has no registered player — the form's
// solo-match path produces this. Matches the label used on the match-details
// hero and form-history rows so the same match reads identically wherever it
// surfaces.
const NO_OPPONENT_LABEL = 'No opponent'

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
  // `null` renders the dashed-circle "no opponent" placeholder. We never want
  // a contrived monogram (e.g. "NO" for "No opponent") that looks like a real
  // initials avatar — it should read unambiguously as "no player here".
  name: string | null
  size?: number
  ring?: boolean
  ringColor?: string
}) {
  const baseStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: ring
      ? `0 0 0 2px ${C.ink950}, 0 0 0 ${size > 40 ? 3 : 2.5}px ${ringColor}`
      : 'none',
    flexShrink: 0,
  }

  if (name === null) {
    return (
      <div
        aria-hidden="true"
        style={{
          ...baseStyle,
          background: 'transparent',
          border: `1px dashed ${C.ink500}`,
          color: C.chalk500,
        }}
      >
        <UserIcon size={Math.round(size * 0.45)} strokeWidth={1.75} />
      </div>
    )
  }

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
        ...baseStyle,
        background: bg,
        color: fg,
        font: `600 ${Math.round(size * 0.42)}px ${UI}`,
        letterSpacing: '0.03em',
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
  params?: Record<string, string>
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
  params,
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
      <Link to={to} params={params} style={composed}>
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
  actionTo,
  actionSearch,
}: {
  title: string
  subtitle?: string
  action?: string
  actionTo?: string
  actionSearch?: Record<string, string | undefined>
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
      {action && actionTo && (
        <Link
          to={actionTo}
          search={actionSearch}
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
        </Link>
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
      <Overline>{overline}</Overline>
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
  subtitle?: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', marginBottom: 24, gap: 16 }}>
      <div>
        <Overline style={{ marginBottom: 8 }}>
          Dashboard · {fmtLongDate()}
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
        {subtitle && (
          <div style={{ marginTop: 6, font: `400 14px ${UI}`, color: C.chalk300 }}>
            {subtitle}
          </div>
        )}
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

function ScoreBanner({ banner }: { banner: DashboardScoreBanner }) {
  const accent = C.ball500
  const opponent = banner.opponent_username
  const headline = opponent ? `vs ${opponent}` : NO_OPPONENT_LABEL
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
            <Avatar name={opponent} size={64} ring ringColor={accent} />
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
                {headline}
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
            <Button
              kind="primary"
              size="lg"
              iconRight={<ArrowRight size={18} strokeWidth={1.75} />}
              style={{ minWidth: 220 }}
              {...scoringRoute}
            >
              Enter final score
            </Button>
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

// Used when a player has more than one match waiting for their score. The
// primary ScoreBanner above keeps the single hero-orange CTA; this strip
// uses an amber accent so a second pending match is impossible to miss
// without dimming the priority of the headline match.
function CompactScoreBanner({ banner }: { banner: DashboardScoreBanner }) {
  const opponent = banner.opponent_username
  const headline = opponent ? `vs ${opponent}` : NO_OPPONENT_LABEL
  const scoringRoute = scoringNewRoute(banner.match_id, banner.current_game_id)
  return (
    <div
      data-testid="dashboard-score-banner-compact"
      style={{
        position: 'relative',
        background: `linear-gradient(180deg, rgba(255,196,61,0.06) 0%, rgba(11,13,18,0) 100%), ${C.ink800}`,
        border: '1px solid rgba(255,196,61,0.24)',
        borderRadius: 12,
        padding: '14px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: `linear-gradient(90deg, ${C.warn} 0%, ${C.warn} 50%, transparent 100%)`,
        }}
      />
      <BallDot live color={C.warn} size={8} />
      <Avatar name={opponent} size={36} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            font: `700 10px ${MONO}`,
            color: C.warn,
            letterSpacing: '0.16em',
            marginBottom: 2,
          }}
        >
          ALSO PENDING
        </div>
        <div
          style={{
            font: `600 15px ${UI}`,
            color: C.chalk50,
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {headline}
        </div>
      </div>
      <Button
        kind="secondary"
        size="md"
        iconRight={<ArrowRight size={14} strokeWidth={1.75} />}
        style={{ borderColor: 'rgba(255,196,61,0.4)', color: C.warn }}
        {...scoringRoute}
      >
        Enter score
      </Button>
    </div>
  )
}

// 3+ pending: a single quiet link that funnels the rest into /matches,
// pre-filtered to the current user's live (in-progress) matches so the
// destination opens straight on the same pile the pill is summarizing.
function MorePendingLink({
  count,
  username,
}: {
  count: number
  username?: string
}) {
  return (
    <Link
      to="/matches"
      search={{ q: username, status: 'live' }}
      data-testid="dashboard-score-banner-more"
      style={{
        display: 'inline-flex',
        alignSelf: 'flex-start',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 999,
        border: `1px solid ${C.ink500}`,
        background: 'transparent',
        font: `500 12px ${UI}`,
        color: C.chalk300,
        textDecoration: 'none',
      }}
    >
      <Mono size={12} weight={600} color={C.chalk100}>
        +{count}
      </Mono>
      more pending
      <ChevronRight size={14} strokeWidth={1.75} />
    </Link>
  )
}

function ScoreBannerStack({
  banners,
  username,
}: {
  banners: DashboardScoreBanner[]
  username?: string
}) {
  if (banners.length === 0) return null
  const [primary, secondary, ...rest] = banners
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        marginBottom: 32,
      }}
    >
      <ScoreBanner banner={primary} />
      {secondary && <CompactScoreBanner banner={secondary} />}
      {rest.length > 0 && (
        <MorePendingLink count={rest.length} username={username} />
      )}
    </div>
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
      <Overline style={{ fontSize: 9 }}>
        {label}
      </Overline>
      <Mono size={16} weight={700} style={{ marginTop: 3, display: 'block' }}>
        {value}
      </Mono>
    </div>
  )
}

function RatingCard({ rating }: { rating: DashboardRating }) {
  const { current, delta, peak, percentile, spark_data, streak, stats } = rating
  // Sparkline needs ≥2 points to draw a line; pad a single point so the
  // freshly-rated case still shows a level baseline.
  const sparkPoints =
    spark_data.length >= 2
      ? spark_data
      : [spark_data[0] ?? current, spark_data[0] ?? current]
  // Peak tile + whatever strategy-specific stats the API returned; capped at
  // three because the grid is 3 columns.
  const tiles = [
    { label: 'Peak', value: String(Math.round(peak)) },
    ...stats,
  ].slice(0, 3)
  return (
    <Card padding={20} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Overline>Current rating</Overline>
        <div style={{ flex: 1 }} />
        {streak ? (
          <Pill tone={streak.kind === 'W' ? 'win' : 'loss'} mono>
            {streak.kind}
            {streak.n}
          </Pill>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <Mono size={56} weight={700} color={C.chalk50} style={{ lineHeight: 0.9 }}>
          {Math.round(current)}
        </Mono>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Pill tone={delta >= 0 ? 'win' : 'loss'} mono>
            {formatRatingDelta(delta)} last match
          </Pill>
          {percentile !== null ? (
            <span style={{ font: `400 11px ${UI}`, color: C.chalk500 }}>
              Top{' '}
              <Mono size={11} color={C.chalk300}>
                {percentile}%
              </Mono>{' '}
              in {rating.league_name}
            </span>
          ) : (
            <span style={{ font: `400 11px ${UI}`, color: C.chalk500 }}>
              {rating.league_name}
            </span>
          )}
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
        <Sparkline data={sparkPoints} w={280} h={48} />
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
          <span>Today · peak {Math.round(peak)}</span>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {tiles.map((tile) => (
          <Stat key={tile.label} label={tile.label} value={tile.value} />
        ))}
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
        <Overline>Recent matches</Overline>
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
              <th style={{ textAlign: 'right', padding: '10px 8px 8px', fontWeight: 600 }}>
                Δ
              </th>
              <th style={{ textAlign: 'right', padding: '10px 18px 8px', fontWeight: 600 }}>
                When
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const opponent = r.opponent_username
              const opponentLabel = opponent ?? NO_OPPONENT_LABEL
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
                          color: opponent ? C.chalk50 : C.chalk500,
                          fontStyle: opponent ? 'normal' : 'italic',
                          fontWeight: 500,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {opponentLabel}
                      </span>
                    </div>
                  </td>
                  <td style={{ padding: '11px 8px', textAlign: 'right' }}>
                    <Mono size={13} weight={500} color={r.is_win ? C.serve500 : C.loss}>
                      {score}
                    </Mono>
                  </td>
                  <td style={{ padding: '11px 8px', textAlign: 'right' }}>
                    {r.my_rating_change ? (
                      <Mono
                        size={12}
                        weight={500}
                        color={
                          r.my_rating_change.delta >= 0
                            ? C.serve500
                            : C.loss
                        }
                      >
                        {formatRatingDelta(r.my_rating_change.delta)}
                      </Mono>
                    ) : (
                      <Mono size={12} color={C.chalk500}>
                        —
                      </Mono>
                    )}
                  </td>
                  <td style={{ padding: '11px 18px', textAlign: 'right' }}>
                    <Mono size={11} color={C.chalk500}>
                      {fmtDateShort(r.completed_at)}
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
  username,
}: {
  rating: DashboardRating | null
  recent: DashboardRecentResult[]
  isLoading: boolean
  username?: string
}) {
  return (
    <section style={{ marginBottom: 36 }}>
      <SectionHeader
        title="Your game"
        subtitle={
          rating
            ? `${ratingStrategyLabel(rating.strategy_key)} · last 30 days`
            : 'Last 30 days'
        }
        action="Full history"
        actionTo="/matches"
        actionSearch={{ q: username }}
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.15fr 1.85fr',
          gap: 14,
        }}
      >
        {isLoading ? (
          <SkeletonCard label="Loading rating" height={260} />
        ) : rating ? (
          <RatingCard rating={rating} />
        ) : (
          <EmptyCard
            overline="Current rating"
            body="Not in a rated league yet."
          />
        )}
        {isLoading ? (
          <SkeletonCard label="Loading recent matches" height={260} />
        ) : (
          <RecentResultsCard rows={recent} />
        )}
      </div>
    </section>
  )
}

function ratingStrategyLabel(key: string): string {
  if (key === 'glicko2') return 'Glicko-2'
  if (key === 'manual') return 'Manual'
  return key
}

export function DashboardPage() {
  const session = useSession()
  const dashboard = useDashboard({ enabled: session.isSuccess })
  const isLoading = dashboard.isPending
  const data = dashboard.data
  const username = session.data?.data.user.username
  const greeting = username ? `Hi, @${username}` : 'Hi'
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
      <PageTitle greeting={greeting} />
      {isLoading ? (
        <SkeletonCard label="Loading score banner" height={140} />
      ) : data?.score_banners?.length ? (
        <ScoreBannerStack banners={data.score_banners} username={username} />
      ) : null}
      <YourGameRow
        rating={data?.rating ?? null}
        recent={data?.recent_results ?? []}
        isLoading={isLoading}
        username={username}
      />
    </div>
  )
}
