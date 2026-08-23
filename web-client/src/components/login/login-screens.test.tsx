import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { act, render, screen } from '@/test/utilities'

import { ScreenEmail, ScreenSent, ScreenVerifyNetError } from './login-screens'

// The real Turnstile loads a Cloudflare script jsdom can't execute, so these
// screen-level tests hand a token on mount — same stub as
// routes/login.test.tsx. Without it the submit button waits for a token that
// never comes (#1462).
vi.mock('@/components/turnstile', () => ({
  Turnstile: ({ onToken }: { onToken: (token: string) => void }) => {
    onToken('fake-captcha-token')
    return <div data-testid="fake-turnstile" />
  },
}))

describe('ScreenSent expiry countdown', () => {
  // 15-min link lifetime (mirrors the API).
  const LINK_TTL_MS = 15 * 60 * 1000

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks down each second from the deadline and flips to expired at zero', () => {
    const now = 1_700_000_000_000
    vi.setSystemTime(now)

    // Seed sentAt so only 3s remain.
    render(
      <ScreenSent email="rita@example.com" sentAt={now - (LINK_TTL_MS - 3000)} />,
    )

    const timer = screen.getByRole('timer')
    expect(timer).toHaveTextContent('00:03')
    expect(screen.getByText(/flying toward/i)).toBeInTheDocument()

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

  // Regression (#1466 defect 2): the subtitle used to be a fixed string that
  // always claimed a link was "flying toward" the address with "Expires in
  // 15" left, regardless of whether the link had actually expired. It must
  // now read the same "expired" value the countdown uses, so the two can
  // never disagree.
  it('drops the "flying toward" / "Expires in 15" claim once the link has expired, and agrees with the countdown', () => {
    const now = 1_700_000_000_000
    vi.setSystemTime(now)

    // Already past the deadline at first render.
    render(
      <ScreenSent email="rita@example.com" sentAt={now - LINK_TTL_MS - 1000} />,
    )

    expect(screen.getByRole('timer')).toHaveTextContent('00:00')
    expect(screen.getByText(/link expired/i)).toBeInTheDocument()

    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/flying toward/i)
    expect(text).not.toMatch(/expires in 15/i)
    expect(text).toMatch(/may have expired/i)
  })

  // Regression (#1466 defect 2, the "criterion Review is most likely to tick
  // with the defect still live"): opening /login/sent with no `sentAt` at all
  // (a bookmark, a shared URL) used to fall back to `Date.now()`, so the
  // subtitle and the countdown both lied that a link sent who-knows-how-long
  // ago was fresh. An unknown `sentAt` must render neither claim, and no
  // countdown widget should assert a specific state (fresh OR expired) for a
  // link whose age is genuinely unknown.
  it('does not claim freshness (or expiry) when sentAt is unknown, e.g. opened from a bookmark', () => {
    const now = 1_700_000_000_000
    vi.setSystemTime(now)

    render(<ScreenSent email="rita@example.com" />)

    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/flying toward/i)
    expect(text).not.toMatch(/expires in 15/i)
    expect(text).not.toMatch(/link expired/i)
    expect(screen.queryByRole('timer')).not.toBeInTheDocument()

    // Advancing time must not manufacture a countdown out of the unknown
    // sentAt either.
    act(() => {
      vi.advanceTimersByTime(LINK_TTL_MS + 5000)
    })
    expect(screen.queryByRole('timer')).not.toBeInTheDocument()
    const laterText = document.body.textContent ?? ''
    expect(laterText).not.toMatch(/flying toward/i)
    expect(laterText).not.toMatch(/expires in 15/i)
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

  it('takes the honeypot out of the focus order behind an inert wrapper (#1463)', () => {
    render(<ScreenEmail onSubmit={vi.fn()} />)

    const wrapper = screen.getByTestId('login-honeypot').closest('div')

    // A focusable input inside an aria-hidden wrapper is an ARIA violation;
    // `inert` removes it from the tab order and the a11y tree together.
    expect(wrapper).toHaveAttribute('inert')
    expect(wrapper).toHaveAttribute('aria-hidden', 'true')
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

describe('ScreenSent From row (#1466 defect 1)', () => {
  it('renders the bare sender address verbatim when given one', () => {
    render(<ScreenSent email="rita@example.com" sender="noreply@fortymm.com" />)

    expect(screen.getByText('noreply@fortymm.com')).toBeInTheDocument()
  })

  it('renders no From row at all when the API gives no address (undefined)', () => {
    render(<ScreenSent email="rita@example.com" />)

    expect(screen.queryByText('From')).not.toBeInTheDocument()
  })

  it('renders no From row at all when the API gives no address (null)', () => {
    render(<ScreenSent email="rita@example.com" sender={null} />)

    expect(screen.queryByText('From')).not.toBeInTheDocument()
    // The rest of the receipt still renders fine.
    expect(screen.getByText('Your FortyMM sign-in link')).toBeInTheDocument()
  })
})
