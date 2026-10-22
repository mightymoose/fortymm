import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomePage } from '../test/pages/HomePage'
import { API_BASE_URL, healthyResponse, server } from '../test/server'

// Holds the mock API's health responses until the test sends them.
function holdHealth() {
  const requests: Request[] = []
  const pending: ((response: Response) => void)[] = []
  server.use(
    http.get(`${API_BASE_URL}/v1/health`, ({ request }) => {
      requests.push(request)
      return new Promise<Response>((resolve) => pending.push(resolve))
    }),
  )
  return {
    requests,
    async respond(response: Response): Promise<void> {
      await act(async () => pending.shift()!(response))
    },
  }
}

function visitHome(): Promise<HomePage> {
  return HomePage.render({ waitForHealth: false })
}

describe('Root', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows the loading screen instead of the page until health answers', async () => {
    const health = holdHealth()
    const homePage = await visitHome()

    expect(homePage.loadingScreen).toHaveTextContent('FortyMM')
    expect(homePage.loadingScreen).toHaveTextContent('Warming up…')
    expect(homePage.queryTitle).not.toBeInTheDocument()
    expect(health.requests.map((request) => request.url)).toEqual([
      'http://localhost/api/v1/health',
    ])
  })

  it('moves the status line on after 1800ms', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    holdHealth()
    const homePage = await visitHome()

    await act(() => vi.advanceTimersByTimeAsync(1800))

    expect(homePage.loadingScreen).toHaveTextContent('Setting the net…')
  })

  it('shows the page under the loading screen once health answers', async () => {
    const health = holdHealth()
    const homePage = await visitHome()

    await health.respond(HttpResponse.json(healthyResponse))

    expect(await homePage.findTitle()).toHaveTextContent('FortyMM')
    expect(homePage.loadingScreen).toBeInTheDocument()
  })

  it('removes the loading screen once its fade-out ends', async () => {
    const health = holdHealth()
    const homePage = await visitHome()
    await health.respond(HttpResponse.json(healthyResponse))
    await homePage.findTitle()

    homePage.endLoadingScreenFade()

    expect(homePage.loadingScreen).not.toBeInTheDocument()
    expect(homePage.title).toHaveTextContent('FortyMM')
  })

  it('does not show the loading screen or check health again on client-side navigation', async () => {
    const health = holdHealth()
    const homePage = await visitHome()
    await health.respond(HttpResponse.json(healthyResponse))
    await homePage.findTitle()
    homePage.endLoadingScreenFade()

    await userEvent.click(homePage.designSystemLink)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Design System' }),
    ).toBeInTheDocument()
    expect(homePage.loadingScreen).not.toBeInTheDocument()
    expect(health.requests).toHaveLength(1)
  })

  it('shows an error instead of the loading screen when health fails', async () => {
    // React and the router log the error the page shows.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const health = holdHealth()
    const homePage = await visitHome()

    await health.respond(
      HttpResponse.json({ detail: 'Service Unavailable' }, { status: 503 }),
    )

    await waitFor(() => expect(homePage.errorMessage).toBeInTheDocument())
    expect(homePage.loadingScreen).not.toBeInTheDocument()
    expect(homePage.queryTitle).not.toBeInTheDocument()
  })
})
