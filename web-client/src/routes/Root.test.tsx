import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOADING_SCREEN_MS } from '../router'
import { HomePage } from '../test/pages/HomePage'

describe('Root', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function visitHome(): Promise<HomePage> {
    return HomePage.render({ loadingScreenMs: LOADING_SCREEN_MS })
  }

  it('shows the loading screen instead of the page on a page load', async () => {
    const homePage = await visitHome()

    expect(homePage.loadingScreen).toHaveTextContent('FortyMM')
    expect(homePage.loadingScreen).toHaveTextContent('Warming up…')
    expect(homePage.queryTitle).not.toBeInTheDocument()
  })

  it('moves the status line on after 1800ms', async () => {
    const homePage = await visitHome()

    await act(() => vi.advanceTimersByTimeAsync(1800))

    expect(homePage.loadingScreen).toHaveTextContent('Setting the net…')
  })

  it('shows the page after 3 seconds', async () => {
    const homePage = await visitHome()

    await act(() => vi.advanceTimersByTimeAsync(LOADING_SCREEN_MS - 1))
    expect(homePage.loadingScreen).toBeInTheDocument()
    expect(homePage.queryTitle).not.toBeInTheDocument()

    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(homePage.loadingScreen).not.toBeInTheDocument()
    expect(homePage.title).toHaveTextContent('FortyMM')
  })

  it('does not show the loading screen again on client-side navigation', async () => {
    const homePage = await visitHome()
    await act(() => vi.advanceTimersByTimeAsync(LOADING_SCREEN_MS))
    // Client-side navigation does not finish under fake timers.
    vi.useRealTimers()

    await userEvent.click(homePage.designSystemLink)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Design System' }),
    ).toBeInTheDocument()
    expect(homePage.loadingScreen).not.toBeInTheDocument()
  })
})
