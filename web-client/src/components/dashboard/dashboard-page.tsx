import { useMemo } from 'react'
import type { ComponentProps, CSSProperties, ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight, Plus } from 'lucide-react'
import { useDashboard } from '@/api/dashboard'
import { UserAvatar } from '@/components/ui/user-avatar'
import { Card as UICard } from '@/components/ui/card'
import type { DashboardRating, DashboardRecentResult } from '@/api/dashboard'
import { deriveEmailStatus, useSession } from '@/api/session'
import { Overline } from '@/components/overline'
import { AttentionPanel } from '@/components/dashboard/attention-panel'
import { projectAttentionPanelView } from '@/components/dashboard/attention-panel-view'
import { GuestPersistBanner } from '@/components/dashboard/guest-persist-banner'
import { fmtDateShort, fmtLongDate } from '@/lib/dates'
import { formatRatingDelta } from '@/lib/rating'
import { useMediaQuery } from '@/lib/use-media-query'

// Below this viewport width the page title drops its inline action button to its
// own line and gutters tighten. Sits below the app-shell's 960px sidebar-drawer
// breakpoint so tablet-width layouts keep the roomy chrome.
const COMPACT_QUERY = '(max-width: 640px)'

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

function Sparkline({
  data,
  w = 280,
  h = 48,
  color = C.ball500,
  fluid = false,
}: {
  data: number[]
  w?: number
  h?: number
  color?: string
  /**
   * Fill the container width instead of rendering at the fixed `w`. Stretches
   * the SVG with `preserveAspectRatio="none"`, so the trend line's geometry
   * scales horizontally — fine for a sparkline (there's no canonical aspect),
   * and the line *weight* stays uniform via `vector-effect="non-scaling-stroke"`.
   * The end-point dot is drawn as an HTML overlay (below) rather than an SVG
   * `<circle>` precisely so it stays round instead of stretching into an ellipse.
   */
  fluid?: boolean
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
  // Position the end-point dot as a fraction of the box; since the overlay is a
  // sibling of the (possibly stretched) SVG, percentages keep it pinned to the
  // last data point regardless of the horizontal scale, while a fixed pixel
  // size keeps it circular.
  const dotLeft = `${(last[0] / w) * 100}%`
  const dotTop = `${(last[1] / h) * 100}%`
  return (
    <div
      style={{
        position: 'relative',
        width: fluid ? '100%' : w,
        height: h,
        lineHeight: 0,
      }}
    >
      <svg
        width="100%"
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        // Stretch to fill when fluid; at fixed width the 1:1 mapping is undistorted.
        preserveAspectRatio={fluid ? 'none' : 'xMidYMid meet'}
        style={{ display: 'block', overflow: 'visible' }}
      >
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
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: dotLeft,
          top: dotTop,
          width: 10,
          height: 10,
          marginLeft: -5,
          marginTop: -5,
          borderRadius: '50%',
          background: color,
          opacity: 0.25,
          pointerEvents: 'none',
        }}
      />
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: dotLeft,
          top: dotTop,
          width: 5.2,
          height: 5.2,
          marginLeft: -2.6,
          marginTop: -2.6,
          borderRadius: '50%',
          background: color,
          pointerEvents: 'none',
        }}
      />
    </div>
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

// The shared design-system Card (`@/components/ui/card`). `display: 'block'`
// neutralizes the shadcn Card's default flex/gap so callers keep full control of
// their inner layout (e.g. RatingCard re-enables flex via its own style;
// RecentResultsCard stays block).
function Card({
  children,
  padding = 20,
  style,
  className,
  ...rest
}: {
  children: ReactNode
  padding?: number | string
} & Omit<ComponentProps<'div'>, 'children'>) {
  return (
    <UICard
      className={className}
      style={{
        display: 'block',
        padding,
        position: 'relative',
        ...style,
      }}
      {...rest}
    >
      {children}
    </UICard>
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
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        marginBottom: 14,
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
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
        minWidth: 0,
      }}
    />
  )
}

