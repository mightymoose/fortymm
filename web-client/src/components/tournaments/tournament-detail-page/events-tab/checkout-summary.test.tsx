import { render, screen } from '@/test/utilities'

import { buildEvent } from '../../data/seed.factory'
import { CheckoutSummary } from './checkout-summary'
import { MAX_CHECKOUT_EVENTS } from './checkout-policy'

const callbacks = {
  onCheckout: vi.fn(),
  onRemoveSelection: vi.fn(),
}

afterEach(() => {
  vi.clearAllMocks()
})

it('locks selection removal while checkout creation is pending', () => {
  render(
    <CheckoutSummary
      selection={[buildEvent({ name: 'Open Singles', entryFee: 45 })]}
      pending
      {...callbacks}
    />,
  )

  expect(
    screen.getByRole('button', {
      name: 'Remove Open Singles from entry summary',
    }),
  ).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Check out · $45.00' })).toBeDisabled()
})

it('explains the checkout selection limit at 100 events', () => {
  render(
    <CheckoutSummary
      selection={Array.from({ length: MAX_CHECKOUT_EVENTS }, (_, index) =>
        buildEvent({ id: `event-${index}`, name: `Event ${index}`, entryFee: 10 }),
      )}
      pending={false}
      {...callbacks}
    />,
  )

  expect(screen.getByRole('status')).toHaveTextContent(
    'You can hold up to 100 events in one checkout.',
  )
  expect(screen.getByRole('button', { name: 'Check out · $1,000.00' })).toBeEnabled()
})
