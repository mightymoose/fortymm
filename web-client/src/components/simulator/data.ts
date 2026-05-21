/* =====================================================================
   data.ts — example config + helpers + fake CP-SAT-ish solver
   Ported from the FortyMM design handoff (data.js).
   ===================================================================== */

export type EventFormat = 'round_robin'

export interface Table {
  id: string
  name: string
}

export interface Player {
  id: string
  name: string
  rating: number | null
}

export interface TournamentEvent {
  id: string
  name: string
  matchDurationMin: number
  restMin: number
  format: EventFormat
  playerIds: string[]
}

export interface TablePool {
  id: string
  eventId: string
  tableIds: string[]
  startMin: number
  endMin: number
}

export interface Config {
  name: string
  startISO: string
  endISO: string
  tables: Table[]
  players: Player[]
  events: TournamentEvent[]
  tablePools: TablePool[]
}

export interface Match {
  id: string
  eventId: string
  p1: string
  p2: string
  tableId: string
  plannedStart: number
  plannedEnd: number
  plannedDurationMin: number
  completed: boolean
  actualStart?: number
  actualEnd?: number
}

export type SolveStatus = 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE'

export interface SolveError {
  msg: string
  ref: string
  scope: ValidationScope
}

export interface Schedule {
  status: SolveStatus
  solveTimeMs: number
  makespanMin: number
  totalIdleMin: number
  matches: Match[]
  error?: SolveError
}

export interface Completion {
  matchId: string
  start: number
  end: number
  tableId: string
}

export interface SolveOptions {
  completions?: Completion[]
  previousSchedule?: Schedule | null
  isInitial?: boolean
  isPerturbed?: boolean
}

export type ValidationScope =
  | 'tournament'
  | 'tables'
  | 'players'
  | 'events'
  | 'pools'

export interface ValidationError {
  scope: ValidationScope
  ref?: string
  field?: string
  msg: string
}

export type ClockMode = '24h' | '12h' | 'from_start'

// ----- ID helpers --------------------------------------------------------
let __idc = 0
export const nid = (p: string) => `${p}_${(++__idc).toString(36)}`

// ----- Time helpers ------------------------------------------------------
export const T0_ISO = '2026-06-13T08:00:00' // tournament t=0 anchor; sim "now" works in minutes
export const TEND_ISO = '2026-06-13T19:00:00'
export const minutesBetween = (aISO: string, bISO: string) =>
  Math.round((+new Date(bISO) - +new Date(aISO)) / 60000)
export const addMin = (iso: string, m: number) =>
  new Date(new Date(iso).getTime() + m * 60000).toISOString()

