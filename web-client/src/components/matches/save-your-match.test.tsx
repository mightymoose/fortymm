import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/mocks/server'
import { matchDetails, sessionResponse } from '@/test/factories'
import { MatchDetailsView } from '@/components/matches/match-details-page'

const SAVE_LABEL = /save this match/i
const PROMPT_LABEL = /save this match/i
const PROMPT_REGION = /^Save this match$/i

function withSession(overrides: Parameters<typeof sessionResponse>[0] = {}) {
  server.use(
    http.get('*/v1/session', () => HttpResponse.json(sessionResponse(overrides))),
  )
}

function withMatch(matchId: string, match: ReturnType<typeof matchDetails>) {
  server.use(http.get(`*/v1/matches/${matchId}`, () => HttpResponse.json(match)))
}

function renderDetails(matchId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const detailsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/details',
    component: () => <MatchDetailsView matchId={matchId} />,
  })
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => <div>settings-page</div>,
  })
  const matchesList = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches',
    component: () => <div>matches-list</div>,
  })
  const matchPage = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    component: () => <div>match-page</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      detailsRoute,
      settingsRoute,
      matchesList,
      matchPage,
    ]),
    history: createMemoryHistory({ initialEntries: ['/details'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function finalizedMatch(matchId: string) {
  return matchDetails({
    id: matchId,
    status: 'completed',
    status_label: 'Final',
    sides: [
      {
        side_number: 1,
        players: [
          { user_id: 'u-me', username: 'rita.kovac', is_current_user: true },
        ],
        games_won: 3,
        won: true,
        is_current_user_side: true,
      },
      {
        side_number: 2,
        players: [
          { user_id: 'u-opp', username: 'okafor.d', is_current_user: false },
        ],
        games_won: 1,
        won: false,
        is_current_user_side: false,
      },
    ],
    games: [],
    current_game: null,
    can_score: false,
  })
}

describe('SaveYourMatch', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })
  afterEach(() => {
    window.localStorage.clear()
  })

  it('nudges the guest finalizer with opponent + score + CTA to /settings#sec-email', async () => {
    withSession({ user: { email: null, confirmed_at: null } })
    withMatch('m-guest', finalizedMatch('m-guest'))

    renderDetails('m-guest')

    const prompt = await screen.findByRole('region', { name: PROMPT_REGION })
    // Anchors on the specific match: opponent name + score blips + date.
    expect(within(prompt).getByText(/rivalry with okafor\.d/i)).toBeInTheDocument()
    const blips = within(prompt).getAllByText(/^[0-9]+$/)
    expect(blips.map((n) => n.textContent)).toEqual(['3', '1'])
    // Primary CTA goes to the settings email section.
    const cta = within(prompt).getByRole('link', { name: SAVE_LABEL })
    expect(cta).toHaveAttribute('href', '/settings#sec-email')
    // Dismiss is present, "TAKES 20s · EMAIL ONLY" hint is shown.
    expect(
      within(prompt).getByRole('button', { name: /not now/i }),
    ).toBeInTheDocument()
    expect(within(prompt).getByText(/TAKES 20s/)).toBeInTheDocument()
  })

  it('also fires on a live (in-progress) match so a guest who closes the tab before sign-off still gets nudged', async () => {
    withSession({ user: { email: null, confirmed_at: null } })
    const live = matchDetails({
      id: 'm-live',
      status: 'in_progress',
      status_label: 'Live',
      sides: [
        {
          side_number: 1,
          players: [
            { user_id: 'u-me', username: 'rita.kovac', is_current_user: true },
          ],
          games_won: 2,
          won: null,
          is_current_user_side: true,
        },
        {
          side_number: 2,
          players: [
            { user_id: 'u-opp', username: 'okafor.d', is_current_user: false },
          ],
          games_won: 1,
          won: null,
          is_current_user_side: false,
        },
      ],
    })
    withMatch('m-live', live)

    renderDetails('m-live')

    expect(
      await screen.findByRole('region', { name: PROMPT_REGION }),
    ).toBeInTheDocument()
  })

  it('hides on an upcoming (not-yet-started) match', async () => {
    withSession({ user: { email: null, confirmed_at: null } })
    const upcoming = matchDetails({
      id: 'm-upcoming',
      status: 'pending',
      status_label: 'Scheduled',
    })
    withMatch('m-upcoming', upcoming)

    const { container } = renderDetails('m-upcoming')

    await waitFor(() =>
      expect(container.querySelector('.md-hero')).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('region', { name: PROMPT_REGION }),
    ).not.toBeInTheDocument()
  })

  it('hides when the viewer already has a confirmed email', async () => {
    withSession({
      user: { email: 'rita@example.com', confirmed_at: '2026-05-01T00:00:00Z' },
    })
    withMatch('m-verified', finalizedMatch('m-verified'))

    const { container } = renderDetails('m-verified')

    await waitFor(() =>
      expect(container.querySelector('.md-hero')).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('region', { name: PROMPT_REGION }),
    ).not.toBeInTheDocument()
  })

  it('hides for a spectator (not a participant), even if the viewer is a guest', async () => {
    withSession({ user: { email: null, confirmed_at: null } })
    const spectatorMatch = matchDetails({
      id: 'm-spec-guest',
      status: 'completed',
      status_label: 'Final',
      sides: [
        {
          side_number: 1,
          players: [{ user_id: 'u-a', username: 'ada.l', is_current_user: false }],
          games_won: 3,
          won: true,
          is_current_user_side: false,
        },
        {
          side_number: 2,
          players: [{ user_id: 'u-b', username: 'bo.k', is_current_user: false }],
          games_won: 0,
          won: false,
          is_current_user_side: false,
        },
      ],
      games: [],
      current_game: null,
      can_score: false,
    })
    withMatch('m-spec-guest', spectatorMatch)

    const { container } = renderDetails('m-spec-guest')

    await waitFor(() =>
      expect(container.querySelector('.md-hero')).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('region', { name: PROMPT_REGION }),
    ).not.toBeInTheDocument()
  })

  it('swaps to a "save it" receipt after Not now, then persists dismissal across reloads', async () => {
    withSession({ user: { email: null, confirmed_at: null } })
    withMatch('m-dismiss', finalizedMatch('m-dismiss'))

    const user = userEvent.setup()
    const first = renderDetails('m-dismiss')

    const prompt = await screen.findByRole('region', { name: PROMPT_REGION })
    await user.click(within(prompt).getByRole('button', { name: /not now/i }))

    // The full prompt is gone; a quiet receipt with an undo affordance stays.
    expect(
      screen.queryByRole('region', { name: PROMPT_REGION }),
    ).not.toBeInTheDocument()
    const receipt = screen.getByRole('status', { name: /match save receipt/i })
    expect(receipt).toHaveTextContent(/lives on your device only/i)
    // The receipt's "Save it" is a real CTA — it links straight to the email
    // section, not a re-surface of the prompt.
    expect(
      within(receipt).getByRole('link', { name: /save it/i }),
    ).toHaveAttribute('href', '/settings#sec-email')

    // Persistence: a fresh render reads the dismissal from storage and renders
    // nothing at all (the brief is "don't badger them if they revisit").
    first.unmount()
    withMatch('m-dismiss', finalizedMatch('m-dismiss'))

    const { container } = renderDetails('m-dismiss')
    await waitFor(() =>
      expect(container.querySelector('.md-hero')).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('region', { name: PROMPT_LABEL }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/lives on your device only/i),
    ).not.toBeInTheDocument()
  })

  it('hides on a finalized no-opponent (ghost) match', async () => {
    withSession({ user: { email: null, confirmed_at: null } })
    const solo = matchDetails({
      id: 'm-solo-final',
      status: 'completed',
      status_label: 'Final',
      sides: [
        {
          side_number: 1,
          players: [
            { user_id: 'u-me', username: 'rita.kovac', is_current_user: true },
          ],
          games_won: 0,
          won: true,
          is_current_user_side: true,
        },
        // No-opponent sentinel: a real side row with no player.
        {
          side_number: 2,
          players: [],
          games_won: 0,
          won: false,
          is_current_user_side: false,
        },
      ],
      games: [],
      current_game: null,
      can_score: false,
    })
    withMatch('m-solo-final', solo)

    const { container } = renderDetails('m-solo-final')

    await waitFor(() =>
      expect(container.querySelector('.md-hero')).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('region', { name: PROMPT_REGION }),
    ).not.toBeInTheDocument()
  })

  it('treats each match independently — dismissing one does not silence another', async () => {
    window.localStorage.setItem('fm.savePromptDismissed.m-other', '1')
    withSession({ user: { email: null, confirmed_at: null } })
    withMatch('m-fresh', finalizedMatch('m-fresh'))

    renderDetails('m-fresh')

    // m-fresh still nudges even though m-other was dismissed.
    expect(
      await screen.findByRole('region', { name: PROMPT_REGION }),
    ).toBeInTheDocument()
  })
})
