import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { act, render, screen } from '@/test/utilities'

import { ScreenSent } from './login-screens'

describe('ScreenSent expiry countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks down each second from the deadline and flips to expired at zero', () => {
    const now = 1_700_000_000_000
    vi.setSystemTime(now)

    // 15-min link lifetime (mirrors the API); seed sentAt so only 3s remain.
    const LINK_TTL_MS = 15 * 60 * 1000
    render(
      <ScreenSent email="rita@example.com" sentAt={now - (LINK_TTL_MS - 3000)} />,
    )

    const timer = screen.getByRole('timer')
    expect(timer).toHaveTextContent('00:03')

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByRole('timer')).toHaveTextContent('00:02')

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByRole('timer')).toHaveTextContent('00:00')
    expect(screen.getByText(/link expired/i)).toBeInTheDocument()
  })
})