export function fmtClock(
  minFromStart: number,
  mode: ClockMode = '24h',
  startISO: string = T0_ISO,
): string {
  const d = new Date(new Date(startISO).getTime() + minFromStart * 60000)
  if (mode === 'from_start') {
    const h = Math.floor(minFromStart / 60)
    const m = Math.floor(minFromStart % 60)
    return `+${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }
  const hh = d.getHours()
  const mm = d.getMinutes()
  if (mode === '12h') {
    const ampm = hh >= 12 ? 'PM' : 'AM'
    const h12 = ((hh + 11) % 12) + 1
    return `${h12}:${String(mm).padStart(2, '0')} ${ampm}`
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

// ----- Event color palette -----------------------------------------------
// Hand-tuned on dark ink, distinct, never the brand orange (reserved for "now").
export const EVENT_COLORS = [
  '#FF7A1A', // ball orange — used for the most prominent event
  '#6FB5FF', // info blue
  '#00E29A', // serve green
  '#C792EA', // violet
  '#FFC43D', // warn yellow
  '#FF7AA3', // pink
  '#7AE7C7', // mint
  '#FFA978', // peach
]

// ----- Example tournament -------------------------------------------------
export function makeExampleConfig(): Config {
  __idc = 0
  const tables: Table[] = ['1', '2', '3', '4', '5', '6'].map((n) => ({
    id: nid('tbl'),
    name: `Table ${n}`,
  }))

  const PLAYER_NAMES: [string, number][] = [
    ['Alex Nguyen', 1820],
    ['Maria Chen', 2140],
    ['Jordan Patel', 1670],
    ['Sam Rivera', 1480],
    ['Devon Park', 1980],
    ['Casey Brooks', 1310],
    ['Rin Tanaka', 2280],
    ['Priya Shah', 1740],
    ['Lukas Weber', 1560],
    ['Naomi Cole', 1880],
    ['Owen Murray', 1420],
    ['Hana Sato', 2030],
    ['Tobias Ng', 1620],
    ['Elena Petrov', 1290],
    ['Marcus Hill', 1950],
    ['Yuki Mori', 2210],
  ]
  const players: Player[] = PLAYER_NAMES.map(([name, rating]) => ({
    id: nid('plr'),
    name,
    rating,
  }))

  // ----- 3 events ------
  // Rosters are largely disjoint so the example always solves.
  const ev1: TournamentEvent = {
    id: nid('ev'),
    name: 'U2000 Singles',
    matchDurationMin: 25,
    restMin: 15,
    format: 'round_robin',
    playerIds: players
      .filter((p) => (p.rating ?? 0) < 1800)
      .slice(0, 8)
      .map((p) => p.id),
  }
  const ev2: TournamentEvent = {
    id: nid('ev'),
    name: 'Open Singles',
    matchDurationMin: 30,
    restMin: 20,
    format: 'round_robin',
    playerIds: players
      .filter((p) => (p.rating ?? 0) >= 1800)
      .slice(0, 7)
      .map((p) => p.id),
  }
  const ev3: TournamentEvent = {
    id: nid('ev'),
    name: 'Novice U1500',
    matchDurationMin: 20,
    restMin: 10,
    format: 'round_robin',
    playerIds: players
      .filter((p) => (p.rating ?? 0) < 1500)
      .slice(0, 4)
      .map((p) => p.id),
  }
  const events = [ev1, ev2, ev3]

  // ----- Table pools ------
  // Spread across the day; events partly share/overlap. Day is 0-660 min (8:00-19:00).
  const pools: TablePool[] = [
    {
      id: nid('pool'),
      eventId: ev2.id,
      tableIds: tables.slice(0, 6).map((t) => t.id),
      startMin: 0,
      endMin: 240,
    },
    {
      id: nid('pool'),
      eventId: ev2.id,
      tableIds: tables.slice(0, 4).map((t) => t.id),
      startMin: 270,
      endMin: 540,
    },
    {
      id: nid('pool'),
      eventId: ev1.id,
      tableIds: tables.slice(3, 6).map((t) => t.id),
      startMin: 0,
      endMin: 240,
    },
    {
      id: nid('pool'),
      eventId: ev1.id,
      tableIds: tables.slice(2, 6).map((t) => t.id),
      startMin: 270,
      endMin: 600,
    },
    {
      id: nid('pool'),
      eventId: ev3.id,
      tableIds: tables.slice(0, 3).map((t) => t.id),
      startMin: 270,
      endMin: 540,
    },
  ]

  return {
    name: 'Spring Open 2026',
    startISO: T0_ISO,
    endISO: TEND_ISO,
    tables,
    players,
    events,
    tablePools: pools,
  }
}

// ----- Validation -------------------------------------------------------
export function validateConfig(cfg: Config): ValidationError[] {
  const errs: ValidationError[] = []
  if (!cfg.name?.trim())
    errs.push({ scope: 'tournament', field: 'name', msg: 'Tournament needs a name.' })
  if (!cfg.startISO)
    errs.push({ scope: 'tournament', field: 'startISO', msg: 'Start time required.' })
  if (!cfg.endISO)
    errs.push({ scope: 'tournament', field: 'endISO', msg: 'End time required.' })
  if (cfg.startISO && cfg.endISO && new Date(cfg.endISO) <= new Date(cfg.startISO))
    errs.push({ scope: 'tournament', field: 'endISO', msg: 'End must be after start.' })
  if (cfg.tables.length === 0)
    errs.push({ scope: 'tables', msg: 'At least one table required.' })
  cfg.tables.forEach((t) => {
    if (!t.name?.trim())
      errs.push({ scope: 'tables', ref: t.id, field: 'name', msg: 'Table needs a name.' })
  })
  if (cfg.players.length < 2)
    errs.push({ scope: 'players', msg: 'Need at least 2 players.' })
  cfg.players.forEach((p) => {
    if (!p.name?.trim())
      errs.push({ scope: 'players', ref: p.id, field: 'name', msg: 'Player needs a name.' })
    if (p.rating != null && (p.rating < 0 || p.rating > 3000 || !Number.isInteger(p.rating)))
      errs.push({ scope: 'players', ref: p.id, field: 'rating', msg: 'Rating must be 0–3000.' })
  })
  if (cfg.events.length === 0)
    errs.push({ scope: 'events', msg: 'Need at least one event.' })
  cfg.events.forEach((e) => {
    if (!e.name?.trim())
      errs.push({ scope: 'events', ref: e.id, field: 'name', msg: 'Event needs a name.' })
    if (!e.matchDurationMin || e.matchDurationMin <= 0)
      errs.push({
        scope: 'events',
        ref: e.id,
        field: 'matchDurationMin',
        msg: 'Match duration required.',
      })
    else if (e.matchDurationMin % 5 !== 0)
      errs.push({
        scope: 'events',
        ref: e.id,
        field: 'matchDurationMin',
        msg: 'Must be a multiple of 5.',
      })
    if (e.restMin == null || e.restMin < 0)
      errs.push({ scope: 'events', ref: e.id, field: 'restMin', msg: 'Rest period required.' })
    if (e.playerIds.length < 2)
      errs.push({ scope: 'events', ref: e.id, field: 'playerIds', msg: 'Need at least 2 players.' })
    if (!cfg.tablePools.some((p) => p.eventId === e.id))
      errs.push({ scope: 'events', ref: e.id, field: 'pools', msg: 'No table pool covers this event.' })
  })
  cfg.tablePools.forEach((p) => {
    if (!p.tableIds || p.tableIds.length === 0)
      errs.push({ scope: 'pools', ref: p.id, field: 'tableIds', msg: 'Pool needs at least one table.' })
    if (p.startMin >= p.endMin)
      errs.push({ scope: 'pools', ref: p.id, field: 'endMin', msg: 'Pool end must be after start.' })
  })
  return errs
}

// ----- Round-robin pairs -------------------------------------------------
// Circle-method ordering. For N players we use rounds where every player
// plays once per round; the greedy then doesn't front-load any single
// player and produces tightly-packed schedules.
export function roundRobinPairs(playerIds: string[]): [string, string][] {
  let arr = playerIds.slice()
  if (arr.length < 2) return []
  const hadOdd = arr.length % 2 === 1
  if (hadOdd) arr.push('__BYE__')
  const n = arr.length
  const rounds: [string, string][][] = []
  for (let r = 0; r < n - 1; r++) {
    const round: [string, string][] = []
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i],
        b = arr[n - 1 - i]
      if (a !== '__BYE__' && b !== '__BYE__') round.push([a, b])
    }
    rounds.push(round)
    // Rotate: keep position 0 fixed, rotate everyone else
    const fixed = arr[0]
    const rest = arr.slice(1)
    rest.unshift(rest.pop() as string)
    arr = [fixed, ...rest]
  }
  const out: [string, string][] = []
  rounds.forEach((r) => r.forEach((p) => out.push(p)))
  return out
}

// ----- The fake solver ---------------------------------------------------
// Greedy schedule packer with: pinned completions, player rest, table pool windows.
export function solve(cfg: Config, options: SolveOptions = {}): Schedule {
  const {
    completions = [],
    previousSchedule = null,
    isInitial = false,
    isPerturbed = false,
  } = options
  const evById = Object.fromEntries(cfg.events.map((e) => [e.id, e]))
  const evIndex = Object.fromEntries(cfg.events.map((e, i) => [e.id, i]))
  const tablePoolsByEvent: Record<string, TablePool[]> = {}
  cfg.tablePools.forEach((p) => {
    ;(tablePoolsByEvent[p.eventId] ||= []).push(p)
  })
  // Per-table availability is an array of [start,end] free slots
  const dayEnd = minutesBetween(cfg.startISO, cfg.endISO)
  const tableFree: Record<string, [number, number][]> = {}
  cfg.tables.forEach((t) => {
    tableFree[t.id] = [[0, dayEnd]]
  })
  // Per-player next-free time
  const playerNextFree: Record<string, number> = {}
  cfg.players.forEach((p) => {
    playerNextFree[p.id] = 0
  })

  const completedIds = new Set(completions.map((c) => c.matchId))

  // Build needed match list
  const needed: { matchId: string; eventId: string; p1: string; p2: string }[] = []
  cfg.events.forEach((ev) => {
    const pairs = roundRobinPairs(ev.playerIds)
    pairs.forEach(([a, b]) => {
      const prev = previousSchedule?.matches?.find(
        (m) =>
          m.eventId === ev.id &&
          ((m.p1 === a && m.p2 === b) || (m.p1 === b && m.p2 === a)),
      )
      needed.push({
        matchId: prev?.id || nid('m'),
        eventId: ev.id,
        p1: a,
        p2: b,
      })
    })
  })

  // Pin completed matches first (no scheduling — just block out table + player)
  const matches: Match[] = []
  for (const c of completions) {
    const need = needed.find((n) => n.matchId === c.matchId)
    if (!need) continue
    const dur = c.end - c.start
    matches.push({
      id: need.matchId,
      eventId: need.eventId,
      p1: need.p1,
      p2: need.p2,
      tableId: c.tableId,
      plannedStart: c.start,
      plannedEnd: c.end,
      plannedDurationMin: dur,
      completed: true,
      actualStart: c.start,
      actualEnd: c.end,
    })
    blockTable(tableFree[c.tableId], c.start, c.end)
    playerNextFree[need.p1] = Math.max(
      playerNextFree[need.p1],
      c.end + evById[need.eventId].restMin,
    )
    playerNextFree[need.p2] = Math.max(
      playerNextFree[need.p2],
      c.end + evById[need.eventId].restMin,
    )
  }

  // Order remaining matches: by previous-schedule start (warm start), else event order
  const pending = needed.filter((n) => !completedIds.has(n.matchId))
  pending.sort((a, b) => {
    const pa = previousSchedule?.matches?.find((m) => m.id === a.matchId)
    const pb = previousSchedule?.matches?.find((m) => m.id === b.matchId)
    if (pa && pb) return pa.plannedStart - pb.plannedStart
    if (pa) return -1
    if (pb) return 1
    return evIndex[a.eventId] - evIndex[b.eventId]
  })

  for (const n of pending) {
    const ev = evById[n.eventId]
    const pools = tablePoolsByEvent[ev.id] || []
    if (pools.length === 0) {
      return {
        status: 'INFEASIBLE',
        solveTimeMs: 200,
        makespanMin: 0,
        totalIdleMin: 0,
        matches: [],
        error: { msg: `Event "${ev.name}" has no table pool.`, ref: ev.id, scope: 'events' },
      }
    }
    const earliestPlayer = Math.max(playerNextFree[n.p1], playerNextFree[n.p2])

    // Search for earliest fitting slot — prefer the same table as previous schedule when possible
    const prevMatch = previousSchedule?.matches?.find((m) => m.id === n.matchId)
    const preferredTable = prevMatch?.tableId
    let best: { tableId: string; start: number; end: number } | null = null
    for (const pool of pools) {
      const candTables =
        preferredTable && pool.tableIds.includes(preferredTable)
          ? [preferredTable, ...pool.tableIds.filter((t) => t !== preferredTable)]
          : pool.tableIds.slice()
      for (const tid of candTables) {
        for (const slot of tableFree[tid]) {
          const s = Math.max(slot[0], pool.startMin, earliestPlayer)
          const e = s + ev.matchDurationMin
          if (e <= slot[1] && e <= pool.endMin) {
            if (!best || s < best.start || (s === best.start && tid === preferredTable)) {
              best = { tableId: tid, start: s, end: e }
            }
            break
          }
        }
      }
    }
    if (!best) {
      return {
        status: 'INFEASIBLE',
        solveTimeMs: 220,
        makespanMin: 0,
        totalIdleMin: 0,
        matches: [],
        error: {
          msg: `Couldn't fit all matches for "${ev.name}" within its table pools.`,
          ref: ev.id,
          scope: 'events',
        },
      }
    }
    matches.push({
      id: n.matchId,
      eventId: n.eventId,
      p1: n.p1,
      p2: n.p2,
      tableId: best.tableId,
      plannedStart: best.start,
      plannedEnd: best.end,
      plannedDurationMin: ev.matchDurationMin,
      completed: false,
    })
    blockTable(tableFree[best.tableId], best.start, best.end)
    playerNextFree[n.p1] = best.end + ev.restMin
    playerNextFree[n.p2] = best.end + ev.restMin
  }

  const makespanMin = Math.max(
    ...matches.map((m) => (m.completed ? (m.actualEnd ?? 0) : m.plannedEnd)),
    0,
  )
  const totalIdleMin = computeTotalIdle(matches)

  // Solve time: synthetic. Initial is "slow", warm-start is fast.
  let solveTimeMs: number
  if (isInitial) solveTimeMs = Math.round(1500 + Math.random() * 1500)
  else if (isPerturbed) solveTimeMs = Math.round(450 + Math.random() * 700)
  else solveTimeMs = Math.round(180 + Math.random() * 280)

  const status: SolveStatus =
    pending.length <= 5 ? 'OPTIMAL' : Math.random() < 0.8 ? 'OPTIMAL' : 'FEASIBLE'

  return { status, solveTimeMs, makespanMin, totalIdleMin, matches }
}

