import { useEffect, useRef, useState } from 'react'
import { Loader2, RotateCw, TriangleAlert } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

import {
  type PreviewEnqueued,
  type PreviewFixture,
  type PreviewVerdict,
  schedulePreviewQueryOptions,
  useCancelSchedulePreview,
  useEnqueueSchedulePreview,
} from '../data/preview'
import {
  fmtTableTime,
  infeasibilityReasonCopy,
  infeasibilityReasonKey,
} from '../data/solve'
import { timeOfDay } from '../data/timeline'
import type { UnscheduledFixture } from '../data/timeline'
import { UnscheduledRail } from './schedule-tab/unscheduled-rail'

/** The event metadata the override control needs — just the id→name mapping, so a
 * synthetic field row reads "Open Singles" not `ev-1`. Passed in by the caller
 * (chore 3c hands it the tournament's events); the authoritative *sizes* come from
 * the enqueue response, not this list. */
export interface PreviewEventMeta {
  id: string
  name: string
}

export interface SchedulePreviewModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tournamentId: string
  /** The tournament's events, for labeling the per-event override control. */
  events: PreviewEventMeta[]
}

/** The four preview verdicts in the director's words — never the raw enum
 * (`DEFINITION_OF_COMPLETE.md`: raw API strings never reach the UI). `infeasible`
 * is a designed outcome ("proved it doesn't fit"), not an error; `unknown` is "the
 * cap ran out", never "your day doesn't fit". */
const PREVIEW_VERDICT_LABEL: Record<PreviewVerdict, string> = {
  optimal: 'Best possible plan',
  feasible: 'Good plan, found under the time cap',
  infeasible: "Doesn't fit",
  unknown: "Couldn't decide within the time cap",
}

/** `placeholder-3` → `Placeholder 3` — the opaque synthetic id shown as the
 * director reads a stand-in (ADR "the synthetic ids are shown as `Placeholder N`"). */
function placeholderName(id: string): string {
  return `Placeholder ${id.replace(/^placeholder-/, '')}`
}

/** An `n`-player round-robin byes every player once when `n` is odd (one bye per
 * round), nobody when even — the same rule the solver applies, computed here so the
 * count line is honest from the first frame, before the result lands. */
function roundRobinByes(n: number): number {
  return n % 2 === 1 ? n : 0
}

/** One synthetic fixture → the `UnscheduledFixture` the reused schedule grid renders,
 * with `Placeholder N` names so the preview grid looks identical to the real one. A
 * preview carries no per-fixture placement, so every fixture is a structural card. */
function fixtureToRailItem(
  fixture: PreviewFixture,
  eventName: (id: string) => string,
): UnscheduledFixture {
  return {
    fixtureId: fixture.fixtureId,
    eventName: eventName(fixture.eventId),
    poolName: fixture.poolId,
    label: `${placeholderName(fixture.playerAId)} vs ${placeholderName(fixture.playerBId)}`,
    tableLabel: null,
    statusLabel: '',
  }
}

/** The synthetic grid, grouped by event and rendered through the SAME
 * `UnscheduledRail` the real schedule uses — so preview and reality look identical
 * (ADR "reuses the real schedule grid components with `Placeholder N` names"). */
const PreviewGrid = ({
  fixtures,
  eventName,
}: {
  fixtures: PreviewFixture[]
  eventName: (id: string) => string
}) => {
  const byEvent = new Map<string, PreviewFixture[]>()
  for (const fixture of fixtures) {
    const bucket = byEvent.get(fixture.eventId) ?? []
    bucket.push(fixture)
    byEvent.set(fixture.eventId, bucket)
  }
  return (
    <div data-testid="preview-grid" className="mt-4 flex flex-col gap-4">
      {[...byEvent.entries()].map(([eventId, group]) => (
        <section key={eventId} data-testid={`preview-event-${eventId}`}>
          <h4 className="mb-2 font-display text-[18px] tracking-[0.02em] text-[color:var(--fg-1)]">
            {eventName(eventId)}
          </h4>
          <UnscheduledRail
            items={group.map((f) => fixtureToRailItem(f, eventName))}
          />
        </section>
      ))}
    </div>
  )
}

/** A seconds counter that ticks only while `running` — the elapsed clock the
 * "Solving schedule… (Ns)" wait label shows. `setSec` runs inside the interval
 * callback (not synchronously in the effect), so it re-renders once a second
 * without a busy loop. */
