/* =====================================================================
   simulator-app.tsx — Top-level state, routing between editor/schedule,
   solve loop. Ported from the FortyMM design handoff (app.jsx).
   ===================================================================== */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock, Settings2, SlidersHorizontal } from 'lucide-react'
import {
  fmtClock,
  makeExampleConfig,
  minutesBetween,
  solve,
  totalExpectedMatches,
  validateConfig,
  TEND_ISO,
  T0_ISO,
  type ClockMode,
  type ColorBy,
  type Config,
  type Schedule,
  type SolveError,
  type SolveOptions,
} from './data'
import { Editor } from './editor'
import { ScheduleView, type Density, type SimState, type Tweaks } from './schedule'
import './simulator.css'

interface LogLine {
  t: number
  text: string
}

// ----- Solve overlay (simulated CP-SAT) ----------------------------------
function SolveOverlay({
  phase,
  progress,
  log,
}: {
  phase: string
  progress: number
  log: LogLine[]
}) {
  return (
    <div className="solve-overlay">
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="ball-mark"></span>
          <span className="title">{phase}</span>
        </div>
        <div className="bar">
          <div className="fill" style={{ '--p': `${progress}%` } as React.CSSProperties}></div>
        </div>
        <div className="log">
          {log.slice(-4).map((l, i) => (
            <div key={i} className="line">
              <span className="dim">[t={l.t.toFixed(1)}s]</span> {l.text}
            </div>
          ))}
        </div>
        <div className="sub">CP-SAT · branch-and-bound · warm-start hints from last solution</div>
      </div>
    </div>
  )
}

// Synthesizes a fake "solve" with progress/log updates.
function fakeSolveAsync(
  cfg: Config,
  opts: SolveOptions = {},
  onProgress?: (p: number, text: string, t: number) => void,
): Promise<Schedule> {
  const isInitial = opts.isInitial
  const totalMs = isInitial ? 1400 + Math.random() * 1100 : 300 + Math.random() * 250
  return new Promise((resolve) => {
    const start = performance.now()
    const phases: [number, string][] = isInitial
      ? [
          [0.05, 'Reading config…'],
          [0.1, 'Building constraint model…'],
          [
            0.2,
            `Variables: ${totalExpectedMatches(cfg) * 6}, constraints: ${Math.round(
              totalExpectedMatches(cfg) * 14,
            )}`,
          ],
          [0.35, 'CP-SAT: presolving…'],
          [0.55, 'Searching feasible region…'],
          [0.75, 'Improving objective: minimizing makespan'],
          [0.9, 'Improving objective: minimizing player idle'],
          [1.0, 'Done.'],
        ]
      : [
          [0.3, 'Pinning completed matches…'],
          [0.7, 'Warm-start hints loaded; resolving…'],
          [1.0, 'Done.'],
        ]
    let phaseIdx = 0
    const tick = () => {
      const elapsed = performance.now() - start
      const p = Math.min(1, elapsed / totalMs)
      while (phaseIdx < phases.length && phases[phaseIdx][0] <= p) {
        onProgress?.(p * 100, phases[phaseIdx][1], elapsed / 1000)
        phaseIdx++
      }
      if (p < 1) requestAnimationFrame(tick)
      else {
        const result = solve(cfg, opts)
        result.solveTimeMs = Math.round(totalMs)
        resolve(result)
      }
    }
    requestAnimationFrame(tick)
  })
}

const DEFAULT_TWEAKS: Tweaks = {
  density: 'comfortable',
  colorBy: 'event',
  clockMode: '24h',
  showIdle: true,
  animateMoves: true,
}

