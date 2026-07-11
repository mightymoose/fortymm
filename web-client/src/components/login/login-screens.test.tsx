import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { act, render, screen } from '@/test/utilities'

import { ScreenEmail, ScreenSent, ScreenVerifyNetError } from './login-screens'

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

describe('ScreenEmail over-long address (#377)', () => {
  // An address over the RFC-5321 254-char cap used to test VALID client-side,
  // then 422 with a raw pydantic string. The client now rejects it up front.
  const overLong = `${'a'.repeat(250)}@example.com` // 262 chars

  it('flips the badge from VALID to FAILED when the address exceeds the length cap', async () => {
    const user = userEvent.setup()
    render(<ScreenEmail onSubmit={vi.fn()} />)

    const input = screen.getByLabelText('Email address')

    // A normal address is VALID.
    await user.type(input, 'rita@example.com')
    expect(screen.getByText(/VALID/)).toBeInTheDocument()
    expect(screen.queryByText(/FAILED/)).not.toBeInTheDocument()

    // Appending past the 254-char cap must drop the misleading VALID badge.
    await user.clear(input)
    await user.type(input, overLong)
    expect(screen.queryByText(/VALID/)).not.toBeInTheDocument()
  })

  it('does not submit an over-long address and surfaces friendly inline copy', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ScreenEmail onSubmit={onSubmit} />)

    const input = screen.getByLabelText('Email address')
    await user.type(input, overLong)
    await user.click(screen.getByRole('button', { name: /send the link/i }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(
      screen.getByText("That doesn't look like a valid email."),
    ).toBeInTheDocument()
    expect(screen.getByText(/FAILED/)).toBeInTheDocument()
  })
})

describe('ScreenEmail honeypot', () => {
  it('keeps the honeypot in the DOM but out of the accessibility tree', () => {
    render(<ScreenEmail onSubmit={vi.fn()} />)

    // The trap is still wired: bots parse the DOM, so the field must be there.
    expect(screen.getByTestId('login-honeypot')).toBeInTheDocument()

    // ...but a human never perceives it. `*ByRole` skips `aria-hidden`
    // subtrees, which is the same lens a screen reader uses.
    expect(
      screen.queryByRole('textbox', { name: /leave this empty/i }),
    ).toBeNull()
    expect(screen.getAllByRole('textbox')).toEqual([
      screen.getByLabelText('Email address'),
    ])
  })
})

describe('ScreenVerifyNetError fabricated diagnostics (#226)', () => {
  // This screen came in wholesale from a static design mockup, so it used to
  // render invented diagnostics at the user: a hostname we don't own and a
  // fake HTTP log (522s against /auth/verify endpoints that don't exist).
  // Never show the user a detail we didn't actually observe.
  it('renders no invented hostnames, status codes or request logs', () => {
    const { container } = render(<ScreenVerifyNetError />)
    const text = container.textContent ?? ''

    expect(text).not.toMatch(/auth\.fortymm\.com/)
    expect(text).not.toMatch(/522/)
    expect(text).not.toMatch(/\/auth\/verify/)
    expect(text).not.toMatch(/\/auth\/session/)
    expect(text).not.toMatch(/gave up after/i)
    expect(text).not.toMatch(/retry 2\/3/i)
  })

  it('still explains the failure and offers both recovery actions', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const onSendNewLink = vi.fn()
    render(
      <ScreenVerifyNetError onRetry={onRetry} onSendNewLink={onSendNewLink} />,
    )

    expect(
      screen.getByRole('heading', { name: /couldn.t reach fortymm/i }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /retry verification/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /send a new link/i }))
    expect(onSendNewLink).toHaveBeenCalledTimes(1)
  })
})
