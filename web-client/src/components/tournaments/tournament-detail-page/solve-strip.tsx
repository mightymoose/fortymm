import { useState } from 'react'
import {
  CalendarClock,
  CircleCheck,
  CircleX,
  Clock,
  Loader2,
  Play,
  TriangleAlert,
} from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { fmtDateRel } from '@/lib/dates'

import {
  TRIGGER_LABEL,
  VERDICT_LABEL,
  fmtWallTime,
  infeasibilityReasonCopy,
  infeasibilityReasonKey,
  placementConflictKey,
  placementConflictSentence,
  runSchedulerNotice,
  solveInFlight,
  solveStripState,
  type RunSchedulerNotice,
  type ScheduleSolve,
} from '../data/solve'

export interface SolveStripProps {
  /** The latest run of the schedule solver, or `null` when none was ever
   * requested — the designed "no plan yet" state, never an error. */
  solve: ScheduleSolve | null
  /** Owner? The Run-scheduler button is theirs alone — hidden, never disabled,
   * for a viewer (ADR-0015; the API independently 403s a non-owner). */
  canEdit: boolean
  /** Fire the solve request. Must reject with the `ApiError` on refusal — the
   * strip owns the inline notice (`runSchedulerNotice`), so the mutation behind
   * this must not also toast. */
  onRun: () => Promise<void>
}

/** One visual grammar for the five states: an icon in the state's tint, a
 * headline, and a quieter line under it. */
const Line = ({
  icon,
  tint,
  title,
  children,
}: {
  icon: React.ReactNode
  tint: string
  title: React.ReactNode
  children?: React.ReactNode
}) => (
  <div className="flex min-w-0 items-start gap-3">
    <span className={`mt-0.5 shrink-0 ${tint}`}>{icon}</span>
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-[color:var(--fg-1)]">
        {title}
      </div>
      {children && (
        <div className="mt-0.5 text-[12px] text-[color:var(--fg-3)]">
          {children}
        </div>
      )}
    </div>
  </div>
)

/** The latest solve, rendered as its designed state. Split from the strip so the
 * strip's `switch` reads as the sum type it renders. */