// ----- Lightweight view-settings popover (replaces design-tool Tweaks) ----
function SettingsPopover({
  tweaks,
  setTweak,
}: {
  tweaks: Tweaks
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void
}) {
  const seg = <K extends keyof Tweaks>(
    key: K,
    options: { value: Tweaks[K]; label: string }[],
  ) => (
    <div className="seg">
      {options.map((o) => (
        <button
          key={String(o.value)}
          className={tweaks[key] === o.value ? 'active' : ''}
          onClick={() => setTweak(key, o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
  const toggle = (key: 'showIdle' | 'animateMoves') => (
    <button
      className="switch"
      data-on={tweaks[key] ? '1' : '0'}
      role="switch"
      aria-checked={tweaks[key]}
      onClick={() => setTweak(key, !tweaks[key])}
    >
      <i />
    </button>
  )
  return (
    <div className="settings-pop">
      <div className="sect">Layout</div>
      <div className="row">
        <span>Density</span>
        {seg<'density'>('density', [
          { value: 'comfortable' as Density, label: 'Comfy' },
          { value: 'compact' as Density, label: 'Compact' },
          { value: 'tight' as Density, label: 'Tight' },
        ])}
      </div>
      <div className="row">
        <span>Clock</span>
        {seg<'clockMode'>('clockMode', [
          { value: '24h' as ClockMode, label: '24h' },
          { value: '12h' as ClockMode, label: '12h' },
          { value: 'from_start' as ClockMode, label: '+min' },
        ])}
      </div>
      <div className="sect">Schedule</div>
      <div className="row">
        <span>Color by</span>
        {seg<'colorBy'>('colorBy', [
          { value: 'event' as ColorBy, label: 'Event' },
          { value: 'table' as ColorBy, label: 'Table' },
          { value: 'player' as ColorBy, label: 'Pair' },
        ])}
      </div>
      <div className="row">
        <span>Idle hatches</span>
        {toggle('showIdle')}
      </div>
      <div className="row">
        <span>Animate re-solves</span>
        {toggle('animateMoves')}
      </div>
    </div>
  )
}

// ----- App ---------------------------------------------------------------
export function SimulatorApp() {
  const [tab, setTab] = useState<'editor' | 'schedule'>('editor')
  const [config, setConfig] = useState<Config>(() => makeExampleConfig())
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [solving, setSolving] = useState(false)
  const [solvePhase, setSolvePhase] = useState('Solving…')
  const [solveProgress, setSolveProgress] = useState(0)
  const [solveLog, setSolveLog] = useState<LogLine[]>([])
  const [infeasibleErr, setInfeasibleErr] = useState<SolveError | null>(null)
  const [autoAdvancing, setAutoAdvancing] = useState(false)
  const [lastResolveMs, setLastResolveMs] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Sim state — never sent to backend except as completions
  const [sim, setSim] = useState<SimState>({ completions: [], nowMin: 0 })
  const [durations, setDurations] = useState<Record<string, number>>({})

  const [tweaks, setTweaks] = useState<Tweaks>(DEFAULT_TWEAKS)
  const setTweak = useCallback(
    <K extends keyof Tweaks>(key: K, value: Tweaks[K]) =>
      setTweaks((prev) => ({ ...prev, [key]: value })),
    [],
  )

  const errors = useMemo(() => validateConfig(config), [config])

  // Navigation between editor <-> schedule via custom events (from editor footer)
  useEffect(() => {
    const goSchedule = () => setTab('schedule')
    const goEditor = () => setTab('editor')
    window.addEventListener('sim-go-schedule', goSchedule)
    window.addEventListener('sim-go-editor', goEditor)
    return () => {
      window.removeEventListener('sim-go-schedule', goSchedule)
      window.removeEventListener('sim-go-editor', goEditor)
    }
  }, [])

  // ---- Solve ----
  const runSolve = useCallback(
    async (opts: SolveOptions = {}) => {
      setSolving(true)
      setSolveProgress(0)
      setSolveLog([])
      setInfeasibleErr(null)
      const onProg = (p: number, text: string, t: number) => {
        setSolveProgress(p)
        setSolvePhase(text)
        setSolveLog((log) => [...log, { t, text }])
      }
      const result = await fakeSolveAsync(config, opts, onProg)
      setSolving(false)
      if (result.status === 'INFEASIBLE') {
        setInfeasibleErr(result.error ?? null)
        setSchedule(null)
        setTab('editor')
        return result
      }
      setSchedule(result)
      setLastResolveMs(result.solveTimeMs)
      return result
    },
    [config],
  )

  const onSolveInitial = useCallback(async () => {
    setSim({ completions: [], nowMin: 0 })
    setDurations({})
    setSchedule(null)
    const result = await runSolve({ isInitial: true })
    if (result && result.status !== 'INFEASIBLE') setTab('schedule')
  }, [runSolve])

  // Watch for actual config changes (deep) — invalidate sim & schedule
  const lastConfigSig = useRef('')
  useEffect(() => {
    const sig = JSON.stringify(config)
    if (lastConfigSig.current && lastConfigSig.current !== sig) {
      setSim({ completions: [], nowMin: 0 })
      setDurations({})
      setSchedule(null)
    }
    lastConfigSig.current = sig
  }, [config])

  // ---- Advance simulator ----
  const advanceOnce = useCallback(async () => {
    if (!schedule) return
    const completedIds = new Set(sim.completions.map((c) => c.matchId))
    const pending = schedule.matches.filter((m) => !completedIds.has(m.id))
    if (pending.length === 0) return
    let next: (typeof pending)[number] | null = null,
      bestT = Infinity
    for (const m of pending) {
      const ev = config.events.find((e) => e.id === m.eventId)!
      const actualDur = durations[m.id] ?? ev.matchDurationMin
      const t = m.plannedStart + actualDur
      if (t < bestT || (t === bestT && (!next || m.id < next.id))) {
        bestT = t
        next = m
      }
    }
    if (!next) return
    const ev = config.events.find((e) => e.id === next!.eventId)!
    const actualDur = durations[next.id] ?? ev.matchDurationMin
    const completion = {
      matchId: next.id,
      start: next.plannedStart,
      end: next.plannedStart + actualDur,
      tableId: next.tableId,
    }
    const newCompletions = [...sim.completions, completion]
    const newNow = completion.end

    setSolving(true)
    setSolveLog([])
    setSolveProgress(0)
    setSolvePhase('Re-solving with pinned completions…')
    const result = await fakeSolveAsync(
      config,
      {
        completions: newCompletions,
        previousSchedule: schedule,
        isPerturbed: actualDur !== ev.matchDurationMin,
      },
      (p, text, t) => {
        setSolveProgress(p)
        setSolvePhase(text)
        setSolveLog((log) => [...log, { t, text }])
      },
    )
    setSolving(false)
    if (result.status === 'INFEASIBLE') {
      setInfeasibleErr(result.error ?? null)
      setTab('editor')
      return
    }
    setSchedule(result)
    setSim({ completions: newCompletions, nowMin: newNow })
    setLastResolveMs(result.solveTimeMs)
  }, [schedule, sim, durations, config])

  const advanceToEnd = useCallback(async () => {
    if (!schedule) return
    setAutoAdvancing(true)
    const cfg = config
    let s = schedule
    let sm = sim
    const durs = durations
    for (;;) {
      const completedIds = new Set(sm.completions.map((c) => c.matchId))
      const pending = s.matches.filter((m) => !completedIds.has(m.id))
      if (pending.length === 0) break
      let next: (typeof pending)[number] | null = null,
        bestT = Infinity
      for (const m of pending) {
        const ev = cfg.events.find((e) => e.id === m.eventId)!
        const ad = durs[m.id] ?? ev.matchDurationMin
        const t = m.plannedStart + ad
        if (t < bestT || (t === bestT && (!next || m.id < next.id))) {
          bestT = t
          next = m
        }
      }
      if (!next) break
      const ev = cfg.events.find((e) => e.id === next!.eventId)!
      const ad = durs[next.id] ?? ev.matchDurationMin
      const comp = {
        matchId: next.id,
        start: next.plannedStart,
        end: next.plannedStart + ad,
        tableId: next.tableId,
      }
      const newCompletions = [...sm.completions, comp]
      setSolving(true)
      setSolveLog([])
      setSolveProgress(0)
      setSolvePhase('Auto-advancing…')
      const t0 = performance.now()
      const ttotal = 250 + Math.random() * 180
      await new Promise<void>((r) => {
        const tick = () => {
          const p = Math.min(1, (performance.now() - t0) / ttotal)
          setSolveProgress(p * 100)
          if (p < 1) requestAnimationFrame(tick)
          else r()
        }
        requestAnimationFrame(tick)
      })
      const result = solve(cfg, {
        completions: newCompletions,
        previousSchedule: s,
        isPerturbed: false,
      })
      result.solveTimeMs = Math.round(ttotal)
      if (result.status === 'INFEASIBLE') {
        setSolving(false)
        setAutoAdvancing(false)
        setInfeasibleErr(result.error ?? null)
        setTab('editor')
        return
      }
      s = result
      sm = { completions: newCompletions, nowMin: comp.end }
      setSchedule(s)
      setSim(sm)
      setLastResolveMs(result.solveTimeMs)
      setSolving(false)
      await new Promise<void>((r) => setTimeout(r, 60))
    }
    setAutoAdvancing(false)
  }, [schedule, sim, durations, config])

  const onResetSim = useCallback(async () => {
    setSim({ completions: [], nowMin: 0 })
    await runSolve({ isInitial: false })
  }, [runSolve])

  const onResetDurations = useCallback(() => {
    setDurations({})
  }, [])

  return (
    <div className="sim-root">
      <div className="app">
        <div className="topbar">
          <div className="brand">
            <span className="ball-mark"></span>
            FORTYMM
            <span className="subtitle">Scheduler · Simulator</span>
          </div>
          <div className="tabs">
            <button className={tab === 'editor' ? 'active' : ''} onClick={() => setTab('editor')}>
              <Settings2 size={14} /> Editor
            </button>
            <button
              className={tab === 'schedule' ? 'active' : ''}
              disabled={!schedule}
              onClick={() => setTab('schedule')}
            >
              <CalendarClock size={14} /> Schedule
            </button>
          </div>
          <div className="grow"></div>
          <div className="meta">
            <span>{config.name}</span>
            <span style={{ color: 'var(--ink-600)' }}>·</span>
            <span className="mono" style={{ fontFamily: 'var(--font-mono)' }}>
              {fmtClock(0, '24h', config.startISO)} →{' '}
              {fmtClock(minutesBetween(config.startISO, config.endISO), '24h', config.startISO)}
            </span>
          </div>
          <button
            className="btn ghost icon-only"
            title="View settings"
            aria-label="View settings"
            onClick={() => setSettingsOpen((o) => !o)}
          >
            <SlidersHorizontal size={16} />
          </button>
        </div>

        {tab === 'editor' ? (
          <Editor
            config={config}
            setConfig={setConfig}
            errors={errors}
            onSolve={onSolveInitial}
            onLoadExample={() => setConfig(makeExampleConfig())}
            onReset={() => {
              setConfig({
                name: '',
                startISO: T0_ISO,
                endISO: TEND_ISO,
                tables: [],
                players: [],
                events: [],
                tablePools: [],
              })
            }}
            solving={solving}
            schedule={schedule}
            infeasibleErr={infeasibleErr}
          />
        ) : schedule ? (
          <ScheduleView
            config={config}
            schedule={schedule}
            sim={sim}
            durations={durations}
            setDurations={setDurations}
            onAdvance={advanceOnce}
            onAdvanceAll={advanceToEnd}
            onResetSim={onResetSim}
            onResetDurations={onResetDurations}
            autoAdvancing={autoAdvancing}
            tweaks={tweaks}
            lastResolveMs={lastResolveMs}
          />
        ) : (
          <div className="no-schedule">No schedule yet — go to the editor and solve.</div>
        )}

        {solving && !autoAdvancing && (
          <SolveOverlay phase={solvePhase} progress={solveProgress} log={solveLog} />
        )}

        {settingsOpen && <SettingsPopover tweaks={tweaks} setTweak={setTweak} />}
      </div>
    </div>
  )
}
