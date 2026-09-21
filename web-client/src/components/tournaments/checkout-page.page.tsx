import { screen } from '@testing-library/react'
import { vi } from 'vitest'

import { renderWithRouterContext } from '@/test/router'
import {
  CheckoutPage,
  type CheckoutBrowserPaymentAdapter,
} from './checkout-page'

export const checkoutPage = {
  render(
    paymentAdapter: CheckoutBrowserPaymentAdapter,
    initialEntry = '/tournaments/tournament-1770/checkouts/checkout-1770',
  ) {
    const renderedAt = Date.now()
    // Network-backed components and fake timers are a known flaky combination in
    // this repository. Capture the test's clock for the explicit `now` seam, then
    // restore real scheduling so MSW and Testing Library can settle normally.
    if (vi.isFakeTimers()) vi.useRealTimers()
    return renderWithRouterContext(
      <CheckoutPage
        tournamentId="tournament-1770"
        checkoutId="checkout-1770"
        paymentAdapter={paymentAdapter}
        now={() => renderedAt}
      />,
      { initialEntries: [initialEntry] },
    )
  },
  getPage() {
    return screen.getByRole('main', { name: /checkout/i })
  },
  getReceiptEmail() {
    return screen.getByRole('textbox', { name: /receipt email/i })
  },
  getCardAction() {
    return screen.getByRole('button', { name: /pay/i })
  },
}