// Block a [s,e] interval out of a free-slot list (sorted, non-overlapping).
function blockTable(slots: [number, number][], s: number, e: number): void {
  for (let i = 0; i < slots.length; i++) {
    const [a, b] = slots[i]
    if (e <= a || s >= b) continue
    // overlap
    slots.splice(i, 1)
    if (s > a) {
      slots.splice(i, 0, [a, s])
      i++
    }
    if (e < b) slots.splice(i, 0, [e, b])
    return
  }
}

function computeTotalIdle(matches: Match[]): number {
  const byPlayer: Record<string, [number, number][]> = {}
  matches.forEach((m) => {
    const s = m.completed ? (m.actualStart ?? 0) : m.plannedStart
    const e = m.completed ? (m.actualEnd ?? 0) : m.plannedEnd
    ;[m.p1, m.p2].forEach((p) => {
      ;(byPlayer[p] ||= []).push([s, e])
    })
  })
  let total = 0
  Object.values(byPlayer).forEach((arr) => {
    arr.sort((a, b) => a[0] - b[0])
    for (let i = 1; i < arr.length; i++) {
      const gap = arr[i][0] - arr[i - 1][1]
      if (gap > 0) total += gap
    }
  })
  return total
}

// Count total matches expected (across all events) for progress display
export function totalExpectedMatches(cfg: Config): number {
  return cfg.events.reduce(
    (s, e) => s + (e.playerIds.length * (e.playerIds.length - 1)) / 2,
    0,
  )
}

// Color for event by index
export function eventColor(eventIndex: number): string {
  return EVENT_COLORS[eventIndex % EVENT_COLORS.length]
}

export type ColorBy = 'event' | 'table' | 'player'

// Compute color for matching `colorBy` setting
export function colorForMatch(m: Match, cfg: Config, colorBy: ColorBy): string {
  if (colorBy === 'table') {
    const i = cfg.tables.findIndex((t) => t.id === m.tableId)
    return EVENT_COLORS[(i + 2) % EVENT_COLORS.length]
  }
  if (colorBy === 'player') {
    const h = (m.p1 + m.p2)
      .split('')
      .reduce((acc, c) => (acc + c.charCodeAt(0)) % 1000, 0)
    return EVENT_COLORS[h % EVENT_COLORS.length]
  }
  const i = cfg.events.findIndex((e) => e.id === m.eventId)
  return EVENT_COLORS[i % EVENT_COLORS.length]
}

// Initials helper
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase())
    .join('')
    .slice(0, 3)
}
