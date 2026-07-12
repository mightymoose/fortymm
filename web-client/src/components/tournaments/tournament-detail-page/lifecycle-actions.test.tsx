import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockTournamentTransitionEndpoint } from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import { buildTournamentDetailRead } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { waitFor } from '@/test/utilities'

import { buildTournament } from '../data/seed.factory'
import { lifecycleActionsPage } from './lifecycle-actions.page'

vi.mock('sonner', async () => {
  const actual = await vi.importActual<typeof import('sonner')>('sonner')
  return { ...actual, toast: { ...actual.toast, error: vi.fn() } }
})

beforeEach(() => vi.mocked(toast.error).mockClear())

/** The transitions endpoint, recording what the button actually sent. The 201
 * body is a bare `TournamentRead` (no events), as the API answers. */
function captureTransition() {
  const seen: { url: string; body: unknown }[] = []
  mockTournamentTransitionEndpoint(server, async ({ request }) => {
    seen.push({ url: request.url, body: await request.json() })
    const { events, ...read } = buildTournamentDetailRead()
    void events
    return HttpResponse.json(read, { status: 201 })
  })
  return seen
}

describe('LifecycleActions', () => {
  // Each row is one edge of the forward-only lifecycle (ADR-0017): the button a
  // status offers, and the status it moves to. Table-driven so a fourth button —
  // or a button offered from the wrong status — cannot slip in unnoticed.
  it.each([
    { status: 'draft', label: /Publish/, to: 'published' },
    { status: 'published', label: /Start tournament/, to: 'live' },
    { status: 'live', label: /End tournament/, to: 'archived' },
  ] as const)(
    'posts { to: "$to" } to the transitions endpoint from $status',
    async ({ status, label, to }) => {
      const seen = captureTransition()
      lifecycleActionsPage.render({
        tournament: buildTournament({ id: 't-1', status }),
      })

      await userEvent.click(lifecycleActionsPage.getLifecycleButton(label))

      // The transitions RESOURCE, not a status-carrying PATCH: `TournamentUpdate`
      // has no `status` field, so a PATCH here would be a no-op that looked fine.
      await waitFor(() => expect(seen).toHaveLength(1))
      expect(seen[0].url).toContain('/v1/tournaments/t-1/transitions')
      expect(seen[0].body).toEqual({ to })
    },
  )

  it('offers only the edge legal from the current status', () => {
    lifecycleActionsPage.render({
      tournament: buildTournament({ status: 'draft' }),
    })

    expect(
      lifecycleActionsPage.getLifecycleButton(/Publish/),
    ).toBeInTheDocument()
    expect(lifecycleActionsPage.queryAllButtons()).toHaveLength(1)
  })

  // `archived` is terminal: there is no edge out of it, so there is no button —
  // rather than a button that could only ever be refused.
  it('offers nothing on an archived tournament', () => {
    lifecycleActionsPage.render({
      tournament: buildTournament({ status: 'archived' }),
    })
    expect(lifecycleActionsPage.queryAllButtons()).toHaveLength(0)
  })

  // Hidden, never disabled (ADR 0015): transitions are owner-only server-side, so
  // a viewer is offered no lifecycle affordance at all.
  it('renders nothing for a non-owner', () => {
    lifecycleActionsPage.render({
      tournament: buildTournament({ status: 'draft', canEdit: false }),
    })
    expect(lifecycleActionsPage.queryAllButtons()).toHaveLength(0)
  })

  // (`hasLifecycleAction` — what the header asks before it renders the slot at
  // all — is the same table, and is tested in `../data/lifecycle.test.ts`.)

  // The stale-tab case, which is the whole reason the server 409s a re-assertion
  // instead of shrugging: this tab still reads `draft` and still offers Publish,
  // but the tournament was published in another tab. The refusal must be VISIBLE —
  // a silent no-op would leave the user clicking a button that does nothing.
  it('surfaces a 409 from a stale view as an error the user can see', async () => {
    mockTournamentTransitionEndpoint(server, () =>
      HttpResponse.json(
        { detail: 'This tournament is published; it cannot be moved to published.' },
        { status: 409 },
      ),
    )
    lifecycleActionsPage.render({
      tournament: buildTournament({ id: 't-1', status: 'draft' }),
    })

    await userEvent.click(lifecycleActionsPage.getLifecycleButton(/Publish/))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        // The verb is the edge they clicked, not the wire call.
        "Couldn't publish the tournament",
        expect.objectContaining({
          description:
            'This tournament is published; it cannot be moved to published.',
        }),
      ),
    )
  })
})
