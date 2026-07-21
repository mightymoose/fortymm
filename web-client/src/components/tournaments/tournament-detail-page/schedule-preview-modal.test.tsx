import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'

import { screen, waitFor } from '@/test/utilities'
import {
  mockSchedulePreviewCancelEndpoint,
  mockSchedulePreviewPollEndpoint,
} from '@/mocks/endpoints/tournaments/preview.endpoint'
import {
  buildInfeasiblePreviewResult,
  buildPreviewJobState,
} from '@/mocks/factories/tournaments/preview.factory'
import { server } from '@/mocks/server'
import { resetSchedulePreviewStore } from '@/mocks/schedule-preview-store'

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
