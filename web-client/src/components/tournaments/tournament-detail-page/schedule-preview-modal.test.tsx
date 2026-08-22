import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'

import { render, screen, waitFor } from '@/test/utilities'
import {
  mockSchedulePreviewCancelEndpoint,
  mockSchedulePreviewEnqueueEndpoint,
  mockSchedulePreviewPollEndpoint,
} from '@/mocks/endpoints/tournaments/preview.endpoint'
import {
  buildInfeasiblePreviewResult,
  buildPreviewJobState,
  buildPreviewResult,
} from '@/mocks/factories/tournaments/preview.factory'
import { server } from '@/mocks/server'
import {
  enqueuePreview,
  resetSchedulePreviewStore,
} from '@/mocks/schedule-preview-store'

import { SchedulePreviewModal } from './schedule-preview-modal'
import { buildSchedulePreviewModalProps } from './schedule-preview-modal.factory'
import { schedulePreviewModalPage } from './schedule-preview-modal.page'

// The default handlers walk a token queued → running → done over three polls, so
// each test starts from an empty preview store — a token minted in one test must
// not leak its poll count (or its counter) into the next.
beforeEach(() => resetSchedulePreviewStore())

describe('SchedulePreviewModal', () => {
  // The streaming point: the instant structure (fake field + counts + grid
  // skeleton) is on screen BEFORE the solve result resolves, then the verdict fills
  // in on its own as the poll walks queued → running → done.
  it('renders the instant structure first, then streams the solve result in', async () => {
    schedulePreviewModalPage.render()

    // The fake field and its match/bye counts, straight off the enqueue 202 —
    // a four-player round robin is six matches, no byes.
    const summary = await schedulePreviewModalPage.findFieldSummary()
    expect(summary).toHaveTextContent('Open Singles 4')
    expect(schedulePreviewModalPage.queryCounts()).toHaveTextContent(
      '6 matches · 0 byes',
    )

    // The grid skeleton renders the drawn fixtures through the reused schedule grid,
    // with `Placeholder N` names.
    expect(
      await screen.findByText('Placeholder 1 vs Placeholder 2'),
    ).toBeInTheDocument()

    // …and at this frame the SOLVE has not landed: no verdict yet, a labeled wait
    // is showing. This is the whole no-blank-spinner point.
    expect(schedulePreviewModalPage.queryVerdict()).toBeNull()
    expect(schedulePreviewModalPage.queryWait()).toBeInTheDocument()

    // The result streams in on its own — the verdict + estimated duration + peak
    // tables fill the summary, and the wait clears.
    const verdict = await schedulePreviewModalPage.findVerdict()
    expect(verdict).toHaveTextContent('Best possible plan')
    expect(verdict).toHaveTextContent('about 3h')
    expect(verdict).toHaveTextContent('peak 2 tables')
    await waitFor(() =>
      expect(schedulePreviewModalPage.queryWait()).toBeNull(),
    )
    // The grid is still there, still `Placeholder N`.
    expect(
      screen.getByText('Placeholder 1 vs Placeholder 2'),
    ).toBeInTheDocument()
  })

  // The StrictMode regression (repo memory "StrictMode latches a cleanup-only ref;
  // only npm run dev / e2e catch it"): `npm run dev` and the composed e2e stack both
  // render under `<StrictMode>`, which double-invokes every mount effect
  // (setup→cleanup→setup). A once-on-mount enqueue whose result rode a torn-down
  // MutationObserver never populated `enqueue.data`, so the modal hung forever on
  // "Preparing preview…" with zero poll requests. vitest and `vite build` don't use
  // StrictMode, so every other test in this file missed it — the wrapper below is
  // the whole point. This must reach the streamed result, not the spinner.
  it('reaches the streamed result under StrictMode when opened, enqueuing exactly once', async () => {
    // Count the enqueue POSTs while still walking the store's default queued →
    // running → done, so the assertion covers both the no-stuck-spinner intent AND
    // the double-POST regression: firing from the open *transition* (not a mount
    // effect) must not burn a phantom second preview slot under StrictMode.
    let enqueueCalls = 0
    mockSchedulePreviewEnqueueEndpoint(server, async ({ request }) => {
      enqueueCalls += 1
      const body = (await request.json()) as { overrides?: Record<string, number> } | null
      return HttpResponse.json(enqueuePreview(body ?? null), { status: 202 })
    })
    // Resolve the poll to `done` at once — this test is about the enqueue firing
    // once and reaching a result, not the queued→running→done cadence, so skip the
    // multi-poll walk that would otherwise race the test budget.
    mockSchedulePreviewPollEndpoint(server, () =>
      HttpResponse.json(buildPreviewJobState({ status: 'done', result: buildPreviewResult() })),
    )

    // The modal is never *mounted* open in the real app — the owner clicks the
    // trigger, which flips `open` false→true on the already-mounted modal. Mirror
    // that here: mount closed under StrictMode, then open. The enqueue rides that
    // transition (a dep change StrictMode does NOT double-invoke), so it lands on a
    // settled mutation observer instead of one the mount double-invoke tore down.
    const closed = (
      <StrictMode>
        <SchedulePreviewModal {...buildSchedulePreviewModalProps({ open: false })} />
      </StrictMode>
    )
    const view = render(closed)
    view.rerender(
      <StrictMode>
        <SchedulePreviewModal {...buildSchedulePreviewModalProps({ open: true })} />
      </StrictMode>,
    )

    // The instant structure lands off the enqueue 202 — proving the enqueue
    // actually reached a live observer.
    const summary = await schedulePreviewModalPage.findFieldSummary()
    expect(summary).toHaveTextContent('Synthetic field: Open Singles 4')

    // …and the polled solve streams all the way to a verdict, rather than the modal
    // being stranded on "Preparing preview…" (the bug's symptom).
    expect(await schedulePreviewModalPage.findVerdict()).toHaveTextContent(
      'Best possible plan',
    )
    expect(screen.queryByTestId('preview-preparing')).toBeNull()

    // Exactly one enqueue POST — no phantom second job from the StrictMode
    // double-invoke.
    expect(enqueueCalls).toBe(1)
  })

  // A refused enqueue must be "refused loud" (ADR): the trigger is NOT gated on draw
  // type, so a 422 (only round-robin is previewable), a 409 (already live), or a 429
  // (rate limit) can come back — and the modal must surface an actionable error, not
  // hang forever on "Preparing preview…".
  it('surfaces an enqueue refusal as an actionable error, not a permanent spinner', async () => {
    mockSchedulePreviewEnqueueEndpoint(server, () =>
      HttpResponse.json(
        { detail: 'Only round-robin draws can be previewed.' },
        { status: 422 },
      ),
    )

    schedulePreviewModalPage.render()

    // The inline error: the client's cause-neutral title over the server's own
    // director-facing sentence (the 422 detail is domain-authored copy).
    const error = await screen.findByTestId('preview-enqueue-error')
    expect(error).toHaveTextContent("This schedule can't be previewed yet")
    expect(error).toHaveTextContent('Only round-robin draws can be previewed.')
    // NOT a permanent spinner.
    expect(screen.queryByTestId('preview-preparing')).toBeNull()
    // Actionable: a retry and a close.
    expect(screen.getByTestId('preview-enqueue-retry')).toBeInTheDocument()
    expect(screen.getByTestId('preview-enqueue-close')).toBeInTheDocument()
  })

  // The bug behind this block: EVERY 422 was mapped to one hardcoded "this
  // tournament uses a draw type the preview does not support yet" notice, and the
  // server's `detail` was discarded. A director whose round-robin-then-knockout
  // event took one qualifier per group was told the draw type was unsupported — false
  // twice over (rr-then-ko IS previewed, in part) — instead of being told the one
  // thing they could act on. The API passes the domain's own sentence through on
  // purpose (`_draw_refusal`, `case DegenerateDraw(): detail = str(error)`), so the
  // modal must show it (`web-client/CLAUDE.md`: "surface server 4xx inline, don't
  // swallow it").
  describe('the enqueue-refusal notice', () => {
    /** Drive one enqueue refusal and return the rendered inline notice. */
    const refuseWith = async (status: number, body: unknown) => {
      mockSchedulePreviewEnqueueEndpoint(server, () =>
        HttpResponse.json(body as never, { status }),
      )
      schedulePreviewModalPage.render()
      return await screen.findByTestId('preview-enqueue-error')
    }

    // The real report, verbatim from the server. This is the assertion that reds
    // against the pre-fix code — as a text-content diff on an alert that IS on
    // screen, not a timeout, so the red says "wrong copy" and nothing else.
    it('shows the degenerate-draw sentence the server sent, not the draw-type guess', async () => {
      const detail =
        'Taking 1 qualifier from a single group leaves one player in the knockout ' +
        'stage, who would have nobody to play — take more qualifiers from each ' +
        'group, or configure more groups.'

      const error = await refuseWith(422, { detail })

      expect(error).toHaveTextContent(detail)
      // Replaced, not appended: the false draw-type sentence must be gone.
      expect(error).not.toHaveTextContent(
        'This tournament uses a draw type the preview does not support yet',
      )
      // The title stays cause-neutral, so it cannot contradict the detail.
      expect(error).toHaveTextContent("This schedule can't be previewed yet")
    })

    // The route's other 422 — no event of the tournament is previewable. Same path,
    // and the title has to read honestly over this sentence too.
    it('shows the no-previewable-event sentence the server sent', async () => {
      const detail =
        'A single_elimination draw cannot be previewed, and this tournament has ' +
        'no other event to preview. A draw of that kind is decided round by round ' +
        'as it is played, so before anyone has entered there is nothing to lay out.'

      const error = await refuseWith(422, { detail })

      expect(error).toHaveTextContent(detail)
      expect(error).toHaveTextContent("This schedule can't be previewed yet")
    })

    // No detail: the generic wording, never a blank description or "undefined".
    it('falls back to the generic description when the 422 carries no detail', async () => {
      const error = await refuseWith(422, {})

      expect(error).toHaveTextContent("This schedule can't be previewed yet")
      expect(error).toHaveTextContent(
        'A preview runs over a round-robin draw. This tournament uses a draw type the preview does not support yet.',
      )
      expect(error).not.toHaveTextContent('undefined')
    })

    // A whitespace-only detail is "no detail" — an empty description would leave the
    // notice with a title and nothing to act on.
    it('falls back to the generic description when the 422 detail is blank', async () => {
      const error = await refuseWith(422, { detail: '   ' })

      expect(error).toHaveTextContent(
        'A preview runs over a round-robin draw. This tournament uses a draw type the preview does not support yet.',
      )
    })

    // FastAPI's per-field 422 array is the ONE 422 body whose message is machine
    // prose ("Input should be a valid integer"), not a sentence anybody wrote for a
    // director — `extractDetail` still yields a string from it, so the shape decides
    // (`data/save-failure.ts`: `validationFields` is non-null only for that array).
    it('does not show Pydantic machine prose from a request-validation 422', async () => {
      const error = await refuseWith(422, {
        detail: [
          {
            loc: ['body', 'overrides', 'ev-1'],
            msg: 'Input should be a valid integer',
          },
        ],
      })

      expect(error).not.toHaveTextContent('Input should be a valid integer')
      expect(error).toHaveTextContent(
        'A preview runs over a round-robin draw. This tournament uses a draw type the preview does not support yet.',
      )
    })

    // The detail is TEXT. A server sentence carrying angle brackets is rendered
    // literally, and injects no element.
    it('renders the 422 detail as text, not markup', async () => {
      const error = await refuseWith(422, {
        detail: 'Take more qualifiers <b>from each group</b>.',
      })

      expect(error).toHaveTextContent('Take more qualifiers <b>from each group</b>.')
      expect(error.querySelector('b')).toBeNull()
    })

    // The transport/lifecycle branches are about the request, not the domain, so
    // their hardcoded copy is right and stays put. Pinned so the 422 change cannot
    // bleed into them.
    it('keeps the hardcoded 409 notice, ignoring any server detail', async () => {
      const error = await refuseWith(409, {
        detail: 'Tournament is not pre-live.',
      })

      expect(error).toHaveTextContent('The preview is only for a pre-live schedule')
      expect(error).toHaveTextContent(
        'This tournament is already live, so there is nothing to preview — the real schedule is on the board.',
      )
      expect(error).not.toHaveTextContent('Tournament is not pre-live.')
    })

    it('keeps the hardcoded 429 notice, ignoring any server detail', async () => {
      const error = await refuseWith(429, {
        detail: 'Rate limited: one preview at a time.',
      })

      expect(error).toHaveTextContent('A preview is already running')
      expect(error).toHaveTextContent(
        'Only one preview runs at a time. Wait a moment for the current one to finish, then try again.',
      )
      expect(error).not.toHaveTextContent('Rate limited')
    })

    it('keeps the hardcoded 403 notice, ignoring any server detail', async () => {
      const error = await refuseWith(403, {
        detail: 'You can only preview tournaments you created.',
      })

      expect(error).toHaveTextContent('The preview wasn’t run')
      expect(error).toHaveTextContent(
        'Only the tournament owner can preview the schedule.',
      )
      expect(error).not.toHaveTextContent('You can only preview tournaments you created.')
    })
  })

  it('heads a synthetic grid card with the human reservation name, not the composite id', async () => {
    schedulePreviewModalPage.render()

    // The grid streams in with the instant structure; its cards read the human
    // reservation name (`Reservation A`), never the namespaced `{event}:{reservation}`
    // composite the solver keys by.
    await schedulePreviewModalPage.findFieldSummary()
    const grid = await screen.findByTestId('preview-grid')
    expect(grid).toHaveTextContent('Reservation A')
    expect(grid).not.toHaveTextContent(/ev-1:res-1/)
  })

  it('reads a card as event · group · reservation, so two groups sharing a reservation stay told apart (ticket #1389)', async () => {
    schedulePreviewModalPage.render()

    await schedulePreviewModalPage.findFieldSummary()
    const grid = await screen.findByTestId('preview-grid')
    const [card] = grid.querySelectorAll('[data-testid^="unscheduled-"]')
    expect(card).toHaveTextContent(/Group A · Reservation A/)
  })

  it('shows the actionable infeasibility reasons instead of a grid', async () => {
    mockSchedulePreviewPollEndpoint(server, () =>
      HttpResponse.json(
        buildPreviewJobState({
          status: 'done',
          result: buildInfeasiblePreviewResult(),
        }),
      ),
    )

    schedulePreviewModalPage.render()

    const reasons = await schedulePreviewModalPage.findInfeasible()
    // The client's own sentence + remedy for the resolved cause — never a raw grid.
    expect(reasons).toHaveTextContent('Reservation A has no tables assigned.')
    expect(reasons).toHaveTextContent(/Assign at least one table to Reservation A/)
    // No grid when there is no plan to draw.
    expect(schedulePreviewModalPage.queryGrid()).toBeNull()
    // The verdict still reads honestly.
    expect(await schedulePreviewModalPage.findVerdict()).toHaveTextContent(
      "Doesn't fit",
    )
  })

  it('re-enqueues with the per-event override and streams a fresh result', async () => {
    schedulePreviewModalPage.render()

    // The first solve: a four-player field, six matches.
    await schedulePreviewModalPage.findVerdict()
    expect(schedulePreviewModalPage.queryCounts()).toHaveTextContent('6 matches')

    // Override the field to six players and re-run.
    const input = await schedulePreviewModalPage.findOverrideInput('Open Singles')
    await userEvent.clear(input)
    await userEvent.type(input, '6')
    await userEvent.click(schedulePreviewModalPage.getRerunButton())

    // A fresh preview streams over the new field — a six-player round robin is
    // fifteen matches.
    await waitFor(() =>
      expect(schedulePreviewModalPage.queryCounts()).toHaveTextContent(
        '15 matches',
      ),
    )
  })

  // The code-review fix: an invalid override must not leave the director staring at
  // a silently-dead Re-run button (`web-client/CLAUDE.md`, `## Forms`). Emptying a
  // field size (or typing a sub-2 count) has to SAY which field is wrong and why —
  // an inline red message + `aria-invalid` on that input — not just grey the button.
  it('shows an inline error and flags the input when an override is invalid', async () => {
    schedulePreviewModalPage.render()

    await schedulePreviewModalPage.findVerdict()

    // No error at rest — an untouched field falls back to the drawn size.
    expect(schedulePreviewModalPage.queryOverrideError('ev-1')).toBeNull()

    // Empty the field size: below-minimum, so it can't drive an honest re-run.
    const input = await schedulePreviewModalPage.findOverrideInput('Open Singles')
    await userEvent.clear(input)

    // The user SEES which field is wrong and why — the load-bearing assertion.
    const error = await schedulePreviewModalPage.findOverrideError('ev-1')
    expect(error).toHaveTextContent('Enter a number of at least 2')
    // …and the input is flagged and points at that message.
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute(
      'aria-describedby',
      'preview-override-error-ev-1',
    )
    // Re-run stays disabled while invalid (belt-and-suspenders — the error text is
    // what makes the disabled state legible).
    expect(schedulePreviewModalPage.getRerunButton()).toBeDisabled()

    // Typing a valid count clears both the message and the flag.
    await userEvent.type(input, '6')
    await waitFor(() =>
      expect(schedulePreviewModalPage.queryOverrideError('ev-1')).toBeNull(),
    )
    expect(input).toHaveAttribute('aria-invalid', 'false')
    expect(schedulePreviewModalPage.getRerunButton()).not.toBeDisabled()
  })

  it('labels the wait state as "Waiting…" while the job is queued', async () => {
    mockSchedulePreviewPollEndpoint(server, () =>
      HttpResponse.json(buildPreviewJobState({ status: 'queued' })),
    )

    schedulePreviewModalPage.render()

    await waitFor(() =>
      expect(schedulePreviewModalPage.queryWait()).toHaveTextContent(
        'Waiting for an in-progress solve to finish…',
      ),
    )
  })

  it('labels the wait state as "Solving…" while the job is running', async () => {
    mockSchedulePreviewPollEndpoint(server, () =>
      HttpResponse.json(buildPreviewJobState({ status: 'running' })),
    )

    schedulePreviewModalPage.render()

    await waitFor(() =>
      expect(schedulePreviewModalPage.queryWait()).toHaveTextContent(
        /Solving schedule…/,
      ),
    )
  })

  it('fires a best-effort cancel for the live token when it closes', async () => {
    let cancelledToken: string | null = null
    mockSchedulePreviewCancelEndpoint(server, ({ params }) => {
      cancelledToken = String(params.token)
      return new HttpResponse(null, { status: 204 })
    })

    const view = schedulePreviewModalPage.render()

    // Once the structure is on screen a token has been minted (the default store
    // mints `preview-token-1`).
    await schedulePreviewModalPage.findFieldSummary()

    // Close the modal — the body unmounts and cancels on its way out.
    view.rerender(
      <SchedulePreviewModal
        {...buildSchedulePreviewModalProps({ open: false })}
      />,
    )

    await waitFor(() => expect(cancelledToken).toBe('preview-token-1'))
  })
})
