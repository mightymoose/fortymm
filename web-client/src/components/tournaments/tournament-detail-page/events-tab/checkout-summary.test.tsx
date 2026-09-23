import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { type ComponentProps, createContext, useContext } from 'react'

import { act, render, screen, waitFor } from '@/test/utilities'

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

type CheckoutSummaryProps = ComponentProps<typeof CheckoutSummary>

const CheckoutSummaryPropsContext = createContext<CheckoutSummaryProps | null>(null)

function RoutedCheckoutSummary() {
  const props = useContext(CheckoutSummaryPropsContext)
  if (!props) throw new Error('CheckoutSummary test props are missing')
  return <CheckoutSummary {...props} />
}

async function renderCheckoutSummary(props: CheckoutSummaryProps) {
  const rootRoute = createRootRoute()
  const summaryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tournaments/$tournamentId',
    component: RoutedCheckoutSummary,
  })
  const paymentRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tournaments/$tournamentId/checkouts/$checkoutId',
    component: () => <h1>Checkout payment</h1>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([summaryRoute, paymentRoute]),
    history: createMemoryHistory({
      initialEntries: [`/tournaments/${checkout.tournamentId}`],
    }),
  })
  await router.load()

  const view = render(
    <CheckoutSummaryPropsContext.Provider value={props}>
      <RouterProvider router={router} />
    </CheckoutSummaryPropsContext.Provider>,
  )

  return {
    ...view,
    router,
    rerenderSummary(nextProps: CheckoutSummaryProps) {
      view.rerender(
        <CheckoutSummaryPropsContext.Provider value={nextProps}>
          <RouterProvider router={router} />
        </CheckoutSummaryPropsContext.Provider>,
      )
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('locks selection removal while checkout creation is pending', async () => {
  await renderCheckoutSummary({
    selection: [buildEvent({ name: 'Open Singles', entryFee: 45 })],
    checkout: null,
    pending: true,
    ...callbacks,
  })

  expect(
    screen.getByRole('button', {
      name: 'Remove Open Singles from entry summary',
    }),
  ).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Hold 1 place' })).toBeDisabled()
})

it('explains the checkout selection limit at 100 events', async () => {
  await renderCheckoutSummary({
    selection: Array.from({ length: MAX_CHECKOUT_EVENTS }, (_, index) =>
      buildEvent({ id: `event-${index}`, name: `Event ${index}` }),
    ),
    checkout: null,
    pending: false,
    ...callbacks,
  })

  expect(screen.getByRole('status')).toHaveTextContent(
    'You can hold up to 100 events in one checkout.',
  )
  expect(screen.getByRole('button', { name: 'Hold 100 places' })).toBeEnabled()
})

it('uses server remaining time on a monotonic clock and removes payment at zero', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2040-04-20T14:00:00Z'))
  await renderCheckoutSummary({
    selection: [],
    checkout: {
      ...checkout,
      // The device clock is ten years ahead of this server-owned absolute
      // timestamp. The response duration is authoritative for local display.
      remainingSeconds: 2,
    },
    pending: false,
    ...callbacks,
  })
  expect(screen.getByLabelText('00:02 remaining')).toBeInTheDocument()
  expect(
    screen.getByRole('link', { name: 'Continue to payment' }),
  ).toBeInTheDocument()

  // A wall-clock correction after receipt must not move the monotonic hold.
  vi.setSystemTime(new Date('2060-04-20T14:00:00Z'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000)
  })
  expect(screen.getByLabelText('00:01 remaining')).toBeInTheDocument()
  expect(
    screen.getByRole('link', { name: 'Continue to payment' }),
  ).toBeInTheDocument()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000)
  })
  expect(screen.getByLabelText('00:00 remaining')).toBeInTheDocument()
  expect(callbacks.onExpired).toHaveBeenCalledTimes(1)
  expect(
    screen.queryByRole('link', { name: 'Continue to payment' }),
  ).not.toBeInTheDocument()
})

it('does not restart cached remaining time when the summary mounts or remounts late', async () => {
  vi.useFakeTimers()
  const cachedCheckout: TournamentCheckout & {
    remainingSecondsObservedAt: number
  } = {
    ...checkout,
    remainingSeconds: 2,
    // Query data must carry the monotonic instant at which this server-owned
    // duration was received. Components may mount long after the cache fills.
    remainingSecondsObservedAt: performance.now(),
  }

  await vi.advanceTimersByTimeAsync(1_000)
  const firstMount = await renderCheckoutSummary({
    selection: [],
    checkout: cachedCheckout,
    pending: false,
    ...callbacks,
  })

  expect(screen.getByLabelText('00:01 remaining')).toBeInTheDocument()
  expect(
    screen.getByRole('link', { name: 'Continue to payment' }),
  ).toBeInTheDocument()

  firstMount.unmount()
  await vi.advanceTimersByTimeAsync(1_000)
  await renderCheckoutSummary({
    selection: [],
    checkout: cachedCheckout,
    pending: false,
    ...callbacks,
  })

  expect(screen.getByLabelText('00:00 remaining')).toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: 'Continue to payment' }),
  ).not.toBeInTheDocument()
})

it('describes paid held places as ready to continue instead of unavailable', async () => {
  await renderCheckoutSummary({
    selection: [],
    checkout,
    pending: false,
    ...callbacks,
  })

  expect(
    screen.getByText(/places.*held.*while you complete payment/i),
  ).toBeInTheDocument()
  expect(screen.queryByText(/payment collection isn.t available/i)).toBeNull()
})

it('navigates to the checkout payment page through the app router', async () => {
  const user = userEvent.setup()
  const { router } = await renderCheckoutSummary({
    selection: [],
    checkout,
    pending: false,
    ...callbacks,
  })

  await user.click(screen.getByRole('link', { name: /continue to payment/i }))

  await waitFor(() =>
    expect(router.history.location.pathname).toBe(
      `/tournaments/${checkout.tournamentId}/checkouts/${checkout.id}`,
    ),
  )
  expect(
    screen.getByRole('heading', { name: 'Checkout payment' }),
  ).toBeInTheDocument()
})

it('makes continue to payment non-navigable while an action is pending', async () => {
  const user = userEvent.setup()
  const { router } = await renderCheckoutSummary({
    selection: [],
    checkout,
    pending: true,
    ...callbacks,
  })

  const continueButton = screen.getByRole('button', {
    name: /continue to payment/i,
  })
  expect(continueButton).toBeDisabled()

  await user.click(continueButton)

  expect(router.history.location.pathname).toBe(
    `/tournaments/${checkout.tournamentId}`,
  )
})
