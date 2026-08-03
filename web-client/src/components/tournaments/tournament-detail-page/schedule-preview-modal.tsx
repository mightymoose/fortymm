import { useEffect, useRef, useState } from 'react'
import { Loader2, RotateCw, TriangleAlert } from 'lucide-react'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { z } from 'zod'

import { ApiError, extractDetail } from '@/api/client'
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

import { type DrawTypeOption, drawTypeSchema } from '../data/draw-types'
import { labelFor } from '../data/options'
import {
  type PreviewEnqueued,
  type PreviewFixture,
  type PreviewJobState,
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
import { fmt12 } from '../data/timeline'
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
  /** The **served** draw-type catalogue (ADR 20260726) — the one place a draw
   * type's words live. Used to name the offending draw type when the enqueue is
   * refused with `unsupported_draw_type`, so the notice reads "Single
   * elimination" and not the wire slug `single-elim`. Pass `[]` where the
   * catalogue was not sent; the notice degrades rather than leaking a slug. */
  drawTypes: DrawTypeOption[]
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

/** The estimated-finish instant as a **venue-local** wall-clock (`"6:30 PM"`) —
 * consistent with how the real schedule renders a projected time (`fmt12`, ADR
 * "tournament times are timezone-aware instants"). The server sends a tz-aware
 * datetime whose date/time components are already the venue wall-clock (it anchored
 * the frame in the event's timezone), so the client reads that wall-clock straight
 * off the string rather than doing any timezone math or picking a zone of its own.
 * `null` for a string that doesn't carry a `T`HH:MM (an unexpected shape the caller
 * then drops the clause for). */
function fmtPreviewFinish(iso: string): string | null {
  const m = /T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return null
  return fmt12(Number(m[1]) * 60 + Number(m[2]))
}

/** The four refusals the enqueue POST can answer with, each a designed notice in
 * the director's words — never the server's prose (`DEFINITION_OF_COMPLETE.md`).
 * The trigger button is NOT gated on draw type, so a `422` (only round-robin is
 * previewable today) is a real, reachable refusal, not a bug. */
interface PreviewEnqueueNotice {
  title: string
  description: string
}

/** The `code` the enqueue `422` carries when an event's draw type is one the table
 * scheduler cannot place (`UnsupportedDrawTypeRefusal` in `schema.d.ts`). This — not
 * the sentence beside it — is what the client switches on: matching on prose is the
 * bug ADR-0968 was written to kill, and the server's `message` is explicitly "fallback
 * prose, never a contract". */
const UNSUPPORTED_DRAW_TYPE_CODE = 'unsupported_draw_type'

/** A **coded** refusal body, PARSED not cast (`.claude/rules/parse-at-boundaries.md`):
 * `ApiError.body` is `unknown`, and an error body is untrusted input like any other.
 *
 * Three deliberate loosenesses, each buying a degradation path:
 *
 * - `code` is a plain `string`, not an enum — a code minted after this build shipped
 *   must still *decode* so it can fall back to `message`, rather than fail the parse
 *   and lose the server's only words.
 * - `message` is nullish — the fallback prose is what a code we don't know degrades
 *   to, so its absence is a case, not a malformation.
 * - `draw_type` is `unknown` here and narrowed below: the fact only means something
 *   for the code that carries it, so requiring it of *every* coded refusal would make
 *   an unrelated code unparseable.
 *
 * Anything that isn't this shape at all (a plain-string `detail`, FastAPI's validation
 * array, no body) simply fails the parse and takes the generic copy. */
const codedRefusalSchema = z.object({
  detail: z.object({
    code: z.string().min(1),
    draw_type: z.unknown().optional(),
  }),
})

/** The 422 copy for a refusal this build has no better words for: the honest generic,
 * naming nothing (it is what a director saw for *every* 422 before #1221). */
const UNPREVIEWABLE_GENERIC =
  'A preview runs over a round-robin draw. This tournament uses a draw type the preview does not support yet.'

/**
 * The sentence under "This schedule can't be previewed yet" — the #1221 fix.
 *
 * The server sends the offending draw type **structurally** (`detail.draw_type`, the
 * enum's hyphenated wire slug) beside a machine-readable `code`, so the client names
 * it in the director's own words instead of showing generic copy that, with four
 * events, cannot say which one is the blocker. The label comes from the **served**
 * draw-type catalogue through `labelFor` — the same lookup the event editor's picker
 * and `drawTypeFreeze` use — so there is exactly one place a draw type's words live.
 *
 * Three fallbacks, in descending order of what we know:
 *
 * 1. A recognised code + a slug this build knows + a catalogue row for it → name it.
 *    Never the raw slug: "…uses a “single-elim” draw" is the leak `labelFor` exists to
 *    prevent (`drawTypeFreeze`, `data/draw.ts`).
 * 2. **Any other refusal we have no better words for → the server's own sentence**,
 *    read through `extractDetail`, which is the one reader for "what did the server
 *    say?" and already handles both wire shapes (a plain-string `detail` and a coded
 *    `detail.message`). This arm is deliberately *not* limited to coded refusals: the
 *    draw-refusal mapper still answers with prose for `DegenerateDraw`, which genuinely
 *    reaches this route (an `rr-then-ko` event whose qualifiers exceed its smallest
 *    pool — `app/schedule_preview.py` plans the full draw and lets that refusal
 *    propagate). Falling through to the generic there would tell a director their
 *    *draw type* is unsupported when the real cause is their entrant numbers — naming
 *    the wrong thing, while the sentence naming the right one sat unread.
 * 3. No sentence at all (no body, an empty detail) → the generic.
 */
function unpreviewableDrawTypeCopy(
  body: unknown,
  drawTypes: DrawTypeOption[],
): string {
  const parsed = codedRefusalSchema.safeParse(body)
  if (parsed.success && parsed.data.detail.code === UNSUPPORTED_DRAW_TYPE_CODE) {
    const slug = drawTypeSchema.safeParse(parsed.data.detail.draw_type)
    const label = slug.success ? labelFor(drawTypes, slug.data, null) : null
    if (label !== null) {
      return `A preview runs over a round-robin draw. This tournament has a “${label}” event, which the preview does not support yet.`
    }
  }
  return extractDetail(body) ?? UNPREVIEWABLE_GENERIC
}

/** Map an enqueue refusal to its inline notice. `422` — the draw type can't be
 * previewed yet (only round-robin is), named from the refusal's coded `draw_type`;
 * `409` — the tournament is no longer pre-live; `429` — the single preview slot is
 * busy (retry in a moment); `403` — not the owner; status `0` — the server was never
 * reached; anything else — the honest generic. */
function previewEnqueueNotice(
  error: unknown,
  drawTypes: DrawTypeOption[],
): PreviewEnqueueNotice {
  if (error instanceof ApiError) {
    if (error.status === 422) {
      return {
        title: "This schedule can't be previewed yet",
        description: unpreviewableDrawTypeCopy(error.body, drawTypes),
      }
    }
    if (error.status === 409) {
      return {
        title: 'The preview is only for a pre-live schedule',
        description:
          'This tournament is already live, so there is nothing to preview — the real schedule is on the board.',
      }
    }
    if (error.status === 429) {
      return {
        title: 'A preview is already running',
        description:
          'Only one preview runs at a time. Wait a moment for the current one to finish, then try again.',
      }
    }
    if (error.status === 403) {
      return {
        title: 'The preview wasn’t run',
        description: 'Only the tournament owner can preview the schedule.',
      }
    }
    if (error.status === 0) {
      return {
        title: "Couldn't reach the server",
        description: 'Check your connection and try the preview again.',
      }
    }
  }
  return {
    title: "Couldn't start the preview",
    description: 'Something went wrong on our side. Try again in a moment.',
  }
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
    // The human pool name (`"Pool A"`), never the namespaced `{event}:{pool}`
    // composite the solver keys by — the card heads with a name a director reads.
    poolName: fixture.poolName,
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

/** True when a single per-event override the director typed cannot drive an honest
 * re-run: an emptied field (`NaN`) or a sub-2 count (a round-robin needs two
 * players). The displayed value falls back to the drawn field size
 * (`overrides[id] ?? fieldSize`), so an *untouched* field is never "invalid" — only
 * a value they actually typed is (`undefined` means untouched). */
function isInvalidOverride(typed: number | undefined): boolean {
  return typed !== undefined && (!Number.isFinite(typed) || typed < 2)
}

/** The inline message shown in red beneath an override input that can't drive a
 * re-run — so the guard is legible ("which field, and why") instead of a silently
 * dead Re-run button (`web-client/CLAUDE.md`, `## Forms`). */
const OVERRIDE_ERROR = 'Enter a number of at least 2'

/** True when *any* per-event override is invalid — gates the Re-run button. */
function hasInvalidOverride(
  fieldSummaries: PreviewEnqueued['fieldSummaries'],
  overrides: Record<string, number>,
): boolean {
  return fieldSummaries.some((s) => isInvalidOverride(overrides[s.eventId]))
}

interface PreviewBodyProps {
  events: PreviewEventMeta[]
  drawTypes: DrawTypeOption[]
  enqueue: ReturnType<typeof useEnqueueSchedulePreview>
  poll: UseQueryResult<PreviewJobState>
  overrides: Record<string, number>
  setOverrides: React.Dispatch<React.SetStateAction<Record<string, number>>>
  onRerun: () => void
  onRetry: () => void
  onClose: () => void
}

/**
 * The live body of the preview, mounted only while the dialog is open (it lives
 * inside `DialogContent`, which radix renders only when open). The enqueue itself is
 * driven from the dialog-**open event** up in `SchedulePreviewModal` — never a mount
 * effect here — so it fires exactly once per open even under StrictMode (which
 * `npm run dev` and the composed e2e stack both use), instead of burning a second
 * preview worker slot on a phantom job.
 *
 * The whole point is that this is never a blank spinner: the enqueue's *instant
 * structure* (the synthetic field sizes, the match/bye counts, and the grid
 * skeleton) renders the moment the 202 lands, only the verdict + placements stream
 * in when the polled solve returns (ADR "instant structure and a streamed solve") —
 * and a **refused** enqueue is surfaced as an actionable inline error, never an
 * infinite "Preparing preview…".
 */
const PreviewBody = ({
  events,
  drawTypes,
  enqueue,
  poll,
  overrides,
  setOverrides,
  onRerun,
  onRetry,
  onClose,
}: PreviewBodyProps) => {
  const enqueued: PreviewEnqueued | undefined = enqueue.data

  const status = poll.data?.status
  const result = poll.data?.result ?? null
  const token = enqueued?.token ?? null

  const elapsed = useElapsedSeconds(status === 'running')

  const eventName = (id: string) => events.find((e) => e.id === id)?.name ?? id

  // Refused loud (ADR): the enqueue POST was rejected (422 unpreviewable draw type,
  // 409 not pre-live, 429 rate-limited, 403, network), so there is no structure to
  // render — show the actionable notice with a Close/Retry, never a permanent
  // spinner.
  if (!enqueued && enqueue.isError) {
    const notice = previewEnqueueNotice(enqueue.error, drawTypes)
    return (
      <Alert variant="destructive" data-testid="preview-enqueue-error" className="mt-2">
        <TriangleAlert size={16} />
        <AlertTitle>{notice.title}</AlertTitle>
        <AlertDescription className="flex flex-col gap-3">
          {notice.description}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="preview-enqueue-retry"
              onClick={onRetry}
              disabled={enqueue.isPending}
            >
              <RotateCw size={14} />
              Try again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="preview-enqueue-close"
              onClick={onClose}
            >
              Close
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    )
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

  const finishClock =
    result && result.estimatedFinish ? fmtPreviewFinish(result.estimatedFinish) : null

  const rerunDisabled =
    enqueue.isPending || hasInvalidOverride(enqueued.fieldSummaries, overrides)

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
                {finishClock && ` · finishes ${finishClock}`}
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
        {enqueued.fieldSummaries.map((s) => {
          const typed = overrides[s.eventId]
          // Fall back to the drawn field size until the director types; render an
          // emptied field as blank (not the string "NaN").
          const shown = typed ?? s.fieldSize
          const invalid = isInvalidOverride(typed)
          const errorId = `preview-override-error-${s.eventId}`
          return (
            <label
              key={s.eventId}
              className="flex flex-col gap-1 text-[12px] text-[color:var(--fg-2)]"
            >
              {eventName(s.eventId)}
              <Input
                type="number"
                min={2}
                aria-label={`Field size for ${eventName(s.eventId)}`}
                // The guard is spoken, not silent: an invalid value flags the input
                // (`aria-invalid`) and points at its own red message below
                // (`aria-describedby`), the same way the event editor's numeric
                // fields surface a bad value (`event-editor/basics-section.tsx`).
                aria-invalid={invalid}
                aria-describedby={invalid ? errorId : undefined}
                className="w-24"
                value={Number.isFinite(shown) ? String(shown) : ''}
                onChange={(e) =>
                  setOverrides((prev) => ({
                    ...prev,
                    // An empty field is `NaN`, not `0` — a blanked input must not
                    // silently drive a re-run with a broken count (it disables
                    // Re-run instead).
                    [s.eventId]: e.target.value === '' ? NaN : Number(e.target.value),
                  }))
                }
              />
              {invalid && (
                <p
                  id={errorId}
                  data-testid={errorId}
                  className="text-[11px] text-[color:var(--loss)]"
                >
                  {OVERRIDE_ERROR}
                </p>
              )}
            </label>
          )
        })}
        <Button variant="outline" onClick={onRerun} disabled={rerunDisabled}>
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
 * The modal is persistently mounted for the owner and takes `open`/`onOpenChange`.
 * It drives the whole preview: it **enqueues on the open transition** (an event, not
 * a mount effect — so it fires exactly once per open, never a StrictMode phantom
 * double-POST), resets state on each open, streams the labeled solve, offers the
 * per-event override + Re-run, and fires a best-effort cancel on close. A refused
 * enqueue is surfaced as an inline error (Close/Retry), never an infinite spinner.
 */
export const SchedulePreviewModal = ({
  open,
  onOpenChange,
  tournamentId,
  events,
  drawTypes,
}: SchedulePreviewModalProps) => {
  const enqueue = useEnqueueSchedulePreview(tournamentId)
  const cancel = useCancelSchedulePreview(tournamentId)

  const enqueued = enqueue.data
  const token = enqueued?.token ?? null

  const poll = useQuery(schedulePreviewQueryOptions(tournamentId, token))

  // The per-event override map the director edits; empty until they touch a field,
  // so the displayed value falls back to the size the preview actually drew to.
  // Reset to `{}` on every open (below), so a re-open starts clean.
  const [overrides, setOverrides] = useState<Record<string, number>>({})

  // Live refs for the fire-and-forget cancel: read from a cleanup/handler without
  // re-subscribing. Kept current in a commit-time effect (never during render).
  const tokenRef = useRef<string | null>(null)
  const cancelRef = useRef(cancel.mutate)
  useEffect(() => {
    tokenRef.current = token
    cancelRef.current = cancel.mutate
  })

  // Enqueue from the OPEN transition, not a mount effect. `SchedulePreviewModal` is
  // persistently mounted for the owner, so this effect fires on the `open` prop
  // going false→true — a dependency *change*, which StrictMode does NOT
  // double-invoke (it only double-invokes effects on mount). The `wasOpen` ref
  // (set in the effect body, never only in cleanup — repo memory "StrictMode
  // latches a cleanup-only ref") keeps the initial-open case (a test/route that
  // renders `open` already true) to a single enqueue too. On close it fires the
  // best-effort cancel that reclaims the worker's single throttled slot (ADR
  // "cancel-on-close").
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      wasOpen.current = true
      setOverrides({})
      enqueue.reset()
      enqueue.mutate({})
    } else if (!open && wasOpen.current) {
      wasOpen.current = false
      const live = tokenRef.current
      if (live) cancelRef.current(live)
    }
    // `enqueue.mutate`/`.reset` are stable; the open transition is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Cancel any still-live token if the modal unmounts while open (navigation away,
  // owner-flag flip) — the close-transition above handles the ordinary close.
  useEffect(
    () => () => {
      const live = tokenRef.current
      if (live) cancelRef.current(live)
    },
    [],
  )

  const rerun = () => {
    if (!enqueued) return
    if (hasInvalidOverride(enqueued.fieldSummaries, overrides)) return
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Preview schedule</DialogTitle>
          <DialogDescription>
            A dry run over a synthetic field — no entrants are created, nothing is
            saved.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <PreviewBody
            events={events}
            drawTypes={drawTypes}
            enqueue={enqueue}
            poll={poll}
            overrides={overrides}
            setOverrides={setOverrides}
            onRerun={rerun}
            onRetry={() => {
              enqueue.reset()
              enqueue.mutate({})
            }}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
