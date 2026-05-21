/* =====================================================================
   schedule.tsx — Schedule + simulator screen
   ===================================================================== */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  Dice5,
  Eraser,
  FastForward,
  LayoutGrid,
  Loader2,
  Lock,
  RotateCcw,
  SkipForward,
  Users,
} from 'lucide-react'
import {
  colorForMatch,
  eventColor,
  fmtClock,
  initials,
  minutesBetween,
  type ClockMode,
  type ColorBy,
  type Config,
  type Match,
  type Schedule,
  type TournamentEvent,
} from './data'

export type Density = 'comfortable' | 'compact' | 'tight'

export interface Tweaks {
  density: Density
  colorBy: ColorBy
  clockMode: ClockMode
  showIdle: boolean
  animateMoves: boolean
}

export interface SimState {
  completions: { matchId: string; start: number; end: number; tableId: string }[]
  nowMin: number
}

interface HoverInfo {
  match: Match
  event: TournamentEvent | undefined
  color: string
  x: number
  y: number
}

// ---------- Axis helpers ----------
function pickTickStep(pxPerMin: number): number {
  const choices = [5, 10, 15, 20, 30, 60, 90, 120]
  for (const c of choices) {
    if (c * pxPerMin >= 80) return c
  }
  return 120
}

function abbrevPlayer(config: Config, pid: string): string {
  const p = config.players.find((pp) => pp.id === pid)
  if (!p) return '?'
  const parts = p.name.split(/\s+/)
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0]}.`
}

function densityMinorPx(density: Density): number {
  return density === 'tight' ? 4 : density === 'compact' ? 6 : 8
}

// ---------- Gantt (tables on Y) ----------
function GanttChart({
  config,
  schedule,
  sim,
  density,
  colorBy,
  animateMoves,
  clockMode,
  onSelectMatch,
  selectedMatchId,
  onHover,
}: {
  config: Config
  schedule: Schedule
  sim: SimState
  density: Density
  colorBy: ColorBy
  animateMoves: boolean
  clockMode: ClockMode
  onSelectMatch: (id: string) => void
  selectedMatchId: string | null
  onHover: (h: HoverInfo | null) => void
}) {
  const minorPx = densityMinorPx(density)
  const dayEnd = minutesBetween(config.startISO, config.endISO)
  const pxPerMin = minorPx
  const rowH = density === 'tight' ? 32 : density === 'compact' ? 36 : 44
  const trackW = dayEnd * pxPerMin
  const tickStep = pickTickStep(pxPerMin)

  const tables = config.tables
  const matchesByTable = useMemo(() => {
    const m: Record<string, Match[]> = {}
    tables.forEach((t) => {
      m[t.id] = []
    })
    schedule.matches.forEach((mm) => {
      if (m[mm.tableId]) m[mm.tableId].push(mm)
    })
    return m
  }, [tables, schedule])

  return (
    <div
      className="tl"
      style={
        {
          '--minor-px': `${minorPx}px`,
          '--row-h': `${rowH}px`,
          minWidth: 140 + trackW + 16,
        } as React.CSSProperties
      }
    >
      <div className="tl-grid" style={{ gridTemplateColumns: `140px ${trackW}px` }}>
        <div className="tl-row-label head">Table</div>
        <div className="tl-axis">
          <div className="tl-axis-track" style={{ width: trackW }}>
            {Array.from({ length: Math.floor(dayEnd / tickStep) + 1 }).map((_, i) => {
              const min = i * tickStep
              return (
                <div key={i} className="tl-axis-tick major" style={{ left: min * pxPerMin }}>
                  {fmtClock(min, clockMode)}
                </div>
              )
            })}
          </div>
        </div>

        {tables.map((t, ri) => (
          <Fragment key={t.id}>
            <div
              className="tl-row-label"
              style={{ height: rowH, borderBottom: '1px solid var(--ink-800)' }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 4,
                  background: 'var(--ink-800)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--fg-2)',
                }}
              >
                {ri + 1}
              </span>
              <span>{t.name}</span>
            </div>
            <div className={`tl-row ${ri % 2 ? 'alt' : ''}`} style={{ position: 'relative' }}>
              {config.tablePools
                .filter((p) => p.tableIds.includes(t.id))
                .map((p) => (
                  <div
                    key={p.id}
                    className="tl-pool"
                    style={{ left: p.startMin * pxPerMin, width: (p.endMin - p.startMin) * pxPerMin }}
                  ></div>
                ))}
              {(matchesByTable[t.id] || []).map((m) => {
                const ev = config.events.find((e) => e.id === m.eventId)
                const c = colorForMatch(m, config, colorBy)
                const start = m.completed ? (m.actualStart ?? 0) : m.plannedStart
                const end = m.completed ? (m.actualEnd ?? 0) : m.plannedEnd
                const w = (end - start) * pxPerMin
                const narrow = w < 60
                const tiny = w < 36
                return (
                  <div
                    key={m.id}
                    className={
                      'match ' +
                      (m.completed ? 'completed ' : '') +
                      (selectedMatchId === m.id ? 'selected ' : '') +
                      (narrow ? 'narrow ' : '') +
                      (tiny ? 'tiny ' : '') +
                      (animateMoves ? 'animated ' : '')
                    }
                    style={
                      { left: start * pxPerMin, width: Math.max(8, w - 2), '--c': c } as React.CSSProperties
                    }
                    onClick={() => onSelectMatch(m.id)}
                    onMouseEnter={(e) => onHover({ match: m, event: ev, color: c, x: e.clientX, y: e.clientY })}
                    onMouseMove={(e) => onHover({ match: m, event: ev, color: c, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => onHover(null)}
                  >
                    {m.completed && (
                      <>
                        <div className="match-tag" style={{ background: c }}></div>
                        <Lock className="lock" />
                      </>
                    )}
                    {!tiny && (
                      <div className="match-players">
                        {abbrevPlayer(config, m.p1)} <span style={{ opacity: 0.6 }}>vs</span>{' '}
                        {abbrevPlayer(config, m.p2)}
                      </div>
                    )}
                    {!narrow && (
                      <div className="match-meta">
                        {ev?.name?.slice(0, 16)} ·{' '}
                        {m.completed ? (m.actualEnd ?? 0) - (m.actualStart ?? 0) : m.plannedDurationMin}m
                      </div>
                    )}
                  </div>
                )
              })}
              {sim.nowMin > 0 && <div className="tl-now" style={{ left: sim.nowMin * pxPerMin }}></div>}
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

// ---------- Player timeline (players on Y, idle gaps highlighted) ----------
function PlayerTimeline({
  config,
  schedule,
  sim,
  density,
  colorBy,
  animateMoves,
  clockMode,
  showIdle,
  onSelectMatch,
  selectedMatchId,
  onHover,
}: {
  config: Config
  schedule: Schedule
  sim: SimState
  density: Density
  colorBy: ColorBy
  animateMoves: boolean
  clockMode: ClockMode
  showIdle: boolean
  onSelectMatch: (id: string) => void
  selectedMatchId: string | null
  onHover: (h: HoverInfo | null) => void
}) {
  const minorPx = densityMinorPx(density)
  const dayEnd = minutesBetween(config.startISO, config.endISO)
  const pxPerMin = minorPx
  const rowH = density === 'tight' ? 28 : density === 'compact' ? 32 : 38
  const trackW = dayEnd * pxPerMin
  const tickStep = pickTickStep(pxPerMin)

  const activePlayerIds = useMemo(() => {
    const s = new Set<string>()
    config.events.forEach((e) => e.playerIds.forEach((id) => s.add(id)))
    return Array.from(s)
  }, [config.events])

  const playerData = useMemo(() => {
    const out: Record<string, { matches: Match[]; idle: [number, number][] }> = {}
    activePlayerIds.forEach((id) => {
      out[id] = { matches: [], idle: [] }
    })
    schedule.matches.forEach((m) => {
      ;[m.p1, m.p2].forEach((pid) => {
        if (out[pid]) out[pid].matches.push(m)
      })
    })
    Object.values(out).forEach((d) => {
      d.matches.sort((a, b) => a.plannedStart - b.plannedStart)
      let prev: number | null = null
      for (const m of d.matches) {
        const s = m.completed ? (m.actualStart ?? 0) : m.plannedStart
        if (prev != null && s - prev > 5) d.idle.push([prev, s])
        prev = m.completed ? (m.actualEnd ?? 0) : m.plannedEnd
      }
    })
    return out
  }, [activePlayerIds, schedule])

  const sortedPlayers = useMemo(() => {
    return activePlayerIds
      .map((id) => {
        const d = playerData[id]
        const total = d.matches.reduce(
          (s, m) => s + (m.completed ? (m.actualEnd ?? 0) - (m.actualStart ?? 0) : m.plannedDurationMin),
          0,
        )
        const idleTotal = d.idle.reduce((s, [a, b]) => s + (b - a), 0)
        return { id, total, idleTotal }
      })
      .sort((a, b) => b.total - a.total)
  }, [activePlayerIds, playerData])

  return (
    <div
      className="tl"
      style={
        {
          '--minor-px': `${minorPx}px`,
          '--row-h': `${rowH}px`,
          minWidth: 200 + trackW + 16,
        } as React.CSSProperties
      }
    >
      <div className="tl-grid" style={{ gridTemplateColumns: `200px ${trackW}px` }}>
        <div className="tl-row-label head">
          Player <span style={{ flex: 1 }}></span>
          <span style={{ color: 'var(--fg-3)', textTransform: 'uppercase', fontSize: 10 }}>idle</span>
        </div>
        <div className="tl-axis">
          <div className="tl-axis-track" style={{ width: trackW }}>
            {Array.from({ length: Math.floor(dayEnd / tickStep) + 1 }).map((_, i) => {
              const min = i * tickStep
              return (
                <div key={i} className="tl-axis-tick major" style={{ left: min * pxPerMin }}>
                  {fmtClock(min, clockMode)}
                </div>
              )
            })}
          </div>
        </div>

        {sortedPlayers.map(({ id, idleTotal }, ri) => {
          const p = config.players.find((pp) => pp.id === id)
          if (!p) return null
          const d = playerData[id]
          return (
            <Fragment key={id}>
              <div className="tl-row-label" style={{ height: rowH }}>
                <span
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 999,
                    background: 'var(--ink-800)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--fg-2)',
                  }}
                >
                  {initials(p.name)}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--fg-1)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {p.name}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
                    {p.rating ?? '—'}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    color: idleTotal > 90 ? 'var(--warn)' : 'var(--fg-3)',
                  }}
                >
                  {idleTotal}
                </span>
              </div>
              <div className={`tl-row ${ri % 2 ? 'alt' : ''}`} style={{ position: 'relative' }}>
                {showIdle &&
                  d.idle.map(([s, e], i) => (
                    <div
                      key={i}
                      className="idle-block"
                      style={{ left: s * pxPerMin, width: (e - s) * pxPerMin }}
                    ></div>
                  ))}
                {d.matches.map((m) => {
                  const ev = config.events.find((e) => e.id === m.eventId)
                  const c = colorForMatch(m, config, colorBy)
                  const start = m.completed ? (m.actualStart ?? 0) : m.plannedStart
                  const end = m.completed ? (m.actualEnd ?? 0) : m.plannedEnd
                  const w = (end - start) * pxPerMin
                  const narrow = w < 60
                  const tiny = w < 36
                  const otherId = m.p1 === id ? m.p2 : m.p1
                  return (
                    <div
                      key={m.id}
                      className={
                        'match ' +
                        (m.completed ? 'completed ' : '') +
                        (selectedMatchId === m.id ? 'selected ' : '') +
                        (narrow ? 'narrow ' : '') +
                        (tiny ? 'tiny ' : '') +
                        (animateMoves ? 'animated ' : '')
                      }
                      style={
                        { left: start * pxPerMin, width: Math.max(8, w - 2), '--c': c } as React.CSSProperties
                      }
                      onClick={() => onSelectMatch(m.id)}
                      onMouseEnter={(e) => onHover({ match: m, event: ev, color: c, x: e.clientX, y: e.clientY })}
                      onMouseMove={(e) => onHover({ match: m, event: ev, color: c, x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => onHover(null)}
                    >
                      {m.completed && (
                        <>
                          <div className="match-tag" style={{ background: c }}></div>
                          <Lock className="lock" />
                        </>
                      )}
                      {!tiny && <div className="match-players">vs {abbrevPlayer(config, otherId)}</div>}
                      {!narrow && (
                        <div className="match-meta">
                          T{config.tables.findIndex((t) => t.id === m.tableId) + 1} ·{' '}
                          {m.completed ? (m.actualEnd ?? 0) - (m.actualStart ?? 0) : m.plannedDurationMin}m
                        </div>
                      )}
                    </div>
                  )
                })}
                {sim.nowMin > 0 && <div className="tl-now" style={{ left: sim.nowMin * pxPerMin }}></div>}
              </div>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

// ---------- Hover tooltip ----------
function MatchTip({ hover, config }: { hover: HoverInfo | null; config: Config }) {
  if (!hover) return null
  const { match: m, event: ev, color, x, y } = hover
  const p1 = config.players.find((p) => p.id === m.p1)
  const p2 = config.players.find((p) => p.id === m.p2)
  const tbl = config.tables.find((t) => t.id === m.tableId)
  const start = m.completed ? (m.actualStart ?? 0) : m.plannedStart
  const end = m.completed ? (m.actualEnd ?? 0) : m.plannedEnd
  const W = 260,
    H = 160
  let left = x + 14
  let top = y + 14
  if (left + W > window.innerWidth - 10) left = x - W - 14
  if (top + H > window.innerHeight - 10) top = y - H - 14
  return (
    <div className="match-tip" style={{ left, top, minWidth: W }}>
      <div className="heading">
        <span className="dot" style={{ background: color }}></span>
        <span className="ev">{ev?.name || '—'}</span>
        {m.completed && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              color: 'var(--fg-3)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            ✓ COMPLETED
          </span>
        )}
      </div>
      <div className="players">
        <span>{p1?.name}</span>
        <span className="v">vs</span>
        <span>{p2?.name}</span>
      </div>
      <div className="rows">
        <span className="k">Table</span>
        <span className="v">{tbl?.name}</span>
        <span className="k">Start</span>
        <span className="v">
          {fmtClock(start, '24h')} <span style={{ color: 'var(--fg-3)' }}>+{start}m</span>
        </span>
        <span className="k">End</span>
        <span className="v">
          {fmtClock(end, '24h')} <span style={{ color: 'var(--fg-3)' }}>+{end}m</span>
        </span>
        <span className="k">Duration</span>
        <span className="v">{end - start} min</span>
      </div>
    </div>
  )
}

// ---------- Simulator panel ----------
function SimPanel({
  config,
  schedule,
  sim,
  durations,
  setDurations,
  onAdvance,
  onAdvanceAll,
  onResetSim,
  onResetDurations,
  autoAdvancing,
  selectedMatchId,
  onSelectMatch,
  lastResolveMs,
}: {
  config: Config
  schedule: Schedule
  sim: SimState
  durations: Record<string, number>
  setDurations: (d: Record<string, number>) => void
  onAdvance: () => void
  onAdvanceAll: () => void
  onResetSim: () => void
  onResetDurations: () => void
  autoAdvancing: boolean
  selectedMatchId: string | null
  onSelectMatch: (id: string) => void
  lastResolveMs: number | null
}) {
  const totalExpected = schedule?.matches.length || 0
  const completedIds = new Set(sim.completions.map((c) => c.matchId))
  const completed = schedule.matches.filter((m) => completedIds.has(m.id))
  const pending = schedule.matches
    .filter((m) => !completedIds.has(m.id))
    .sort((a, b) => a.plannedStart - b.plannedStart)

  completed.sort((a, b) => (b.actualEnd || 0) - (a.actualEnd || 0))

  const onBulkPerturb = () => {
    const next = { ...durations }
    pending.forEach((m) => {
      const ev = config.events.find((e) => e.id === m.eventId)!
      const planned = ev.matchDurationMin
      const delta = Math.round((Math.random() * 20 - 10) / 5) * 5
      next[m.id] = Math.max(5, planned + delta)
    })
    setDurations(next)
  }

  const nextToComplete = useMemo(() => {
    let best: Match | null = null,
      bestT = Infinity
    pending.forEach((m) => {
      const ev = config.events.find((e) => e.id === m.eventId)!
      const dur = durations[m.id] ?? ev.matchDurationMin
      const t = m.plannedStart + dur
      if (t < bestT) {
        bestT = t
        best = m
      }
    })
    return best as Match | null
  }, [pending, durations, config])

  return (
    <div className="sim">
      <div className="sim-header">
        <h3>● Simulator</h3>
        <div className="progress">
          {completed.length}/{totalExpected}
        </div>
      </div>
      <div className="sim-controls">
        <button
          className="btn primary full"
          onClick={onAdvance}
          disabled={pending.length === 0 || autoAdvancing}
        >
          {autoAdvancing ? (
            <>
              <Loader2 size={14} className="spin" /> Re-solving…
            </>
          ) : pending.length === 0 ? (
            <>
              <Check size={14} /> All matches complete
            </>
          ) : (
            <>
              <SkipForward size={14} /> Advance
            </>
          )}
        </button>
        <button className="btn" onClick={onAdvanceAll} disabled={pending.length === 0 || autoAdvancing}>
          <FastForward size={14} /> To end
        </button>
        <button
          className="btn ghost"
          onClick={onBulkPerturb}
          disabled={pending.length === 0}
          title="Apply random ±10 min to all pending matches"
        >
          <Dice5 size={14} /> ± perturb
        </button>
        <button
          className="btn ghost full"
          onClick={onResetSim}
          disabled={sim.completions.length === 0}
          title="Clear completions and re-solve from scratch (keeps duration edits)"
        >
          <RotateCcw size={14} /> Reset simulation
        </button>
        <button
          className="btn ghost full"
          onClick={onResetDurations}
          disabled={Object.keys(durations).length === 0}
          title="Clear actual-duration overrides"
        >
          <Eraser size={14} /> Reset durations to planned
        </button>
      </div>

      <div className="sim-list">
        {pending.length > 0 && nextToComplete && (
          <>
            <div className="sim-section-head">
              <ChevronRight size={12} style={{ color: 'var(--ball-500)' }} />
              Next to complete
            </div>
            {(() => {
              const m = nextToComplete
              const ev = config.events.find((e) => e.id === m.eventId)!
              const dur = durations[m.id] ?? ev.matchDurationMin
              const evIdx = config.events.findIndex((e) => e.id === m.eventId)
              const c = eventColor(evIdx)
              const finishesAt = m.plannedStart + dur
              return (
                <div
                  className={`sim-row ${selectedMatchId === m.id ? 'selected' : ''}`}
                  onClick={() => onSelectMatch(m.id)}
                >
                  <div className="colorbar" style={{ '--c': c } as React.CSSProperties}></div>
                  <div className="info">
                    <div className="players">
                      {abbrevPlayer(config, m.p1)} vs {abbrevPlayer(config, m.p2)}
                    </div>
                    <div className="meta">
                      T{config.tables.findIndex((t) => t.id === m.tableId) + 1}
                      {' · '}starts {fmtClock(m.plannedStart, '24h')}
                      {' · '}done {fmtClock(finishesAt, '24h')}
                    </div>
                  </div>
                  <div className="dur" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="number"
                      className={dur !== ev.matchDurationMin ? 'changed' : ''}
                      value={dur}
                      step={5}
                      min={5}
                      onChange={(e) => {
                        const v = Math.max(5, parseInt(e.target.value || '0', 10) || ev.matchDurationMin)
                        setDurations({ ...durations, [m.id]: v })
                      }}
                    />
                    <span className="unit">m</span>
                  </div>
                </div>
              )
            })()}
          </>
        )}

        <div className="sim-section-head">
          <span>Pending</span>
          <span className="count">{pending.length}</span>
          <div className="grow"></div>
          <span style={{ fontSize: 10, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>DURATION</span>
        </div>
        {pending.length === 0 && (
          <div style={{ padding: '12px 16px', color: 'var(--fg-3)', fontSize: 12 }}>
            No pending matches. Reset to replay.
          </div>
        )}
        {pending.slice(nextToComplete ? 1 : 0).map((m) => {
          const ev = config.events.find((e) => e.id === m.eventId)!
          const evIdx = config.events.findIndex((e) => e.id === m.eventId)
          const c = eventColor(evIdx)
          const dur = durations[m.id] ?? ev.matchDurationMin
          const changed = dur !== ev.matchDurationMin
          return (
            <div
              key={m.id}
              className={`sim-row ${selectedMatchId === m.id ? 'selected' : ''}`}
              onClick={() => onSelectMatch(m.id)}
            >
              <div className="colorbar" style={{ '--c': c } as React.CSSProperties}></div>
              <div className="info">
                <div className="players">
                  {abbrevPlayer(config, m.p1)} vs {abbrevPlayer(config, m.p2)}
                </div>
                <div className="meta">
                  T{config.tables.findIndex((t) => t.id === m.tableId) + 1} · {fmtClock(m.plannedStart, '24h')}
                </div>
              </div>
              <div className="dur" onClick={(e) => e.stopPropagation()}>
                <input
                  type="number"
                  className={changed ? 'changed' : ''}
                  value={dur}
                  step={5}
                  min={5}
                  onChange={(e) => {
                    const v = Math.max(5, parseInt(e.target.value || '0', 10) || ev.matchDurationMin)
                    setDurations({ ...durations, [m.id]: v })
                  }}
                />
                <span className="unit">m</span>
              </div>
            </div>
          )
        })}

        {completed.length > 0 && (
          <>
            <div className="sim-section-head">
              <span>Completed</span>
              <span className="count">{completed.length}</span>
              <div className="grow"></div>
              <span style={{ fontSize: 10, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>ACTUAL</span>
            </div>
            {completed.map((m) => {
              const ev = config.events.find((e) => e.id === m.eventId)!
              const evIdx = config.events.findIndex((e) => e.id === m.eventId)
              const c = eventColor(evIdx)
              const actual = (m.actualEnd ?? 0) - (m.actualStart ?? 0)
              return (
                <div
                  key={m.id}
                  className={`sim-row completed ${selectedMatchId === m.id ? 'selected' : ''}`}
                  onClick={() => onSelectMatch(m.id)}
                >
                  <div className="colorbar" style={{ '--c': c, opacity: 0.5 } as React.CSSProperties}></div>
                  <div className="info">
                    <div className="players">
                      <Lock
                        size={10}
                        style={{ color: 'var(--fg-3)', marginRight: 4, verticalAlign: 'middle' }}
                      />
                      {abbrevPlayer(config, m.p1)} vs {abbrevPlayer(config, m.p2)}
                    </div>
                    <div className="meta">
                      T{config.tables.findIndex((t) => t.id === m.tableId) + 1} ·{' '}
                      {fmtClock(m.actualStart ?? 0, '24h')}–{fmtClock(m.actualEnd ?? 0, '24h')}
                    </div>
                  </div>
                  <div className="dur">
                    <span className="actual">{actual}m</span>
                    {actual !== ev.matchDurationMin && (
                      <span
                        style={{
                          fontSize: 10,
                          fontFamily: 'var(--font-mono)',
                          color: actual > ev.matchDurationMin ? 'var(--loss)' : 'var(--serve-500)',
                        }}
                      >
                        {actual > ev.matchDurationMin ? '+' : ''}
                        {actual - ev.matchDurationMin}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>

      <div className="sim-footer">
        <span>
          Last resolve{' '}
          <span className="mono" style={{ color: 'var(--fg-2)', fontFamily: 'var(--font-mono)' }}>
            {lastResolveMs || '—'}ms
          </span>
        </span>
        <div className="grow"></div>
        <span>
          <span className="kbd">↵</span> advance
        </span>
      </div>
    </div>
  )
}

// ---------- ScheduleView ----------
export function ScheduleView({
  config,
  schedule,
  sim,
  durations,
  setDurations,
  onAdvance,
  onAdvanceAll,
  onResetSim,
  onResetDurations,
  autoAdvancing,
  tweaks,
  lastResolveMs,
}: {
  config: Config
  schedule: Schedule
  sim: SimState
  durations: Record<string, number>
  setDurations: (d: Record<string, number>) => void
  onAdvance: () => void
  onAdvanceAll: () => void
  onResetSim: () => void
  onResetDurations: () => void
  autoAdvancing: boolean
  tweaks: Tweaks
  lastResolveMs: number | null
}) {
  const [view, setView] = useState<'players' | 'gantt'>('players')
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const vizRef = useRef<HTMLDivElement>(null)

  const status = schedule?.status || '—'
  const animateMoves = tweaks.animateMoves !== false

  useLayoutEffect(() => {
    if (!selectedMatchId || !vizRef.current) return
    const el = vizRef.current.querySelector('.match.selected')
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [selectedMatchId, view])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'Enter') {
        e.preventDefault()
        onAdvance()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onAdvance])

  return (
    <div className="schedule">
      <div className="solve-strip">
        <div className="stat-cell" style={{ minWidth: 110 }}>
          <span className="label">Status</span>
          <div>
            <span className={`pill ${status.toLowerCase()}`}>
              {status === 'OPTIMAL' ? '● OPTIMAL' : status === 'FEASIBLE' ? '○ FEASIBLE' : '✕ INFEASIBLE'}
            </span>
          </div>
        </div>
        <div className="stat-cell">
          <span className="label">Solve</span>
          <span className="value">
            {schedule.solveTimeMs}
            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>ms</span>
          </span>
        </div>
        <div className="stat-cell">
          <span className="label">Makespan</span>
          <span className="value">
            {schedule.makespanMin}
            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>m</span>
          </span>
        </div>
        <div className="stat-cell">
          <span className="label">Idle (Σ)</span>
          <span className="value">
            {schedule.totalIdleMin}
            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>m</span>
          </span>
        </div>
        <div className="stat-cell">
          <span className="label">Matches</span>
          <span className="value">
            <span style={{ color: 'var(--serve-500)' }}>{sim.completions.length}</span>
            <span style={{ color: 'var(--fg-3)' }}>/{schedule.matches.length}</span>
          </span>
        </div>
        <div className="grow"></div>
        <div className="stat-cell sim-clock" style={{ borderRight: 0, alignItems: 'flex-end' }}>
          <span className="label">Sim clock</span>
          <span className="now">{fmtClock(sim.nowMin, tweaks.clockMode || '24h')}</span>
        </div>
      </div>

      <div className="view-bar">
        <div className="tabs">
          <button className={view === 'players' ? 'active' : ''} onClick={() => setView('players')}>
            <Users size={14} /> Player timeline
          </button>
          <button className={view === 'gantt' ? 'active' : ''} onClick={() => setView('gantt')}>
            <LayoutGrid size={14} /> Gantt
          </button>
        </div>
        <div className="grow"></div>
        <div className="swatches">
          {config.events.map((ev, i) => (
            <span className="swatch" key={ev.id}>
              <span className="sq" style={{ '--c': eventColor(i) } as React.CSSProperties}></span>
              {ev.name}
            </span>
          ))}
        </div>
      </div>

      <div className="viz" ref={vizRef}>
        {view === 'gantt' ? (
          <GanttChart
            config={config}
            schedule={schedule}
            sim={sim}
            density={tweaks.density || 'comfortable'}
            colorBy={tweaks.colorBy || 'event'}
            animateMoves={animateMoves}
            clockMode={tweaks.clockMode || '24h'}
            selectedMatchId={selectedMatchId}
            onSelectMatch={setSelectedMatchId}
            onHover={setHover}
          />
        ) : (
          <PlayerTimeline
            config={config}
            schedule={schedule}
            sim={sim}
            density={tweaks.density || 'comfortable'}
            colorBy={tweaks.colorBy || 'event'}
            animateMoves={animateMoves}
            clockMode={tweaks.clockMode || '24h'}
            showIdle={tweaks.showIdle !== false}
            selectedMatchId={selectedMatchId}
            onSelectMatch={setSelectedMatchId}
            onHover={setHover}
          />
        )}
      </div>

      <SimPanel
        config={config}
        schedule={schedule}
        sim={sim}
        durations={durations}
        setDurations={setDurations}
        onAdvance={onAdvance}
        onAdvanceAll={onAdvanceAll}
        onResetSim={onResetSim}
        onResetDurations={onResetDurations}
        autoAdvancing={autoAdvancing}
        selectedMatchId={selectedMatchId}
        onSelectMatch={setSelectedMatchId}
        lastResolveMs={lastResolveMs}
      />

      <MatchTip hover={hover} config={config} />
    </div>
  )
}