const SolveState = ({ solve, canEdit }: { solve: ScheduleSolve | null; canEdit: boolean }) => {
  const state = solveStripState(solve)
  switch (state.kind) {
    case 'none':
      return (
        <div data-testid="solve-strip-none">
          <Line
            icon={<CalendarClock size={18} />}
            tint="text-[color:var(--fg-3)]"
            title="No schedule plan yet"
          >
            {canEdit
              ? 'Run the scheduler to place every match on a table — estimates the solver keeps fresh, promises only when a match is called.'
              : 'The organizer has not run the scheduler yet.'}
          </Line>
        </div>
      )
    case 'solving':
      return (
        <div data-testid="solve-strip-solving">
          <Line
            icon={<Loader2 size={18} className="animate-spin" />}
            tint="text-[color:var(--ball-500)]"
            title="Solving the schedule…"
          >
            {TRIGGER_LABEL[state.trigger]}.
          </Line>
        </div>
      )
    case 'succeeded': {
      const wall = fmtWallTime(state.wallTimeMs)
      const solvedTitle = state.finishedAt
        ? `Schedule solved ${fmtDateRel(state.finishedAt)}`
        : 'Schedule solved'
      return (
        <div data-testid="solve-strip-succeeded">
          <Line
            // A calm signal, not an error: overrunning stays on the success
            // tint and only earns the badge — the plan solved, it just runs
            // past the planned window (ADR "the solver stops wedging").
            icon={<CircleCheck size={18} />}
            tint="text-[color:var(--serve-500)]"
            title={
              <>
                <span>{solvedTitle}</span>
                {state.overrunning && (
                  <Badge
                    data-testid="solve-strip-overrunning"
                    className="border-[color:var(--warn)]/30 bg-[color:var(--warn)]/12 text-[color:var(--warn)]"
                  >
                    <Clock size={12} />
                    Overrunning
                  </Badge>
                )}
              </>
            }
          >
            {VERDICT_LABEL[state.verdict]}
            {wall ? ` — solved in ${wall}` : ''} · {TRIGGER_LABEL[state.trigger]}.
            {state.overrunning && (
              // INSTEAD of a "doesn't fit" error: the live day ran past its
              // planned window, but the soft window keeps the day schedulable —
              // matches are still being placed into the overrun.
              <span className="mt-0.5 block text-[color:var(--warn)]">
                The day is running past its planned window, but matches are still
                being scheduled into the overrun.
              </span>
            )}
          </Line>
        </div>
      )
    }
    case 'infeasible': {
      // A DESIGNED outcome, not an error banner: the solver *proved* the plan
      // impossible, which is exactly what a pre-live run is for. The API resolves
      // the causes to names/numbers, so the strip names each specifically —
      // falling back to the generic sentence only if the (guaranteed ≥1) list is
      // somehow empty, so the strip never renders bodyless. A `past_window` cause
      // (a wholly-past day) is one arm of that list, given the dated headline
      // when it is the whole story (ADR "a past day is named, not disguised").
      const onlyPastWindow =
        state.reasons.length > 0 &&
        state.reasons.every((reason) => reason.kind === 'past_window')
      return (
        <div data-testid="solve-strip-infeasible">
          <Line
            icon={<TriangleAlert size={18} />}
            tint="text-[color:var(--warn)]"
            title={
              onlyPastWindow ? 'This day has already passed' : "The day doesn't fit"
            }
          >
            {state.reasons.length > 0 ? (
              <ul className="space-y-1.5">
                {state.reasons.map((reason, i) => {
                  const copy = infeasibilityReasonCopy(reason)
                  return (
                    <li
                      key={infeasibilityReasonKey(reason, i)}
                      data-testid={
                        reason.kind === 'past_window'
                          ? 'solve-strip-past-window'
                          : undefined
                      }
                    >
                      <span className="text-[color:var(--fg-2)]">
                        {copy.sentence}
                      </span>{' '}
                      {copy.remedy}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <>
                The matches can't all fit inside their windows on the tables
                available. Add tables, widen a pool window, or trim an event's
                field — then run the scheduler again.
              </>
            )}
          </Line>
        </div>
      )
    }
    case 'failed':
      return (
        <div data-testid="solve-strip-failed">
          <Line
            icon={<CircleX size={18} />}
            tint="text-[color:var(--loss)]"
            title="The scheduler hit a problem"
          >
            The run broke before it could finish — the schedule is unchanged. Run
            it again.
            {/* The server's own account, as detail under the client's headline —
                the actionable content, the draw-panel precedent. */}
            {state.error && (
              <span className="mt-0.5 block font-mono text-[11px] text-[color:var(--fg-3)]">
                {state.error}
              </span>
            )}
          </Line>
        </div>
      )
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }
}

/**
 * Overlapping in-progress matches the solve **tolerated and reported** (ADR
 * "overlapping-in-progress-matches-are-tolerated-and-reported") — a *placed board
 * with a caution*, deliberately distinct from the `infeasible` "nothing placed"
 * banner: the board is fine, but two live matches contradict each other on a
 * table or a human, and only the director can fix it. A warn-toned `Alert` (the
 * pools double-booked precedent), rendered only when the (always-present) list is
 * non-empty. Orthogonal to the solve's state, so it renders under whatever the
 * `SolveState` line above says.
 */
const ConflictWarning = ({ solve }: { solve: ScheduleSolve | null }) => {
  if (solve === null || solve.placementConflicts.length === 0) return null
  return (
    <Alert
      data-testid="solve-strip-conflicts"
      className="mt-2.5 border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10"
    >
      <TriangleAlert className="text-[color:var(--warn)]" />
      <AlertTitle className="text-[color:var(--warn)]">
        Overlapping matches on the board
      </AlertTitle>
      <AlertDescription className="text-[color:var(--fg-3)]">
        <ul className="space-y-1">
          {solve.placementConflicts.map((conflict, i) => (
            <li key={placementConflictKey(conflict, i)}>
              {placementConflictSentence(conflict)}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

/**
 * The Schedule tab's **solve strip** (ADR "the schedule is solved; the call is
 * pinned"): what the latest run of the placement solver has to say, plus the
 * owner's **Run scheduler** button.
 *
 * Every status is a *designed* state of one sum type (`solveStripState`) —
 * including `infeasible`, which is the point of pre-live solves, and "no solve
 * yet", which is the state every tournament is born in. Raw wire strings never
 * reach this surface: triggers and verdicts render through the copy tables in
 * `../data/solve`, and a refused run renders through `runSchedulerNotice`. The one
 * exception is a `failed` run's `error` sentence, shown as detail under the
 * client's own headline because it is the actionable content.
 *
 * The button is **withheld while a solve is in flight** (queued/running): the
 * server would absorb the click anyway (one solve per tournament), so offering it
 * would be offering a no-op. `submitting` guards the gap before the queued row
 * arrives — the double-click family (#436).
 */
export const SolveStrip = ({ solve, canEdit, onRun }: SolveStripProps) => {
  // The last refusal, in words. Cleared when a new attempt starts — a notice
  // about the click before last is worse than none. (The `LifecycleActions`
  // pattern, which is the page's other inline-refusal surface.)
  const [notice, setNotice] = useState<RunSchedulerNotice | null>(null)
  // The strip's OWN in-flight latch: set synchronously on click, so the second
  // click of a double-click cannot land in a render gap (#436 family). It spans
  // the whole `onRun` promise, so it also covers the mutation's own in-flight
  // window — no prop needed for that.
  const [submitting, setSubmitting] = useState(false)

  const busy = submitting || solveInFlight(solve)

  const run = async () => {
    if (busy) return
    setSubmitting(true)
    setNotice(null)
    try {
      await onRun()
    } catch (error) {
      // `mutateAsync` rejects; this notice IS the error surface (no toast).
      setNotice(runSchedulerNotice(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section data-testid="solve-strip" className="mb-6">
      <Card className="gap-0 p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          {/* The state is data that changes under polling; announce it politely
              rather than making a reader re-scan the page. */}
          <div aria-live="polite" className="min-w-0">
            <SolveState solve={solve} canEdit={canEdit} />
          </div>
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              data-testid="run-scheduler"
              disabled={busy}
              onClick={run}
            >
              {busy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Play size={14} />
              )}
              Run scheduler
            </Button>
          )}
        </div>
      </Card>

      {/* A placed board's caution: overlapping in-progress matches the solve
          tolerated rather than blanked the board over. Orthogonal to the state
          above, so it rides under whatever the strip says. */}
      <ConflictWarning solve={solve} />

      {/* The refusal, where the click was — an `Alert` (the app talking back),
          never a toast that leaves in four seconds. */}
      {notice && (
        <Alert
          variant="destructive"
          data-testid="run-scheduler-notice"
          className="mt-2.5"
        >
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.description}</AlertDescription>
        </Alert>
      )}
    </section>
  )
}
