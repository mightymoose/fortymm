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
  buildUnsupportedDrawTypeRefusal,
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
      HttpResponse.json(buildUnsupportedDrawTypeRefusal(), { status: 422 }),
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

  // #1221: the refusal's whole point. The old copy named nothing ("a draw type the
  // preview does not support yet"), so a director with four events could not tell
  // WHICH one blocks the preview. The server now sends the offending type
  // structurally — `detail.draw_type`, the hyphenated wire slug — beside a
  // machine-readable `code`, and the client resolves it through the SERVED
  // draw-type catalogue, so the notice says "Single elimination".
  it('names the offending draw type, in the director’s words, on a coded 422', async () => {
    mockSchedulePreviewEnqueueEndpoint(server, () =>
      HttpResponse.json(
        buildUnsupportedDrawTypeRefusal({ draw_type: 'single-elim' }),
        { status: 422 },
      ),
    )

    schedulePreviewModalPage.render()

    const error = await screen.findByTestId('preview-enqueue-error')
    // The load-bearing assertion: the draw type is NAMED, in the words the event
    // editor's picker shows.
    expect(error).toHaveTextContent('Single elimination')
    // …and never the wire slug, nor the server's own sentence (which says
    // "single-elim"), nor the old copy that named nothing.
    expect(error).not.toHaveTextContent('single-elim')
    expect(error).not.toHaveTextContent(
      'This tournament uses a draw type the preview does not support yet',
    )
  })

  // The deliberate degradation the server's `message` exists for: a refusal code
  // minted AFTER this build shipped still decodes, and the director reads the
  // server's fallback prose rather than a code, an `undefined`, or a crash.
  it('falls back to the server’s message for a 422 code it does not recognise', async () => {
    mockSchedulePreviewEnqueueEndpoint(server, () =>
      HttpResponse.json(
        {
          detail: {
            code: 'a_refusal_from_the_future',
            message: 'This tournament has an event the scheduler cannot place.',
          },
        },
        { status: 422 },
      ),
    )

    schedulePreviewModalPage.render()

    const error = await screen.findByTestId('preview-enqueue-error')
    expect(error).toHaveTextContent("This schedule can't be previewed yet")
    expect(error).toHaveTextContent(
      'This tournament has an event the scheduler cannot place.',
    )
    // Never the code itself, and never a hole where a fact should be.
    expect(error).not.toHaveTextContent('a_refusal_from_the_future')
    expect(error).not.toHaveTextContent('undefined')
  })

  // A detail that is not a coded object at all — the draw-refusal mapper still answers
  // with a plain-string `detail` for its other arms, and `DegenerateDraw` genuinely
  // reaches this route (an `rr-then-ko` event whose qualifiers exceed its smallest
  // pool). The server's sentence names the real cause and the numbers behind it, so it
  // is shown; falling through to the generic would tell a director their *draw type*
  // was unsupported when their entrant counts were the problem.
  it("shows the server's own sentence for a 422 that is not a coded refusal", async () => {
    mockSchedulePreviewEnqueueEndpoint(server, () =>
      HttpResponse.json(
        {
          detail:
            'Taking 3 qualifiers from each pool is more than the 2 entrants in the smallest pool.',
        },
        { status: 422 },
      ),
    )

    schedulePreviewModalPage.render()

    const error = await screen.findByTestId('preview-enqueue-error')
    expect(error).toHaveTextContent("This schedule can't be previewed yet")
    expect(error).toHaveTextContent(
      'more than the 2 entrants in the smallest pool',
    )
    // The generic would have named the wrong cause entirely.
    expect(error).not.toHaveTextContent(
      'uses a draw type the preview does not support yet',
    )
    expect(error).not.toHaveTextContent('undefined')
    // Still actionable — the modal is intact, not a blown-up boundary.
    expect(screen.getByTestId('preview-enqueue-retry')).toBeInTheDocument()
  })

  // Nothing to read at all: no body, so no sentence to borrow. This is the only case
  // the generic is for, and it must still be reachable.
  it('falls back to the generic copy for a 422 carrying no sentence at all', async () => {
    mockSchedulePreviewEnqueueEndpoint(
      server,
      () => new HttpResponse(null, { status: 422 }),
    )

    schedulePreviewModalPage.render()

    const error = await screen.findByTestId('preview-enqueue-error')
    expect(error).toHaveTextContent("This schedule can't be previewed yet")
    expect(error).toHaveTextContent(
      'This tournament uses a draw type the preview does not support yet',
    )
    expect(error).not.toHaveTextContent('undefined')
    expect(screen.getByTestId('preview-enqueue-retry')).toBeInTheDocument()
  })

  // FastAPI's own request-validation 422, which is shaped nothing like a refusal: a
  // `detail` ARRAY of Pydantic errors. `extractDetail` would happily return
  // `errors[0].msg` from it — that is how "Input should be a valid integer, got a
  // number with a fractional part" once reached a director, under a heading promising
  // to talk about their schedule. A malformed request is not a refusal, and Pydantic's
  // phrasing is machinery, so this must take the generic and say nothing about ints.
  it('never shows validation machinery for a malformed request', async () => {
    mockSchedulePreviewEnqueueEndpoint(server, () =>
      HttpResponse.json(
        {
          detail: [
            {
              type: 'int_from_float',
              loc: ['body', 'overrides', 'ev-1'],
              msg: 'Input should be a valid integer, got a number with a fractional part',
              input: 2.5,
            },
          ],
        },
        { status: 422 },
      ),
    )

    schedulePreviewModalPage.render()

    const error = await screen.findByTestId('preview-enqueue-error')
    expect(error).toHaveTextContent("This schedule can't be previewed yet")
    expect(error).toHaveTextContent(
      'This tournament uses a draw type the preview does not support yet',
    )
    expect(error).not.toHaveTextContent('valid integer')
    expect(error).not.toHaveTextContent('fractional')
    // The echoed input must not surface either — it is the director's own value, but
    // through a channel nobody designed for it.
    expect(error).not.toHaveTextContent('2.5')
  })

  // A slug this build has no word for (an empty catalogue stands in for "the
  // payload withheld it" / "a draw type seeded after this build"). Naming it
  // "single-elim" would be exactly the raw-slug leak `labelFor` exists to prevent,
  // so the notice drops to the server's fallback sentence instead.
  it('falls back to the server’s message when the catalogue has no word for the draw type', async () => {
    mockSchedulePreviewEnqueueEndpoint(server, () =>
      HttpResponse.json(buildUnsupportedDrawTypeRefusal(), { status: 422 }),
    )

    schedulePreviewModalPage.render({ drawTypes: [] })

    const error = await screen.findByTestId('preview-enqueue-error')
    expect(error).toHaveTextContent(
      'A single-elim draw cannot be scheduled yet.',
    )
    expect(error).not.toHaveTextContent('undefined')
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
    expect(error).toHaveTextContent('Enter a whole number of at least 2')
    // …and the input is flagged and points at that message.
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute(
      'aria-describedby',
      'preview-override-error-ev-1',
    )
    // Re-run stays disabled while invalid (belt-and-suspenders — the error text is
    // what makes the disabled state legible).
    expect(schedulePreviewModalPage.getRerunButton()).toBeDisabled()

    // A FRACTIONAL field size is caught here too, and this is the one that matters
    // most: the server takes `dict[uuid.UUID, int]`, so 2.5 used to sail past this
    // guard, 422 from FastAPI's own validator, and come back as Pydantic prose under
    // a heading about the schedule. Refused at the field, in words about the field.
    await userEvent.type(input, '2.5')
    const fractional = await schedulePreviewModalPage.findOverrideError('ev-1')
    expect(fractional).toHaveTextContent('Enter a whole number of at least 2')
    expect(schedulePreviewModalPage.getRerunButton()).toBeDisabled()

    // Typing a valid count clears both the message and the flag.
    await userEvent.clear(input)
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
