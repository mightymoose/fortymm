// Pure helpers for the tournament-admin UI: date-only formatting (the domain
// uses `YYYY-MM-DD`, never wall-clock instants, so we parse to a local Date to
// dodge timezone drift), derived date ranges, predicate labels, and table
// double-booking detection.

import { labelFor, PRED_FIELDS, PRED_OPS_BY_TYPE } from './options'
import type { PredicateOp } from './options'
import type {
  Address,
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

/**
 * Does this entrant hold **no rating on the tournament's ladder** — i.e. are they
 * an *unrated entrant* (CONTEXT.md, ADR-0783 §3)?
 *
 * One definition, so the roster, and anything that comes after it, cannot fork two
 * ideas of what unrated means. The rule is exactly "the server sent no rating":
 *
 * - It is **not** a rating of zero, and not a low rating. An unrated player holds
 *   no rating *at all* — they have never finished a rated match on that ladder —
 *   which is why they are not "unranked" or "provisional" either.
 * - It is **not** the client's own arithmetic on a nullable column. A brand-new
 *   player is seeded 1500 at sign-up and is *still* unrated; `is_rated_member()`
 *   (`api/app/ratings/rated.py`) is the single definition, and this `null` is its
 *   answer, already computed. Re-deriving it here — from the event's `predicates`,
 *   from a rating of 1500, from anything — is the trap ADR-0783 flags in bold, and
 *   it inverts the decision it is trying to implement.
 *
 * It matters because an unrated player **passes every rating rule**, so a rating
 * cap is opt-out; marking them is the mitigation the ADR accepts that cost under.
 */
export function isUnrated(entrant: Entrant): boolean {
  return entrant.rating === null
}

/** U+2014. "Unset renders as an em-dash" is a single contract (ADR 0015, rule
 * 3) — absent and not-applicable must stay distinguishable — so it gets a single
 * definition, shared by the formatters here and by `ReadOnlyValue`. */
export const EM_DASH = '—'

/** The browser's resolved IANA timezone (e.g. `America/Chicago`) — the frame a
 * **new** event's wall-clock windows default to being anchored in (ADR 20260719).
 * A single call to `Intl`, so a test can mock `Intl.DateTimeFormat` and watch the
 * default follow. The director can change it in the editor's timezone picker; the
 * server does every bit of the actual timezone arithmetic. */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

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

/** An `HH:MM–HH:MM` time window, tolerant of a half-set (or wholly unset) slot.
 *
 * The naive `` `${start}–${end}` `` template renders a *hole* when a bound is
 * missing — "09:00–" — which is punctuation pretending to be data. An unset
 * value reads as the em-dash, one contract with the rest of this module (ADR
 * 0015, rule 3). One bound alone is real information, so it is shown alone.
 *
 * Note the two dashes are different characters and are not interchangeable: the
 * separator between two times is an **en** dash (`–`, U+2013); `EM_DASH` (`—`,
 * U+2014) is the marker for "no value at all". */
export function fmtTimeWindow(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (start && end) return `${start}–${end}`
  if (start) return start
  if (end) return end
  return EM_DASH
}

/** Join the values that are actually there, dropping the blank (and
 * whitespace-only) ones — so a separator only ever appears BETWEEN two present
 * values, and never has to stand in for a missing one. */
const joinPresent = (parts: string[], sep: string): string =>
  parts.map((p) => p.trim()).filter(Boolean).join(sep)

/** A tournament's venue line — `Berkeley TT Club · Berkeley, CA` — built by
 * filtering the address parts and joining the survivors, NOT by interpolating
 * each part into a template with its separator baked in (#994, #972).
 *
 * Every address part is optional (`Address` types them as plain strings, blank
 * = `''`), so the template form rendered its punctuation whether or not it had
 * anything to punctuate: a venue-less tournament read as a bare `· ,` and a
 * venue with no city as `BETAVENUE · ,`. Punctuation is not data.
 *
 * Returns `''` when nothing is present — a caller must render NO venue line at
 * all in that case (no icon, no empty row), which is why this is not the
 * em-dash that `ReadOnlyValue` and the formatters above use: those label a
 * field whose row exists regardless; this one decides whether the row exists. */
export function fmtVenueLine(address: Address): string {
  const locality = joinPresent([address.city, address.region], ', ')
  return joinPresent([address.venue, locality], ' · ')
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

/** Join labels the way a sentence does: `A`, `A and B`, `A, B and C`. The single
 * definition behind every "list of things" sentence in the tournament UI (a save
 * failure's fields, a refusal's pools, a solve's conflicting matches), so the
 * comma-and-conjunction rule can't drift between them. Empty in → `''`. */
export function conjoinWithAnd(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
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

/** A **compact** summary of one eligibility predicate, e.g. `Rating < 1500` — the
 * chip form, sized for an event card's badge row.
 *
 * Deliberately *not* the same output as `predicateSentence` below: a chip wants
 * `Rating in [1200–2400]`, a panel wants the prose the rule already reads as. Two
 * voices, one vocabulary — both compose their labels out of `options.ts`
 * (`labelFor`, `PRED_FIELDS`) and both render an unset value as the same em-dash.
 *
 * The vocabulary is one numeric field (ADR-0783), so there is one formatting
 * branch. A field key the vocabulary does not know — a payload from a future or a
 * past schema — is the em-dash, not a crash. */
/** The chip's symbol for each operator that renders as `field SYM value` —
 * i.e. every operator except `between`, which takes two bounds and a shape of
 * its own. Keyed by `Exclude<PredicateOp, 'between'>` rather than by `string`,
 * so it is **total**: an operator added to `PRED_OPS_BY_TYPE` is a compile error
 * here until it is given a symbol, instead of silently formatting as nothing. */
const OP_SYMBOLS: Record<Exclude<PredicateOp, 'between'>, string> = {
  '<': '<',
  '<=': '≤',
  '>': '>',
  '>=': '≥',
  '=': '=',
  '!=': '≠',
}

export function formatPredicate(p: Predicate): string {
  const f = PRED_FIELDS[p.field]
  if (!f) return EM_DASH
  const v = p.value
  if (p.op === 'between') {
    if (!Array.isArray(v)) return EM_DASH
    return `${f.label} in [${v[0] ?? '?'}–${v[1] ?? '?'}]`
  }
  // Typed `string | undefined` deliberately: the *type* says the lookup is
  // total, but a stale payload (an operator from a schema that is not ours) is
  // a runtime possibility, and it reads as the em-dash — never "Rating
  // undefined 1500".
  const symbol: string | undefined = OP_SYMBOLS[p.op]
  if (symbol === undefined) return EM_DASH
  return `${f.label} ${symbol} ${v ?? '?'}`
}

const num = (n: number | null | undefined): string =>
  n === null || n === undefined ? EM_DASH : String(n)

/** The value half of the sentence, in the same words the editor's value control
 * shows: one number, or the two bounds of a `between`. An unfilled value is the
 * em-dash, never the string "null". */
function valueText(p: Predicate): string {
  if (p.op === 'between') {
    const [lo, hi] = Array.isArray(p.value) ? p.value : [null, null]
    return `${num(lo)} and ${num(hi)}`
  }
  return num(typeof p.value === 'number' ? p.value : null)
}

/** The rule as one **sentence**: `[field] [operator] [value]` was always a
 * sentence chopped into a grid, so read-only it is simply put back together —
 * "Rating is between 1200 and 1500" (ADR 0015, rule 4). Every word comes from the
 * labels the editor's own three controls display, so there is no second
 * vocabulary to keep in step.
 *
 * Lives here, beside `formatPredicate`, so that adding a predicate field or
 * operator is a one-file change rather than a hunt through a component. */
export function predicateSentence(p: Predicate): string {
  const schema = PRED_FIELDS[p.field]
  if (!schema) return EM_DASH

  const op = labelFor(PRED_OPS_BY_TYPE[schema.type], p.op, p.op)
  return `${schema.label} ${op} ${valueText(p)}`
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
    // A brand-new tournament has never been solved — and `Tournament` is the READ
    // model besides: `draftToCreateBody` does not propagate this, exactly as it
    // drops `status`.
    latestScheduleSolve: null,
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
    // Anchor the wall-clock windows in the director's own timezone (ADR 20260719):
    // a new event pre-fills from the browser's resolved zone, which for the common
    // single-venue case is exactly the venue's. They can correct it in the editor.
    timezone: browserTimezone(),
    // A draft event nobody has entered: no entrants, so the derived count is 0.
    entered: 0,
    entrants: [],
    // Nothing about an unsaved event refuses anybody: it has room (nobody is in
    // it) and no rules yet. The server will send the real judgement the moment the
    // event exists — this is a placeholder for a payload that has not happened.
    entryState: { state: 'open' },
    slot: { date: defaultDate, start: '09:00', end: '13:00' },
    predicates: [],
    match: { rated: true, lengthGames: 5 },
    pools: [],
    // No draw (ADR-0786), and there could not be one: a draw is cut from a field, and
    // an event that does not exist on the server yet has no entrants to cut it from.
    fixtures: [],
    // No results (ADR-0788): with no draw there is nothing to stand. The server sends the
    // real thing once the event exists and its draw is cut.
    results: null,
  }
}