function EmptyCard({ overline, body }: { overline: string; body: string }) {
  return (
    <Card style={{ minWidth: 0 }}>
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
  compact,
}: {
  greeting: string
  subtitle?: string
  compact: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: compact ? 'column' : 'row',
        alignItems: compact ? 'stretch' : 'flex-end',
        marginBottom: 24,
        gap: 16,
      }}
    >
      <div>
        <Overline style={{ marginBottom: 8 }}>
          Dashboard · {fmtLongDate()}
        </Overline>
        <h1
          style={{
            margin: 0,
            font: `700 ${compact ? 26 : 32}px ${UI}`,
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
      {!compact && <div style={{ flex: 1 }} />}
      <Button
        kind="secondary"
        size="md"
        iconLeft={<Plus size={16} strokeWidth={1.75} />}
        fullWidth={compact}
        to="/matches/new"
      >
        Log a match
      </Button>
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

function RatingCard({
  rating,
}: {
  rating: DashboardRating
}) {
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
    <Card
      padding={20}
      // minWidth:0 lets the card shrink to its grid track instead of forcing the
      // track wider than its `fr` share (grid items default to min-width:auto).
      style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}
    >
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
      {/* flexWrap so the delta/percentile column drops below the big number
          rather than overflowing (and being clipped) in a narrow card. */}
      <div
        style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', rowGap: 8 }}
      >
        <Mono size={56} weight={700} color={C.chalk50} style={{ lineHeight: 0.9 }}>
          {Math.round(current)}
        </Mono>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
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
        <Sparkline data={sparkPoints} w={280} h={48} fluid />
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
      {/* auto-fit so the tiles reflow to 2 (or 1) columns when the card is too
          narrow for three, instead of overflowing the fixed 3-up grid. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))',
          gap: 8,
        }}
      >
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
    <Card padding={0} style={{ minWidth: 0 }}>
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
                      <UserAvatar name={opponent} size={24} />
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
  // The grid stacks vs. splits off the row's *container* width via a CSS
  // container query (see `.your-game-grid` in index.css), not the viewport: the
  // dashboard sits in the app-shell's content column beside a 256px sidebar, so
  // just past the 960px sidebar breakpoint this column is only ~700px — too
  // narrow for two columns. `container-type: inline-size` makes this <section>
  // the query container.
  return (
    <section style={{ marginBottom: 36, containerType: 'inline-size' }}>
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
      <div className="your-game-grid">
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
  const compact = useMediaQuery(COMPACT_QUERY)
  const dashboard = useDashboard({ enabled: session.isSuccess })
  const isLoading = dashboard.isPending
  const data = dashboard.data
  const user = session.data?.data.user
  const username = user?.username
  const greeting = username ? `Hi, @${username}` : 'Hi'
  // Guest with at least one completed match — "you have things to lose now".
  // Zero-match guests and verified/pending-verification users never see this.
  const isGuest =
    user !== undefined &&
    deriveEmailStatus({
      email: user.email ?? null,
      confirmedAt: user.confirmed_at ?? null,
      pendingEmail: user.pending_email ?? null,
    }) === 'guest'
  const showGuestPersistBanner = isGuest && (data?.completed_match_count ?? 0) >= 1
  const attentionView = useMemo(
    () =>
      projectAttentionPanelView(
        data?.attention ?? [],
        data?.waiting_count ?? 0,
        data?.attention_total_count ?? 0,
      ),
    [data?.attention, data?.waiting_count, data?.attention_total_count],
  )
  return (
    <div
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: compact ? '20px 16px 32px' : '28px 32px 40px',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      {showGuestPersistBanner && data && (
        <GuestPersistBanner
          matchCount={data.completed_match_count}
          rating={data.rating ? Math.round(data.rating.current) : null}
        />
      )}
      <PageTitle greeting={greeting} compact={compact} />
      {isLoading ? (
        <div style={{ marginBottom: 32 }}>
          <SkeletonCard label="Loading attention panel" height={160} />
        </div>
      ) : (
        <AttentionPanel
          view={attentionView}
        />
      )}
      <YourGameRow
        rating={data?.rating ?? null}
        recent={data?.recent_results ?? []}
        isLoading={isLoading}
        username={username}
      />
    </div>
  )
}
