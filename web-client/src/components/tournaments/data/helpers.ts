// Pure helpers for the tournament-admin UI: date-only formatting (the domain
// uses `YYYY-MM-DD`, never wall-clock instants, so we parse to a local Date to
// dodge timezone drift), derived date ranges, predicate labels, and table
// double-booking detection.

import { labelFor, PRED_FIELDS, PRED_OPS_BY_TYPE } from './options'
import type { PredicateFieldSchema } from './options'
import type { Predicate, Pool, Tournament, TournamentEvent } from './types'

/** U+2014. "Unset renders as an em-dash" is a single contract (ADR 0015, rule
 * 3) — absent and not-applicable must stay distinguishable — so it gets a single
 * definition, shared by the formatters here and by `ReadOnlyValue`. */
export const EM_DASH = '—'

/** Parse a date-only `YYYY-MM-DD` string into a local-midnight Date. */
function parseDateOnly(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return EM_DASH
  return parseDateOnly(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return EM_DASH
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
  if (!a || !b) return EM_DASH
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

/** An enum predicate's value, as the option label the editor's own picker shows
 * ("Female"), never the key it is stored under ("F"). Shared by both predicate
 * formatters below — the one lookup they genuinely have in common. */
const enumValueLabel = (schema: PredicateFieldSchema, p: Predicate): string =>
  labelFor(schema.options ?? [], String(p.value), String(p.value))

/** A **compact** summary of one eligibility predicate, e.g. `Age < 18` — the
 * chip form, sized for an event card's badge row.
 *
 * Deliberately *not* the same output as `predicateSentence` below: a chip wants
 * `USATT rating in [1200–2400]`, a panel wants the prose the rule already reads
 * as. Two voices, one vocabulary — both compose their labels out of `options.ts`
 * (`labelFor`) and both render an unset value as the same em-dash. */
export function formatPredicate(p: Predicate): string {
  const f = PRED_FIELDS[p.field]
  if (!f) return EM_DASH
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
    return `${f.label} ${p.op === 'is' ? '=' : '≠'} ${enumValueLabel(f, p)}`
  }
  if (f.type === 'bool') {
    return p.op === 'true' ? `Must be ${f.label}` : `Must not be ${f.label}`
  }
  return EM_DASH
}

/** The bool field's value, as prose. It reads as the tail of its operator
 * ("must be" + "a club member"), which is why the editor's value cell shows it
 * verbatim rather than as a control — and why `predicateSentence` can borrow it
 * instead of inventing copy. */
export const BOOL_PREDICATE_VALUE = 'a club member'

const num = (n: number | null | undefined): string =>
  n === null || n === undefined ? EM_DASH : String(n)

/** The value half of the sentence, in the same words the editor's value control
 * shows. */
function valueText(schema: PredicateFieldSchema, p: Predicate): string {
  if (schema.type === 'enum') {
    return p.value == null ? EM_DASH : enumValueLabel(schema, p)
  }
  if (p.op === 'between') {
    const [lo, hi] = Array.isArray(p.value) ? p.value : [null, null]
    return `${num(lo)} and ${num(hi)}`
  }
  return num(typeof p.value === 'number' ? p.value : null)
}

/** The rule as one **sentence**: `[field] [operator] [value]` was always a
 * sentence chopped into a grid, so read-only it is simply put back together —
 * "USATT rating is between 1200 and 1500" (ADR 0015, rule 4). Every word comes
 * from the labels the editor's own three controls display, so there is no second
 * vocabulary to keep in step.
 *
 * The bool field is the exception: it is the *object* of its operator, so the
 * literal three-cell join would read "Club member must be a club member". It
 * keeps the operator and the prose value only — "Must be a club member".
 *
 * Lives here, beside `formatPredicate`, so that adding a predicate field or
 * operator is a one-file change rather than a hunt through a component. */
export function predicateSentence(p: Predicate): string {
  const schema = PRED_FIELDS[p.field]
  if (!schema) return EM_DASH

  const op = labelFor(PRED_OPS_BY_TYPE[schema.type], p.op, p.op)
  if (schema.type === 'bool') {
    return `${op.charAt(0).toUpperCase()}${op.slice(1)} ${BOOL_PREDICATE_VALUE}`
  }
  return `${schema.label} ${op} ${valueText(schema, p)}`
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
    entered: 0,
    slot: { date: defaultDate, start: '09:00', end: '13:00' },
    predicates: [],
    match: { rated: true, lengthGames: 5 },
    pools: [],
  }
}
