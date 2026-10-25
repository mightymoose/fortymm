import { act, screen } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_SHOWN_MS,
  SHOW_AFTER_MS,
  SLOW_AFTER_MS,
  SLOW_STATUS,
  STATUS,
} from '../components/LoadingScreen'
import { HomePage } from '../test/pages/HomePage'
import { sessionResponse, holdSession } from '../test/server'

function visitHome(): Promise<HomePage> {
  return HomePage.render({ waitForSession: false })
}

// React commits a timer's state update only once the act ends, so a test
// advances to each timer the loading screen starts in its own call.
function advance(ms: number): Promise<void> {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('AuthenticatedLayout', () => {
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

  it('shows neither the page nor the loading screen while the session is quick to start', async () => {
    const session = holdSession()
    const homePage = await visitHome()

    await advance(SHOW_AFTER_MS - 1)

    expect(homePage.loadingScreen).not.toBeInTheDocument()
    expect(homePage.queryTitle).not.toBeInTheDocument()
    expect(
      session.requests.map((request) => [
        request.method,
        request.url,
        request.headers.get('Content-Type'),
      ]),
    ).toEqual([['POST', 'http://localhost/api/v1/session', 'application/json']])
  })

  it('shows the page without the loading screen when the session starts in time', async () => {
    const session = holdSession()
    const homePage = await visitHome()
    await advance(SHOW_AFTER_MS - 1)

    await session.respond(HttpResponse.json(sessionResponse))
    await advance(SHOW_AFTER_MS + MIN_SHOWN_MS)

    expect(homePage.title).toHaveTextContent('What’s coming, and when.')
    expect(homePage.loadingScreen).not.toBeInTheDocument()
  })

  it('shows the loading screen when the session is slow to start', async () => {
    holdSession()
    const homePage = await visitHome()

    await advance(SHOW_AFTER_MS)

    expect(homePage.loadingScreen).toHaveTextContent('FortyMM')
    expect(homePage.loadingScreen).toHaveTextContent(STATUS)
    expect(homePage.queryTitle).not.toBeInTheDocument()
  })

  it('says why a slow load is slow', async () => {
    holdSession()
    const homePage = await visitHome()
    await advance(SHOW_AFTER_MS)

    await advance(SLOW_AFTER_MS)

    expect(homePage.loadingScreen).toHaveTextContent(SLOW_STATUS)
  })

  it('keeps the loading screen up for its minimum, over the page, before it fades', async () => {
    const session = holdSession()
    const homePage = await visitHome()
    await advance(SHOW_AFTER_MS)

    await session.respond(HttpResponse.json(sessionResponse))
    await advance(MIN_SHOWN_MS - 1)

    expect(homePage.title).toHaveTextContent('What’s coming, and when.')
    expect(homePage.loadingScreen).toBeInTheDocument()
    expect(homePage.loadingScreenFading).toBe(false)

    await advance(1)

    expect(homePage.loadingScreenFading).toBe(true)
  })

  it('fades the loading screen as soon as the session starts after its minimum', async () => {
    const session = holdSession()
    const homePage = await visitHome()
    await advance(SHOW_AFTER_MS)
    await advance(MIN_SHOWN_MS + 2000)
    expect(homePage.loadingScreenFading).toBe(false)

    await session.respond(HttpResponse.json(sessionResponse))
    await advance(1)

    expect(homePage.title).toHaveTextContent('What’s coming, and when.')
    expect(homePage.loadingScreenFading).toBe(true)
  })

  it('removes the loading screen once its fade-out ends', async () => {
    const session = holdSession()
    const homePage = await visitHome()
    await advance(SHOW_AFTER_MS)
    await session.respond(HttpResponse.json(sessionResponse))
    await advance(MIN_SHOWN_MS)

    homePage.endLoadingScreenFade()

    expect(homePage.loadingScreen).not.toBeInTheDocument()
    expect(homePage.title).toHaveTextContent('What’s coming, and when.')
  })

  it('does not show the loading screen or start the session again on client-side navigation', async () => {
    const session = holdSession()
    const homePage = await visitHome()
    await advance(SHOW_AFTER_MS)
    await session.respond(HttpResponse.json(sessionResponse))
    await advance(MIN_SHOWN_MS)
    homePage.endLoadingScreenFade()
    vi.useRealTimers()

    await homePage.navigate('/design-system')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Design System' }),
    ).toBeInTheDocument()
    await homePage.navigate('/')

    expect(homePage.title).toHaveTextContent('What’s coming, and when.')
    expect(homePage.loadingScreen).not.toBeInTheDocument()
    expect(session.requests).toHaveLength(1)
  })

  it('shows the error page instead of the loading screen when the session fails to start', async () => {
    // React and the router log the error the page shows.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = holdSession()
    const homePage = await visitHome()
    await advance(SHOW_AFTER_MS)

    await session.respond(
      HttpResponse.json({ detail: 'Service Unavailable' }, { status: 503 }),
    )
    await advance(0)

    expect(homePage.queryTitle).toHaveTextContent('Can’t reach FortyMM')
    expect(homePage.loadingScreen).not.toBeInTheDocument()
    expect(homePage.homeLink).not.toBeInTheDocument()
  })
})
