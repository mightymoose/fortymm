import { act, render, screen } from '@/test/utilities'

import { CheckoutCountdown } from './checkout-countdown'

afterEach(() => {
  vi.useRealTimers()
})

it('keeps the countdown tied to the authoritative expiry across re-renders', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2030-04-20T14:00:05Z'))
  const onExpired = vi.fn()
  const view = render(
    <CheckoutCountdown expiresAt="2030-04-20T14:10:00Z" onExpired={onExpired} />,
  )
  expect(screen.getByLabelText('09:55 remaining')).toBeInTheDocument()

  view.rerender(<CheckoutCountdown expiresAt="2030-04-20T14:10:00Z" onExpired={onExpired} />)
  expect(screen.getByLabelText('09:55 remaining')).toBeInTheDocument()

  await act(() => vi.advanceTimersByTimeAsync(595_000))
  expect(onExpired).toHaveBeenCalledTimes(1)
})
