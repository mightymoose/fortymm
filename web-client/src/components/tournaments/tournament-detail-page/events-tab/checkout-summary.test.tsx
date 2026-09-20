import { act, render, screen } from '@/test/utilities'

import type { TournamentCheckout } from '../../data/api'
import { CheckoutSummary } from './checkout-summary'

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
  onReserve: vi.fn(),
  onCancel: vi.fn(),
  onChange: vi.fn(),
  onExpired: vi.fn(),
  onRemoveSelection: vi.fn(),
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('adopts a shorter authoritative duration when the checkout refreshes', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2030-04-20T14:00:00Z'))
  const view = render(
    <CheckoutSummary
      selection={[]}
      checkout={checkout}
      pending={false}
      {...callbacks}
    />,
  )
  expect(screen.getByLabelText('10:00 remaining')).toBeInTheDocument()

  view.rerender(
    <CheckoutSummary
      selection={[]}
      checkout={{ ...checkout, remainingSeconds: 1 }}
      pending={false}
      {...callbacks}
    />,
  )
  expect(screen.getByLabelText('00:01 remaining')).toBeInTheDocument()

  await act(() => vi.advanceTimersByTimeAsync(1_000))
  expect(callbacks.onExpired).toHaveBeenCalledTimes(1)
})
