import { act, screen } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_SHOWN_MS, SHOW_AFTER_MS } from '../components/LoadingScreen'
import { DesignSystemPage } from '../test/pages/DesignSystemPage'
import { healthyResponse, holdHealth } from '../test/server'

describe('Root', () => {
  beforeEach(() => {
    // Only the loading screen's own timers. React and MSW keep real ones.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the design system page without checking health or showing the loading screen', async () => {
    const health = holdHealth()
    const designSystemPage = await DesignSystemPage.render()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHOW_AFTER_MS + MIN_SHOWN_MS)
    })

    expect(designSystemPage.title).toHaveTextContent('Design System')
    expect(designSystemPage.loadingScreen).not.toBeInTheDocument()
    expect(health.requests).toHaveLength(0)
  })

  it('checks health once, on the first visit to an authenticated page', async () => {
    const health = holdHealth()
    const designSystemPage = await DesignSystemPage.render()
    vi.useRealTimers()

    await designSystemPage.navigate('/')
    await vi.waitFor(() => expect(health.requests).toHaveLength(1))
    await health.respond(HttpResponse.json(healthyResponse))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'FortyMM' }),
    ).toBeInTheDocument()

    await designSystemPage.navigate('/design-system')
    await screen.findByRole('heading', { level: 1, name: 'Design System' })
    await designSystemPage.navigate('/')

    expect(
      await screen.findByRole('heading', { level: 1, name: 'FortyMM' }),
    ).toBeInTheDocument()
    expect(designSystemPage.loadingScreen).not.toBeInTheDocument()
    expect(health.requests).toHaveLength(1)
  })

  it('shows the design system page without the sidebar', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.sidebar).not.toBeInTheDocument()
  })
})
