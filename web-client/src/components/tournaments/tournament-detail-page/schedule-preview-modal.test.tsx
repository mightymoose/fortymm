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

    // The inline error, with the client's own copy — never the raw server sentence.
    const error = await screen.findByTestId('preview-enqueue-error')
    expect(error).toHaveTextContent("This schedule can't be previewed yet")
    // NOT a permanent spinner.
    expect(screen.queryByTestId('preview-preparing')).toBeNull()
    // Actionable: a retry and a close.
    expect(screen.getByTestId('preview-enqueue-retry')).toBeInTheDocument()
    expect(screen.getByTestId('preview-enqueue-close')).toBeInTheDocument()
  })

  it('heads a synthetic grid card with the human pool name, not the composite id', async () => {
    schedulePreviewModalPage.render()

    // The grid streams in with the instant structure; its cards read the human pool
    // name (`Pool A`), never the namespaced `{event}:{pool}` composite the solver
    // keys by.
    await schedulePreviewModalPage.findFieldSummary()
    const grid = await screen.findByTestId('preview-grid')
    expect(grid).toHaveTextContent('Pool A')
    expect(grid).not.toHaveTextContent(/ev-1:pool-1/)
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
    expect(reasons).toHaveTextContent('Pool A has no tables assigned.')
    expect(reasons).toHaveTextContent(/Assign at least one table to Pool A/)
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