function useElapsedSeconds(running: boolean): number {
  const [sec, setSec] = useState(0)
  useEffect(() => {
    if (!running) return
    const startedAt = Date.now()
    const id = setInterval(
      () => setSec(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    )
    return () => clearInterval(id)
  }, [running])
  return sec
}

/**
 * The live body of the preview, mounted only while the dialog is open (it lives
 * inside `DialogContent`, which radix renders only when open) — so it enqueues on
 * mount and **cancels on unmount**, and a re-open starts a fresh preview with clean
 * state, with no set-state-in-an-effect reset dance.
 *
 * The whole point is that this is never a blank spinner: the enqueue's *instant
 * structure* (the synthetic field sizes, the match/bye counts, and the grid
 * skeleton) renders the moment the 202 lands, and only the verdict + placements
 * stream in when the polled solve returns (ADR "instant structure and a streamed
 * solve").
 */
const PreviewBody = ({
  tournamentId,
  events,
}: {
  tournamentId: string
  events: PreviewEventMeta[]
}) => {
  const enqueue = useEnqueueSchedulePreview(tournamentId)
  const cancel = useCancelSchedulePreview(tournamentId)

  const enqueued: PreviewEnqueued | undefined = enqueue.data
  const token = enqueued?.token ?? null

  const poll = useQuery(schedulePreviewQueryOptions(tournamentId, token))
  const status = poll.data?.status
  const result = poll.data?.result ?? null

  const elapsed = useElapsedSeconds(status === 'running')

  // The per-event override map the director edits; empty until they touch a field,
  // so the displayed value falls back to the size the preview actually drew to
  // (`overrides[id] ?? fieldSize`) — no seeding state in an effect.
  const [overrides, setOverrides] = useState<Record<string, number>>({})

  // Enqueue exactly once on mount. Guarded by a ref (set in the effect body, not a
  // cleanup) so StrictMode's double-invoke doesn't fire two previews.
  const enqueuedOnce = useRef(false)
  useEffect(() => {
    if (enqueuedOnce.current) return
    enqueuedOnce.current = true
    enqueue.mutate({})
    // enqueue.mutate is stable; the guard makes this a strict once-on-mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cancel-on-close: closing the dialog unmounts this body, and its cleanup fires a
  // best-effort cancel for the live token (ADR "cancel-on-close"). Fire-and-forget —
  // read via refs so the cleanup never re-subscribes and never blocks the close. The
  // refs are kept current in a commit-time effect (never assigned during render).
  const tokenRef = useRef<string | null>(null)
  const cancelRef = useRef(cancel.mutate)
  useEffect(() => {
    tokenRef.current = token
    cancelRef.current = cancel.mutate
  })
  useEffect(
    () => () => {
      const live = tokenRef.current
      if (live) cancelRef.current(live)
    },
    [],
  )

  const eventName = (id: string) =>
    events.find((e) => e.id === id)?.name ?? id

  const rerun = () => {
    if (!enqueued) return
    const merged = Object.fromEntries(
      enqueued.fieldSummaries.map((s) => [
        s.eventId,
        overrides[s.eventId] ?? s.fieldSize,
      ]),
    )
    // Reclaim the current job's throttled slot before queuing the next one.
    if (token) cancel.mutate(token)
    enqueue.mutate({ overrides: merged })
  }

  if (!enqueued) {
    return (
      <div
        data-testid="preview-preparing"
        className="flex items-center gap-2 py-8 text-[13px] text-[color:var(--fg-3)]"
      >
        <Loader2 size={16} className="animate-spin" />
        Preparing preview…
      </div>
    )
  }

  const fieldSummaryText = enqueued.fieldSummaries
    .map((s) => `${eventName(s.eventId)} ${s.fieldSize}`)
    .join(', ')

  const matchCount = result ? result.totalMatches : enqueued.fixtures.length
  const byeCount = result
    ? result.totalByes
    : enqueued.fieldSummaries.reduce((sum, s) => sum + roundRobinByes(s.fieldSize), 0)

  const inFlight = token !== null && status !== 'done' && status !== 'failed'
  const waitLabel = !inFlight
    ? null
    : status === 'queued'
      ? 'Waiting for an in-progress solve to finish…'
      : status === 'running'
        ? `Solving schedule… (${elapsed}s)`
        : // enqueued, but the first poll has not landed yet.
          'Starting the solve…'

  const infeasible = result !== null && !result.fits

  return (
    <div data-testid="schedule-preview">
      {/* The instant structure — the fake field and its match/bye counts, rendered
          from the enqueue 202 before any solve result lands. */}
      <Card className="gap-2 p-4">
        <div
          data-testid="preview-field-summary"
          className="text-[13px] font-medium text-[color:var(--fg-1)]"
        >
          Synthetic field: {fieldSummaryText}
        </div>
        <div
          data-testid="preview-counts"
          className="font-mono text-[12px] tabular-nums text-[color:var(--fg-2)]"
        >
          {matchCount} matches · {byeCount} byes
        </div>

        {/* The verdict + estimated duration + peak tables — streams in on `done`. */}
        {result && (
          <div
            data-testid="preview-verdict"
            className="text-[13px] font-semibold text-[color:var(--fg-1)]"
          >
            {PREVIEW_VERDICT_LABEL[result.verdict]}
            {result.estimatedDurationMin !== null && (
              <span className="font-normal text-[color:var(--fg-2)]">
                {' '}
                · about {fmtTableTime(result.estimatedDurationMin)}
                {result.estimatedFinish &&
                  ` · finishes ${timeOfDay(result.estimatedFinish)}`}
              </span>
            )}
            <span className="font-normal text-[color:var(--fg-2)]">
              {' '}
              · peak {result.peakConcurrentTables} tables
            </span>
          </div>
        )}

        {/* The labeled wait — queued vs running, never a bare spinner. */}
        {waitLabel && (
          <div
            data-testid="preview-wait"
            className="flex items-center gap-2 text-[12px] text-[color:var(--fg-3)]"
          >
            <Loader2 size={14} className="animate-spin" />
            {waitLabel}
          </div>
        )}
      </Card>

      {/* The per-event override control — defaults to each event's synthetic field
          size, Re-run streams a fresh solve. */}
      <div
        data-testid="preview-overrides"
        className="mt-4 flex flex-wrap items-end gap-3"
      >
        {enqueued.fieldSummaries.map((s) => (
          <label
            key={s.eventId}
            className="flex flex-col gap-1 text-[12px] text-[color:var(--fg-2)]"
          >
            {eventName(s.eventId)}
            <Input
              type="number"
              min={2}
              aria-label={`Field size for ${eventName(s.eventId)}`}
              className="w-24"
              value={String(overrides[s.eventId] ?? s.fieldSize)}
              onChange={(e) =>
                setOverrides((prev) => ({
                  ...prev,
                  [s.eventId]: Number(e.target.value),
                }))
              }
            />
          </label>
        ))}
        <Button variant="outline" onClick={rerun} disabled={enqueue.isPending}>
          <RotateCw size={14} />
          Re-run
        </Button>
      </div>

      {/* A failed job — honest, with the server's one actionable sentence. */}
      {status === 'failed' && (
        <Alert variant="destructive" data-testid="preview-failed" className="mt-4">
          <TriangleAlert size={16} />
          <AlertTitle>The preview didn't finish</AlertTitle>
          <AlertDescription>
            {poll.data?.error ?? 'Something went wrong. Try running it again.'}
          </AlertDescription>
        </Alert>
      )}

      {/* Infeasible: the actionable reasons INSTEAD of a grid (there is no plan to
          draw). Otherwise the synthetic grid — a skeleton while the solve runs, the
          same `Placeholder N` cards once it lands. */}
      {infeasible ? (
        <div data-testid="preview-infeasible" className="mt-4 flex flex-col gap-3">
          {result.infeasibilityReasons.map((reason, i) => {
            const copy = infeasibilityReasonCopy(reason)
            return (
              <Alert
                key={infeasibilityReasonKey(reason, i)}
                variant="destructive"
              >
                <TriangleAlert size={16} />
                <AlertTitle>{copy.sentence}</AlertTitle>
                <AlertDescription>{copy.remedy}</AlertDescription>
              </Alert>
            )
          })}
        </div>
      ) : (
        <PreviewGrid fixtures={enqueued.fixtures} eventName={eventName} />
      )}

      {/* The always-present honest-notes strip: the disjoint-field caveat + the
          synthetic counts assumed (the result's notes), over the fake-field line. */}
      <div
        data-testid="preview-notes"
        className="mt-4 border-t border-[color:var(--border-subtle)] pt-3 text-[11px] text-[color:var(--fg-3)]"
      >
        <p>A preview is optimistic: {fieldSummaryText}.</p>
        {result?.notes.map((note, i) => <p key={i}>{note}</p>)}
      </div>
    </div>
  )
}

/**
 * The **Preview schedule** modal (ADR "a schedule preview is a non-persistent solve
 * over a synthetic field") — a pre-live dialog that shows what a synthetic field's
 * schedule would look like before anyone has registered.
 *
 * The trigger button (owner-viewed, pre-live only) is a later chore; this modal
 * takes `open`/`onOpenChange` and drives the whole preview: enqueue on open, the
 * instant structure from the first frame, a labeled streamed solve, a per-event
 * override + Re-run, and a best-effort cancel on close. The live logic lives in
 * `PreviewBody`, which radix mounts only while open — so opening enqueues and
 * closing cancels, with no manual reset.
 */
export const SchedulePreviewModal = ({
  open,
  onOpenChange,
  tournamentId,
  events,
}: SchedulePreviewModalProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[720px]">
      <DialogHeader>
        <DialogTitle>Preview schedule</DialogTitle>
        <DialogDescription>
          A dry run over a synthetic field — no entrants are created, nothing is
          saved.
        </DialogDescription>
      </DialogHeader>
      {open && <PreviewBody tournamentId={tournamentId} events={events} />}
    </DialogContent>
  </Dialog>
)
