import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_SHOWN_MS, SHOW_AFTER_MS } from '../components/LoadingScreen'
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

// React commits a timer's state update only once the act ends, so a test
// advances to each timer the loading screen starts in its own call.
function advance(ms: number): Promise<void> {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('Root', () => {
  beforeEach(() => {
    // Only the loading screen's own timers. React and MSW keep real ones.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows neither the page nor the loading screen while health is quick to answer', async () => {
    const health = holdHealth()
    const homePage = await visitHome()

    await advance(SHOW_AFTER_MS - 1)

    expect(homePage.loadingScreen).not.toBeInTheDocument()
    expect(homePage.queryTitle).not.toBeInTheDocument()
    expect(health.requests.map((request) => request.url)).toEqual([
      'http://localhost/api/v1/health',
    ])
  })

  it('shows the page without the loading screen when health answers in time', async () => {
    const health = holdHealth()
    const homePage = await visitHome()
    await advance(SHOW_AFTER_MS - 1)

    await health.respond(HttpResponse.json(healthyResponse))
    await advance(SHOW_AFTER_MS + MIN_SHOWN_MS)

    expect(homePage.title).toHaveTextContent('FortyMM')
    expect(homePage.loadingScreen).not.toBeInTheDocument()
  })

  it('shows the loading screen when health is slow to answer', async () => {
    holdHealth()
    const homePage = await visitHome()

    await advance(SHOW_AFTER_MS)

    expect(homePage.loadingScreen).toHaveTextContent('FortyMM')
    expect(homePage.loadingScreen).toHaveTextContent('Warming up…')
    expect(homePage.queryTitle).not.toBeInTheDocument()
  })

  it('moves the status line on after 1800ms', async () => {
    holdHealth()
    const homePage = await visitHome()
    await advance(SHOW_AFTER_MS)

    await advance(1800)

    expect(homePage.loadingScreen).toHaveTextContent('Setting the net…')
  })

  it('keeps the loading screen up for a bounce, over the page, before it fades', async () => {
    const health = holdHealth()
    const homePage = await visitHome()
    await advance(SHOW_AFTER_MS)

    await health.respond(HttpResponse.json(healthyResponse))
    await advance(MIN_SHOWN_MS - 1)

    expect(homePage.title).toHaveTextContent('FortyMM')
    expect(homePage.loadingScreen).toBeInTheDocument()
    expect(homePage.loadingScreenFading).toBe(false)

    await advance(1)

    expect(homePage.loadingScreenFading).toBe(true)
  })

  it('fades the loading screen as soon as health answers after a bounce', async () => {
    const health = holdHealth()
    const homePage = await visitHome()
    await advance(SHOW_AFTER_MS)
    await advance(MIN_SHOWN_MS + 2000)
    expect(homePage.loadingScreenFading).toBe(false)

    await health.respond(HttpResponse.json(healthyResponse))
    await advance(1)

    expect(homePage.title).toHaveTextContent('FortyMM')
    expect(homePage.loadingScreenFading).toBe(true)
  })

  it('removes the loading screen once its fade-out ends', async () => {
    const health = holdHealth()
    const homePage = await visitHome()
    await advance(SHOW_AFTER_MS)
    await health.respond(HttpResponse.json(healthyResponse))
    await advance(MIN_SHOWN_MS)

    homePage.endLoadingScreenFade()

    expect(homePage.loadingScreen).not.toBeInTheDocument()
    expect(homePage.title).toHaveTextContent('FortyMM')
  })

  it('does not show the loading screen or check health again on client-side navigation', async () => {
    const health = holdHealth()
    const homePage = await visitHome()
    await advance(SHOW_AFTER_MS)
    await health.respond(HttpResponse.json(healthyResponse))
    await advance(MIN_SHOWN_MS)
    homePage.endLoadingScreenFade()
    vi.useRealTimers()

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
    await advance(SHOW_AFTER_MS)

    await health.respond(
      HttpResponse.json({ detail: 'Service Unavailable' }, { status: 503 }),
    )
    await advance(0)

    expect(homePage.errorMessage).toBeInTheDocument()
    expect(homePage.loadingScreen).not.toBeInTheDocument()
    expect(homePage.queryTitle).not.toBeInTheDocument()
  })
})
