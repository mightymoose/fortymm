// Pure helpers for the tournament-admin UI: date-only formatting (the domain
// uses `YYYY-MM-DD`, never wall-clock instants, so we parse to a local Date to
// dodge timezone drift), derived date ranges, predicate labels, and table
// double-booking detection.

import { PRED_FIELDS } from './options'
import type {
  Entrant,
  Predicate,
  Pool,
  Tournament,
  TournamentEvent,
} from './types'

/**
 * The signed-in player's own active entry in an event, or `undefined` when they
 * are not entered — i.e. the "Enter or Withdraw?" decision, and the entry id a
 * withdrawal is addressed to.
 *
 * It matches on USERNAME, not user id, on purpose: the session payload
 * (`SessionUser`) carries only `username` + `permissions` — the web client never
 * learns its own user id — while an entrant carries both. Usernames are unique,
 * so this is exact; it is just the only join key the two payloads share.
 */
export function myEntrant(
  event: TournamentEvent,
  username: string | null | undefined,
): Entrant | undefined {
  if (!username) return undefined
  return event.entrants.find((e) => e.username === username)
}

/** Parse a date-only `YYYY-MM-DD` string into a local-midnight Date. */
function parseDateOnly(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return parseDateOnly(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return '—'
  return parseDateOnly(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

/** A compact, human range: collapses same-day, same-month, and full spans. */
export function fmtDateRange(
  a: string | null | undefined,
  b: string | null | undefined,
): string {
  if (!a || !b) return '—'
  if (a === b) return fmtDate(a)
  const [ay, am] = a.split('-').map(Number)
  const [by, bm] = b.split('-').map(Number)
  if (ay === by && am === bm) {
    return `${fmtDateShort(a)}–${b.split('-')[2]}, ${ay}`
  }
  return `${fmtDateShort(a)} – ${fmtDate(b)}`
}

/** Inclusive day count between two date-only strings (min 1). */
export function daysBetween(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  if (!a || !b) return 1
  const da = parseDateOnly(a)
  const db = parseDateOnly(b)
  return Math.max(1, Math.round((db.getTime() - da.getTime()) / 86_400_000) + 1)
}

/** A tournament's real date span is the min/max of its events' slots; falls
 * back to the seeded `startDate`/`endDate` when there are no events. */
export function effectiveDateRange(t: Tournament): {
  start: string | null
  end: string | null
} {
  const dates = t.events.map((e) => e.slot?.date).filter(Boolean) as string[]
  if (dates.length === 0) {
    return { start: t.startDate, end: t.endDate }
  }
  dates.sort()
  return { start: dates[0], end: dates[dates.length - 1] }
}

/** A human-readable summary of one eligibility predicate, e.g. `Age < 18`. */
export function formatPredicate(p: Predicate): string {
  const f = PRED_FIELDS[p.field]
  if (!f) return '—'
  if (f.type === 'number') {
    const v = p.value
    const ops: Record<string, string> = {
      '<': '<',
      '<=': '≤',
      '>': '>',
      '>=': '≥',
      '=': '=',
      '!=': '≠',
    }
    if (p.op === 'between' && Array.isArray(v)) {
      return `${f.label} in [${v[0] ?? '?'}–${v[1] ?? '?'}]`
    }
    if (ops[p.op]) return `${f.label} ${ops[p.op]} ${v ?? '?'}`
  }
  if (f.type === 'enum') {
    const label =
      f.options?.find((o) => o.value === p.value)?.label ?? String(p.value)
    return `${f.label} ${p.op === 'is' ? '=' : '≠'} ${label}`
  }
  if (f.type === 'bool') {
    return p.op === 'true' ? `Must be ${f.label}` : `Must not be ${f.label}`
  }
  return '—'
}

export interface PoolConflict {
  table: string
  poolA: string
  poolB: string
}

/** Tables double-booked across two pools whose time windows overlap on the
 * same day — surfaced as a warning in the event editor's Table pools tab. */
export function findPoolConflicts(pools: Pool[]): PoolConflict[] {
  const conflicts: PoolConflict[] = []
  for (let i = 0; i < pools.length; i++) {
    for (let j = i + 1; j < pools.length; j++) {
      const a = pools[i]
      const b = pools[j]
      if (a.slot.date !== b.slot.date) continue
      if (a.slot.end <= b.slot.start || b.slot.end <= a.slot.start) continue
      const shared = a.tableIds.filter((t) => b.tableIds.includes(t))
      for (const t of shared) {
        conflicts.push({ table: t.toUpperCase(), poolA: a.name, poolB: b.name })
      }
    }
  }
  return conflicts
}

let idCounter = 0
/** Unique-enough id for in-session entities. Scope: a single tab — the counter
 * resets on reload and isn't shared across tabs, which is fine for this
 * front-end-only prototype but not for real persistence. */
export function genId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${idCounter}-${Date.now().toString(36)}`
}

/** A blank draft tournament for the "New tournament" modal. */
export function emptyTournament(): Omit<Tournament, 'id'> {
  return {
    name: '',
    status: 'draft',
    // A brand-new tournament is created by, hence owned by, the current user.
    canEdit: true,
    startDate: null,
    endDate: null,
    description: '',
    address: {
      venue: '',
      street: '',
      city: '',
      region: '',
      postal: '',
      country: 'USA',
    },
    tableIds: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
    events: [],
  }
}

/** A blank draft event, defaulting its date to the tournament's first day. */
export function emptyEvent(t: Tournament): TournamentEvent {
  const range = effectiveDateRange(t)
  const defaultDate = range.start ?? new Date().toISOString().slice(0, 10)
  return {
    id: genId('new'),
    name: '',
    format: 'singles',
    drawType: 'single-elim',
    maxPlayers: 32,
    entryFee: 30,
    // A draft event nobody has entered: no entrants, so the derived count is 0.
    entered: 0,
    entrants: [],
    slot: { date: defaultDate, start: '09:00', end: '13:00' },
    predicates: [],
    match: { rated: true, lengthGames: 5 },
    pools: [],
  }
}
