import { userEvent } from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { act, fireEvent, screen } from '@testing-library/react'

import { render } from '@/test/utilities'
import { server } from '@/mocks/server'

import { opponentPickerPage } from '@/components/matches/opponent-picker.page'
import { FirstMatchCard } from './first-match-card'

function renderFirstMatchCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: FirstMatchCard,
  })
  const scoringRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameNumber/scores/new',
    component: () => <div>scoring route</div>,
  })
  const matchDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    component: () => <div>match detail route</div>,
  })
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div>login route</div>,
  })
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => <div>settings route</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      scoringRoute,
      matchDetailRoute,
      loginRoute,
      settingsRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router }
}

async function pickNguyen() {
  const combobox = await screen.findByRole('combobox')
  await userEvent.type(combobox, 'nguyen')
  const option = await opponentPickerPage.findOption(/nguyen\.t/)
  await userEvent.click(option)
}

describe('FirstMatchCard', () => {
  it('opens straight into search and disables Start scoring with no opponent', async () => {
    renderFirstMatchCard()

    expect(await screen.findByRole('combobox')).toBeInTheDocument()
    const startButton = screen.getByRole('button', { name: /start scoring/i })
    expect(startButton).toBeDisabled()
    expect(
      screen.getByText('Pick who you played to set the match format.'),
    ).toBeInTheDocument()
  })

  it('reveals the format fields and a rated summary once an opponent is picked', async () => {
    renderFirstMatchCard()

    await pickNguyen()

    expect(screen.getByText('nguyen.t')).toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: /^5/ }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      screen.getByRole('switch', { name: 'Rated match' }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      screen.getByText('Best of 5 · first to 3 · rated'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start scoring/i })).toBeEnabled()
  })

  it('clears the opponent and resets rated on Change', async () => {
    renderFirstMatchCard()
    await pickNguyen()

    await userEvent.click(screen.getByRole('button', { name: 'Change' }))

    expect(await screen.findByRole('combobox')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start scoring/i })).toBeDisabled()
  })

  it('creates the match and navigates to scoring on submit', async () => {
    const { router } = renderFirstMatchCard()
    await pickNguyen()

    await userEvent.click(screen.getByRole('button', { name: /start scoring/i }))

    await screen.findByText(/scoring route|match detail route/)
    expect(router.state.location.pathname).toMatch(/^\/matches\//)
  })

  it('refuses a double-submit and only creates one match', async () => {
    let postCount = 0
    server.use(
      http.post('*/v1/matches', async () => {
        postCount += 1
        return HttpResponse.json(
          {
            id: 'm-double',
            best_of: 5,
            affects_rating: true,
            status: 'in_progress',
            created_at: new Date(0).toISOString(),
            completed_at: null,
            current_game: { game_number: 1 },
            opponent: { id: 'p-nguyen', username: 'nguyen.t' },
            games: [],
            results: [],
            // `useCreateMatch` seeds the match-details cache from this
            // response via `matchDetailsResultFromPayload`, which parses
            // `data.scoreboard.status` — omitting it throws and the mutation
            // rejects before navigation ever happens.
            data: { scoreboard: { status: 'live' } },
          },
          { status: 201 },
        )
      }),
    )
    renderFirstMatchCard()
    await pickNguyen()

    // Fire both clicks before either settles, mirroring a rapid double-click
    // that lands before `isPending` disables the button.
    const startButton = screen.getByRole('button', { name: /start scoring/i })
    await act(async () => {
      fireEvent.click(startButton)
      fireEvent.click(startButton)
      await new Promise((r) => setTimeout(r, 0))
    })
    await screen.findByText(/scoring route|match detail route/)

    expect(postCount).toBe(1)
  })

  it('surfaces a server error in an alert', async () => {
    // A lapsed session is a `session_ended` 401 that the global middleware
    // catches and redirects to `/login` (covered in api/client.test.ts); any
    // other failure surfaces inline here.
    server.use(
      http.post('*/v1/matches', () =>
        HttpResponse.json(
          { detail: 'Could not start the match right now.' },
          { status: 500 },
        ),
      ),
    )
    renderFirstMatchCard()
    await pickNguyen()

    await userEvent.click(
      screen.getByRole('button', { name: /start scoring/i }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not start the match right now.')
  })
})
