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
import { describe, expect, it } from 'vitest'
import { server } from '@/mocks/server'
import { matchDetails } from '@/test/factories'
import {
  MatchDetailsError,
  MatchDetailsView,
} from '@/components/matches/match-details-page'

function renderDetails(matchId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const detailsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/details',
    component: () => <MatchDetailsView matchId={matchId} />,
    errorComponent: MatchDetailsError,
  })
  // Route stubs the real route would navigate to — registered so typed
  // <Link>s in the page resolve at render time.
  const scoringNew = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameNumber/scores/new',
    component: () => <div>scoring-new</div>,
  })
  const scoringEdit = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameNumber/scores/edit',
    component: () => <div>scoring-edit</div>,
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
      scoringNew,
      scoringEdit,
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

describe('MatchDetailsView', () => {
  it('renders the hero scoreline from the participant sides counts', async () => {
    const match = matchDetails({
      id: 'm-1',
      status: 'completed',
      status_label: 'Final',
      sides: [
        {
          side_number: 1,
          players: [
            { user_id: 'u-me', username: 'me', is_current_user: true },
          ],
          games_won: 3,
          won: true,
          is_current_user_side: true,
        },
        {
          side_number: 2,
          players: [
            { user_id: 'u-opp', username: 'nguyen.t', is_current_user: false },
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
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(match)),
    )

    const { container } = renderDetails('m-1')

    // Wait for the hero to render; each side's games_won shows up as the
    // headline score number, current-user side on the left.
    await waitFor(() =>
      expect(container.querySelector('.md-hero__name')).toHaveTextContent(
        'me',
      ),
    )
    const leftScore = container.querySelector('.md-hero__score--l')
    const rightScore = container.querySelector('.md-hero__score--r')
    expect(leftScore).toHaveTextContent('3')
    expect(rightScore).toHaveTextContent('1')
    // My side won — the win modifier is on the left, not the right.
    expect(leftScore).toHaveClass('md-hero__score--win')
    expect(rightScore).not.toHaveClass('md-hero__score--win')
  })

  it('shows a Score CTA only when can_score is true and links to current_game', async () => {
    const game1 = { id: 'g-1', game_number: 1, score: null }
    const match = matchDetails({
      id: 'm-2',
      status: 'pending',
      status_label: 'Scheduled',
      games: [game1],
      current_game: { game_number: 1 },
      can_score: true,
    })
    server.use(
      http.get('*/v1/matches/m-2', () => HttpResponse.json(match)),
    )

    renderDetails('m-2')

    const scoreLink = await screen.findByRole('link', { name: 'Score' })
    expect(scoreLink).toHaveAttribute(
      'href',
      '/matches/m-2/games/1/scores/new',
    )
  })

  it('hides the Score CTA when can_score is false', async () => {
    const match = matchDetails({
      id: 'm-3',
      status: 'completed',
      can_score: false,
      current_game: null,
      games: [],
    })
    server.use(
      http.get('*/v1/matches/m-3', () => HttpResponse.json(match)),
    )

    const { container } = renderDetails('m-3')

    // Wait for the players card to render (one of its name nodes).
    await waitFor(() =>
      expect(container.querySelector('.md-profile__name')).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('link', { name: 'Score' }),
    ).not.toBeInTheDocument()
  })

  it('links each scored game cell on my row to its scores/edit route', async () => {
    const match = matchDetails({
      id: 'm-4',
      status: 'in_progress',
      status_label: 'Live',
      best_of: 5,
      games_to_win: 3,
      sides: [
        {
          side_number: 1,
          players: [
            { user_id: 'u-me', username: 'me', is_current_user: true },
          ],
          games_won: 1,
          won: null,
          is_current_user_side: true,
        },
        {
          side_number: 2,
          players: [
            { user_id: 'u-opp', username: 'opp', is_current_user: false },
          ],
          games_won: 0,
          won: null,
          is_current_user_side: false,
        },
      ],
      games: [
        {
          id: 'g-1',
          game_number: 1,
          score: {
            id: 's-1',
            side_1_points: 11,
            side_2_points: 4,
            winner_side_number: 1,
          },
        },
        { id: 'g-2', game_number: 2, score: null },
      ],
      current_game: { game_number: 2 },
      can_score: true,
    })
    server.use(
      http.get('*/v1/matches/m-4', () => HttpResponse.json(match)),
    )

    renderDetails('m-4')

    await screen.findByRole('link', { name: 'Score' })
    // The first-game cell on my row is a link to the edit route for game 1.
    const editLink = screen.getByRole('link', { name: '11' })
    expect(editLink).toHaveAttribute(
      'href',
      '/matches/m-4/games/1/scores/edit',
    )
  })

  it('renders an error fallback when the match fails to load', async () => {
    server.use(
      http.get('*/v1/matches/m-missing', () =>
        HttpResponse.json({ detail: 'Match not found.' }, { status: 404 }),
      ),
    )
    renderDetails('m-missing')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(/couldn.t find that match/i)).toBeInTheDocument()
  })

  it('shows friendly not-found copy (not the raw API detail) for a malformed match id (#152)', async () => {
    server.use(
      http.get('*/v1/matches/garbage', () =>
        HttpResponse.json(
          {
            detail:
              'Input should be a valid UUID, invalid character: found `g` at 1',
          },
          { status: 422 },
        ),
      ),
    )
    renderDetails('garbage')

    const alert = await screen.findByRole('alert')
    expect(
      within(alert).getByText(/couldn.t find that match/i),
    ).toBeInTheDocument()
    // The raw pydantic validation message must not leak to the user.
    expect(within(alert).queryByText(/valid UUID/i)).not.toBeInTheDocument()
    // Retrying the same broken URL is pointless — offer a way back to the list.
    expect(
      within(alert).getByRole('link', { name: /back to matches/i }),
    ).toHaveAttribute('href', '/matches')
  })

  it('renders no-opponent matches with a "No opponent" placeholder, still scorable', async () => {
    const game1 = { id: 'g-solo-1', game_number: 1, score: null }
    const match = matchDetails({
      id: 'm-solo',
      sides: [
        {
          side_number: 1,
          players: [
            { user_id: 'u-me', username: 'me', is_current_user: true },
          ],
          games_won: 0,
          won: null,
          is_current_user_side: true,
        },
        // The sentinel opponent: a real side row with no player.
        {
          side_number: 2,
          players: [],
          games_won: 0,
          won: null,
          is_current_user_side: false,
        },
      ],
      games: [game1],
      current_game: { game_number: 1 },
      can_score: true,
    })
    server.use(
      http.get('*/v1/matches/m-solo', () => HttpResponse.json(match)),
    )
    const { container } = renderDetails('m-solo')

    // The participant shows on the left; the player-less opponent side renders
    // a "No opponent" placeholder rather than a blank slot.
    await waitFor(() =>
      expect(container.querySelectorAll('.md-hero__name').length).toBe(2),
    )
    const heroNames = Array.from(
      container.querySelectorAll('.md-hero__name'),
    ).map((el) => el.textContent)
    expect(heroNames).toEqual(['me', 'No opponent'])
    // The placeholder is styled as a ghost (dashed avatar + muted name), not a
    // real player.
    expect(
      container.querySelector('.md-hero__name--ghost'),
    ).toHaveTextContent('No opponent')
    expect(container.querySelector('.md-avatar--ghost')).toBeInTheDocument()
    // The Players snapshot card mirrors it on the opponent side.
    expect(
      container.querySelector('.md-profile__name--ghost'),
    ).toHaveTextContent('No opponent')
    // A no-opponent match is now scorable: the Score CTA is present.
    expect(
      await screen.findByRole('link', { name: 'Score' }),
    ).toHaveAttribute('href', '/matches/m-solo/games/1/scores/new')
    // Did not bounce to the list.
    expect(screen.queryByText('matches-list')).not.toBeInTheDocument()
  })

  it('renders for spectators (no current-user side) without a Score CTA', async () => {
    const match = matchDetails({
      id: 'm-spec',
      status: 'in_progress',
      status_label: 'Live',
      sides: [
        {
          side_number: 1,
          players: [
            { user_id: 'u-a', username: 'ada.l', is_current_user: false },
          ],
          games_won: 1,
          won: null,
          is_current_user_side: false,
        },
        {
          side_number: 2,
          players: [
            { user_id: 'u-b', username: 'bo.k', is_current_user: false },
          ],
          games_won: 0,
          won: null,
          is_current_user_side: false,
        },
      ],
      games: [
        {
          id: 'g-1',
          game_number: 1,
          score: {
            id: 's-1',
            side_1_points: 11,
            side_2_points: 6,
            winner_side_number: 1,
          },
        },
        { id: 'g-2', game_number: 2, score: null },
      ],
      current_game: { game_number: 2 },
      // BFF returns false for non-participants regardless of game state.
      can_score: false,
    })
    server.use(
      http.get('*/v1/matches/m-spec', () => HttpResponse.json(match)),
    )

    const { container } = renderDetails('m-spec')

    // Both player names from the match render — neither is the current user.
    await waitFor(() =>
      expect(container.querySelectorAll('.md-hero__name').length).toBe(2),
    )
    const names = Array.from(container.querySelectorAll('.md-hero__name')).map(
      (el) => el.textContent,
    )
    expect(names).toEqual(['ada.l', 'bo.k'])
    expect(
      screen.queryByRole('link', { name: 'Score' }),
    ).not.toBeInTheDocument()
    // Scored cells stay plain divs rather than edit links for spectators.
    expect(screen.queryByRole('link', { name: '11' })).not.toBeInTheDocument()
  })

  it('shows recent form per side and an empty state for first-time players', async () => {
    const match = matchDetails({
      id: 'm-form',
      status: 'in_progress',
      sides: [
        {
          side_number: 1,
          players: [
            { user_id: 'u-me', username: 'me', is_current_user: true },
          ],
          games_won: 0,
          won: null,
          is_current_user_side: true,
        },
        {
          side_number: 2,
          players: [
            { user_id: 'u-rookie', username: 'rookie', is_current_user: false },
          ],
          games_won: 0,
          won: null,
          is_current_user_side: false,
        },
      ],
      games: [],
      current_game: null,
      can_score: false,
      recent_form: [
        {
          user_id: 'u-me',
          recent_results: [
            {
              match_id: 'm-prev-1',
              is_win: true,
              player_games_won: 3,
              opponent_games_won: 1,
              opponent_username: 'silva.r',
              completed_at: '2026-05-09T18:00:00Z',
            },
            {
              match_id: 'm-prev-2',
              is_win: false,
              player_games_won: 1,
              opponent_games_won: 3,
              opponent_username: 'tanaka.y',
              completed_at: '2026-05-07T18:00:00Z',
            },
          ],
          rating_before: 1612,
          rating_history: [1580, 1601, 1612],
          career_matches_before: 12,
          career_wins_before: 9,
        },
        {
          user_id: 'u-rookie',
          recent_results: [],
          rating_before: null,
          rating_history: [],
          career_matches_before: 0,
          career_wins_before: 0,
        },
      ],
    })
    server.use(http.get('*/v1/matches/m-form', () => HttpResponse.json(match)))

    const { container } = renderDetails('m-form')

    // Wait for the Players snapshot card title to render. The header now
    // carries the temporal frame so the per-field labels don't have to.
    await waitFor(() =>
      expect(container.querySelector('.md-card__hd h3')).toHaveTextContent(
        'Players · going into this match',
      ),
    )
    // My side: 1 W and 1 L with the right opponent / score labels.
    const myForm = screen.getByTestId('form-1')
    expect(within(myForm).getByText('Form · 1–1')).toBeInTheDocument()
    // The with-history half leads with a one-line "going in" summary, mirroring
    // the empty half's "first one" sentence.
    expect(
      within(myForm).getByText('12 prior matches · 75% win rate going in'),
    ).toBeInTheDocument()
    expect(within(myForm).getByText('silva.r')).toBeInTheDocument()
    expect(within(myForm).getByText('3–1')).toBeInTheDocument()
    expect(within(myForm).getByText('tanaka.y')).toBeInTheDocument()
    expect(within(myForm).getByText('1–3')).toBeInTheDocument()
    // Each form row carries the date the past match completed on.
    expect(within(myForm).getByText('May 9')).toBeInTheDocument()
    expect(within(myForm).getByText('May 7')).toBeInTheDocument()
    // Pre-match rating shows (rounded) with a sparkline; career stats below.
    const myRating = screen.getByTestId('rating-box-1')
    expect(within(myRating).getByText('1612')).toBeInTheDocument()
    expect(myRating.querySelector('svg')).not.toBeNull()
    const myCareer = screen.getByTestId('career-1')
    expect(within(myCareer).getByText('12')).toBeInTheDocument()
    expect(within(myCareer).getByText('75%')).toBeInTheDocument()
    // Rookie shows the empty state, not a result list.
    const oppForm = screen.getByTestId('form-2')
    expect(within(oppForm).getByText(/No prior matches yet/)).toBeInTheDocument()
    expect(within(oppForm).queryByText(/Form · /)).not.toBeInTheDocument()
    // Unrated rookie: no rating number, no sparkline, no win rate.
    const oppRating = screen.getByTestId('rating-box-2')
    expect(within(oppRating).getByText('Unrated')).toBeInTheDocument()
    expect(oppRating.querySelector('svg')).toBeNull()
    const oppCareer = screen.getByTestId('career-2')
    expect(within(oppCareer).getByText('0')).toBeInTheDocument()
    expect(within(oppCareer).getByText('—')).toBeInTheDocument()
  })

  it('shows the head-to-head card with prior meetings counted per side', async () => {
    const match = matchDetails({
      id: 'm-h2h',
      status: 'in_progress',
      sides: [
        {
          side_number: 1,
          players: [
            { user_id: 'u-me', username: 'me', is_current_user: true },
          ],
          games_won: 0,
          won: null,
          is_current_user_side: true,
        },
        {
          side_number: 2,
          players: [
            { user_id: 'u-opp', username: 'opp', is_current_user: false },
          ],
          games_won: 0,
          won: null,
          is_current_user_side: false,
        },
      ],
      games: [],
      current_game: null,
      can_score: false,
      head_to_head: {
        total_meetings: 3,
        side_1_wins: 2,
        side_2_wins: 1,
        recent_meetings: [
          {
            match_id: 'm-h2h-3',
            completed_at: '2026-05-08T18:00:00Z',
            side_1_games_won: 1,
            side_2_games_won: 3,
            winner_side_number: 2,
          },
          {
            match_id: 'm-h2h-2',
            completed_at: '2026-04-30T18:00:00Z',
            side_1_games_won: 3,
            side_2_games_won: 0,
            winner_side_number: 1,
          },
          {
            match_id: 'm-h2h-1',
            completed_at: '2026-04-12T18:00:00Z',
            side_1_games_won: 3,
            side_2_games_won: 2,
            winner_side_number: 1,
          },
        ],
      },
    })
    server.use(http.get('*/v1/matches/m-h2h', () => HttpResponse.json(match)))

    const { container } = renderDetails('m-h2h')

    await waitFor(() => {
      const headings = Array.from(container.querySelectorAll('.md-card__hd h3'))
      expect(headings.map((h) => h.textContent)).toContain('Head to head')
    })
    const h2hCard = container.querySelector('.md-h2h')!
    expect(screen.getByText('3 MEETINGS')).toBeInTheDocument()
    // Win counts: left = me = 2, right = opp = 1.
    const counts = h2hCard.querySelectorAll('.md-h2h__count')
    expect(counts[0]).toHaveTextContent('2')
    expect(counts[1]).toHaveTextContent('1')
    // Three rows, newest first; the loss row gets the L marker.
    const rows = h2hCard.querySelectorAll('.md-h2h__row')
    expect(rows).toHaveLength(3)
    expect(rows[0].querySelector('.md-h2h__result--l')).not.toBeNull()
    expect(rows[1].querySelector('.md-h2h__result--w')).not.toBeNull()
  })

  it('shows the rating change card when ratings moved', async () => {
    const match = matchDetails({
      id: 'm-rated',
      status: 'completed',
      status_label: 'Final',
      affects_rating: true,
      sides: [
        {
          side_number: 1,
          players: [
            { user_id: 'u-me', username: 'me', is_current_user: true },
          ],
          games_won: 3,
          won: true,
          is_current_user_side: true,
          rating_change: { before: 1500, after: 1512, delta: 12 },
        },
        {
          side_number: 2,
          players: [
            { user_id: 'u-opp', username: 'opp', is_current_user: false },
          ],
          games_won: 1,
          won: false,
          is_current_user_side: false,
          rating_change: { before: 1500, after: 1488, delta: -12 },
        },
      ],
      games: [],
      current_game: null,
      can_score: false,
    })
    server.use(http.get('*/v1/matches/m-rated', () => HttpResponse.json(match)))

    const { container } = renderDetails('m-rated')

    await waitFor(() => {
      const headings = Array.from(container.querySelectorAll('.md-card__hd h3'))
      expect(headings.map((h) => h.textContent)).toContain(
        'Result · rating change',
      )
    })
    const rows = container.querySelectorAll('.md-rating-row')
    expect(rows).toHaveLength(2)
    const [winnerRow, loserRow] = Array.from(rows)
    expect(
      winnerRow.querySelector('.md-rating-row__delta-num'),
    ).toHaveTextContent('+12')
    expect(
      winnerRow.querySelector('.md-rating-row__delta-num'),
    ).toHaveClass('md-delta-up')
    expect(
      loserRow.querySelector('.md-rating-row__delta-num'),
    ).toHaveTextContent('-12')
    expect(
      loserRow.querySelector('.md-rating-row__delta-num'),
    ).toHaveClass('md-delta-down')
  })

  it('hides the rating change card when no ratings have moved', async () => {
    const match = matchDetails({
      id: 'm-unrated',
      status: 'completed',
      affects_rating: false,
    })
    server.use(
      http.get('*/v1/matches/m-unrated', () => HttpResponse.json(match)),
    )

    const { container } = renderDetails('m-unrated')

    await waitFor(() =>
      expect(container.querySelector('.md-card__hd h3')).toBeInTheDocument(),
    )
    const headings = Array.from(container.querySelectorAll('.md-card__hd h3'))
    expect(headings.map((h) => h.textContent)).not.toContain(
      'Result · rating change',
    )
  })

  it('hides the rating change card while the match is still live', async () => {
    // A live match may carry seeded/projected ratings; surfacing them in a
    // "result" card mid-match contradicts the pre-match snapshot panel, so the
    // card stays hidden until the match is Final.
    const match = matchDetails({
      id: 'm-live-rated',
      status: 'in_progress',
      status_label: 'Live',
      affects_rating: true,
      sides: [
        {
          side_number: 1,
          players: [{ user_id: 'u-me', username: 'me', is_current_user: true }],
          games_won: 1,
          won: null,
          is_current_user_side: true,
          rating_change: { before: 1500, after: 1512, delta: 12 },
        },
        {
          side_number: 2,
          players: [
            { user_id: 'u-opp', username: 'opp', is_current_user: false },
          ],
          games_won: 0,
          won: null,
          is_current_user_side: false,
          rating_change: { before: 1500, after: 1488, delta: -12 },
        },
      ],
      games: [],
      current_game: null,
      can_score: false,
    })
    server.use(
      http.get('*/v1/matches/m-live-rated', () => HttpResponse.json(match)),
    )

    const { container } = renderDetails('m-live-rated')

    await waitFor(() =>
      expect(container.querySelector('.md-card__hd h3')).toBeInTheDocument(),
    )
    const headings = Array.from(container.querySelectorAll('.md-card__hd h3'))
    expect(headings.map((h) => h.textContent)).not.toContain(
      'Result · rating change',
    )
    expect(container.querySelector('.md-rating-row')).toBeNull()
  })

  it('renders Confirm/Dispute CTAs when can_confirm is true', async () => {
    const match = matchDetails({
      id: 'm-confirm',
      status: 'in_progress',
      status_label: 'Awaiting confirmation',
      sides: [
        {
          side_number: 1,
          players: [
            { user_id: 'u-me', username: 'me', is_current_user: true },
          ],
          games_won: 1,
          won: false,
          is_current_user_side: true,
        },
        {
          side_number: 2,
          players: [
            { user_id: 'u-opp', username: 'nguyen.t', is_current_user: false },
          ],
          games_won: 2,
          won: true,
          is_current_user_side: false,
        },
      ],
      can_confirm: true,
      signatures: [{ user_id: 'u-opp', signed_at: '2026-05-26T12:00:00Z' }],
    })
    let confirmHits = 0
    let disputeHits = 0
    server.use(
      http.get('*/v1/matches/m-confirm', () => HttpResponse.json(match)),
      http.post('*/v1/matches/m-confirm/confirmation', () => {
        confirmHits += 1
        return HttpResponse.json(
          { ...match, can_confirm: false, status: 'completed' },
          { status: 201 },
        )
      }),
      http.post('*/v1/matches/m-confirm/dispute', () => {
        disputeHits += 1
        return HttpResponse.json({ ...match, can_confirm: false })
      }),
    )

    const user = userEvent.setup()
    renderDetails('m-confirm')

    const confirmBtn = await screen.findByRole('button', {
      name: /confirm result/i,
    })
    const disputeBtn = screen.getByRole('button', { name: /^dispute$/i })
    expect(confirmBtn).toBeInTheDocument()
    expect(disputeBtn).toBeInTheDocument()

    await user.click(confirmBtn)
    await waitFor(() => expect(confirmHits).toBe(1))
    expect(disputeHits).toBe(0)
  })

  it('renders an "Awaiting <opponent>" indicator when the viewer is the signer', async () => {
    const match = matchDetails({
      id: 'm-await',
      status: 'in_progress',
      status_label: 'Awaiting confirmation',
      sides: [
        {
          side_number: 1,
          players: [
            { user_id: 'u-me', username: 'me', is_current_user: true },
          ],
          games_won: 3,
          won: true,
          is_current_user_side: true,
        },
        {
          side_number: 2,
          players: [
            { user_id: 'u-opp', username: 'nguyen.t', is_current_user: false },
          ],
          games_won: 1,
          won: false,
          is_current_user_side: false,
        },
      ],
      // We've signed (can_confirm false), the opponent hasn't.
      can_confirm: false,
      signatures: [{ user_id: 'u-me', signed_at: '2026-05-26T12:00:00Z' }],
    })
    server.use(
      http.get('*/v1/matches/m-await', () => HttpResponse.json(match)),
    )

    renderDetails('m-await')

    const callout = await screen.findByTestId('match-confirm-callout')
    expect(callout).toHaveTextContent(/awaiting/i)
    expect(callout).toHaveTextContent(/nguyen\.t/)
    expect(
      within(callout).queryByRole('button', { name: /confirm result/i }),
    ).not.toBeInTheDocument()
  })

  it('drops the "awaiting confirmation" notice once the match is finalized', async () => {
    // Regression for the stale-notice bug (#358): after the opponent confirms,
    // the match is Final but the viewer's signature stays in the response.
    // The passive "waiting on your opponent" callout must not linger.
    const match = matchDetails({
      id: 'm-final',
      status: 'completed',
      status_label: 'Final',
      sides: [
        {
          side_number: 1,
          players: [
            { user_id: 'u-me', username: 'me', is_current_user: true },
          ],
          games_won: 3,
          won: true,
          is_current_user_side: true,
        },
        {
          side_number: 2,
          players: [
            { user_id: 'u-opp', username: 'nguyen.t', is_current_user: false },
          ],
          games_won: 1,
          won: false,
          is_current_user_side: false,
        },
      ],
      can_confirm: false,
      // Both players have now signed; signatures persist as a historical record.
      signatures: [
        { user_id: 'u-me', signed_at: '2026-05-26T12:00:00Z' },
        { user_id: 'u-opp', signed_at: '2026-05-26T12:05:00Z' },
      ],
    })
    server.use(
      http.get('*/v1/matches/m-final', () => HttpResponse.json(match)),
    )

    renderDetails('m-final')

    // Wait for the page to render (the Final status is shown), then assert
    // the stale awaiting-confirmation callout is gone.
    await screen.findAllByText('Final')
    expect(screen.queryByTestId('match-confirm-callout')).not.toBeInTheDocument()
  })
})
