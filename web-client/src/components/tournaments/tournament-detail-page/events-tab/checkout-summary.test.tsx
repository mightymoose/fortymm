import { act, render, screen } from '@/test/utilities'

import type { TournamentCheckout } from '../../data/api'
import { buildEvent } from '../../data/seed.factory'
import { CheckoutSummary } from './checkout-summary'
import { MAX_CHECKOUT_EVENTS } from './checkout-policy'

const checkout: TournamentCheckout = {
  id: '00000000-0000-4000-8000-000000000001',
  requestId: '00000000-0000-4000-8000-000000000002',
  tournamentId: '00000000-0000-4000-8000-000000000003',
  registrationGeneration: 1,
  status: 'active',
  paymentState: 'unavailable',
  currency: 'USD',
  totalCents: 4500,
  createdAt: '2030-04-20T14:00:00Z',
  expiresAt: '2030-04-20T14:10:00Z',
  remainingSeconds: 600,
  lines: [{ eventId: 'event-1', eventName: 'Open Singles', priceCents: 4500 }],
}

const callbacks = {
  onHold: vi.fn(),
  onCancel: vi.fn(),
  onChange: vi.fn(),
  onExpired: vi.fn(),
  onRemoveSelection: vi.fn(),
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('locks selection removal while checkout creation is pending', () => {
  render(
    <CheckoutSummary
      selection={[buildEvent({ name: 'Open Singles', entryFee: 45 })]}
      checkout={null}
      pending
      {...callbacks}
    />,
  )

  expect(
    screen.getByRole('button', {
      name: 'Remove Open Singles from entry summary',
    }),
  ).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Hold 1 place' })).toBeDisabled()
})

it('explains the checkout selection limit at 100 events', () => {
  render(
    <CheckoutSummary
      selection={Array.from({ length: MAX_CHECKOUT_EVENTS }, (_, index) =>
        buildEvent({ id: `event-${index}`, name: `Event ${index}` }),
      )}
      checkout={null}
      pending={false}
      {...callbacks}
    />,
  )

  expect(screen.getByRole('status')).toHaveTextContent(
    'You can hold up to 100 events in one checkout.',
  )
  expect(screen.getByRole('button', { name: 'Hold 100 places' })).toBeEnabled()
})

it('keeps the countdown tied to the authoritative expiry across delayed refreshes', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2030-04-20T14:00:05Z'))
  const view = render(
    <CheckoutSummary
      selection={[]}
      checkout={checkout}
      pending={false}
      {...callbacks}
    />,
  )
  expect(screen.getByLabelText('09:55 remaining')).toBeInTheDocument()

  view.rerender(
    <CheckoutSummary
      selection={[]}
      checkout={{ ...checkout, remainingSeconds: 1 }}
      pending={false}
      {...callbacks}
    />,
  )
  expect(screen.getByLabelText('09:55 remaining')).toBeInTheDocument()

  await act(() => vi.advanceTimersByTimeAsync(595_000))
  expect(callbacks.onExpired).toHaveBeenCalledTimes(1)
})
