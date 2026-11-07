import { act, screen } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_SHOWN_MS, SHOW_AFTER_MS } from '../components/LoadingScreen'
import { DesignSystemPage } from '../test/pages/DesignSystemPage'
import { queueResult } from '../scoring/results'
import { sessionResponse, holdSession, mockApprovals } from '../test/server'

describe('Root', () => {
  beforeEach(() => {
    // Only the router's and the loading screen's timers, and the clock the
    // router times them by. React and MSW keep real ones.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the design system page without starting a session or showing the loading screen', async () => {
    const session = holdSession()
    const designSystemPage = await DesignSystemPage.render()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHOW_AFTER_MS + MIN_SHOWN_MS)
    })

    expect(designSystemPage.title).toHaveTextContent('Design System')
    expect(designSystemPage.loadingScreen).not.toBeInTheDocument()
    expect(session.requests).toHaveLength(0)
  })

  it('sends no queued result from a public page, which has no session', async () => {
    const session = holdSession()
    const approvals = mockApprovals()
    queueResult('01970000-0000-7000-8000-0000000000c8', 'AA')
    await DesignSystemPage.render()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHOW_AFTER_MS + MIN_SHOWN_MS)
    })

    expect(approvals.checks).toHaveLength(0)
    expect(session.requests).toHaveLength(0)
  })

  it('starts the session once, on the first visit to an authenticated page', async () => {
    const session = holdSession()
    const designSystemPage = await DesignSystemPage.render()
    vi.useRealTimers()

    // The navigation waits for the session, so it ends after the response.
    const navigation = designSystemPage.navigate('/')
    await vi.waitFor(() => expect(session.requests).toHaveLength(1))
    await session.respond(HttpResponse.json(sessionResponse))
    await navigation
    expect(
      await screen.findByRole('heading', { level: 1, name: 'What’s coming, and when.' }),
    ).toBeInTheDocument()

    await designSystemPage.navigate('/design-system')
    await screen.findByRole('heading', { level: 1, name: 'Design System' })
    await designSystemPage.navigate('/')

    expect(
      await screen.findByRole('heading', { level: 1, name: 'What’s coming, and when.' }),
    ).toBeInTheDocument()
    expect(designSystemPage.loadingScreen).not.toBeInTheDocument()
    expect(session.requests).toHaveLength(1)
  })

  it('shows the design system page without the sidebar', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.sidebar).not.toBeInTheDocument()
  })
})
