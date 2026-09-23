import { http, HttpResponse } from 'msw'

import { server } from '@/mocks/server'
import { screen, waitFor } from '@/test/utilities'

import { buildTournament, buildEvent } from '../data/seed.factory'
import { eventsTabPage } from './events-tab.page'

const eventId = '00000000-0000-4000-8000-000000000071'

function checkout(status: string, paymentState: string) {
  return {
    id: '00000000-0000-4000-8000-000000000072',
    request_id: '00000000-0000-4000-8000-000000000073',
    tournament_id: '00000000-0000-4000-8000-000000000020',
    registration_generation: 0,
    status,
    payment_state: paymentState,
    currency: 'USD',
    total_cents: 4500,
    created_at: new Date(Date.now() - 601_000).toISOString(),
    expires_at: new Date(Date.now() - 1_000).toISOString(),
    remaining_seconds: status === 'active' ? 600 : 0,
    lines: [
      {
        event_id: eventId,
        event_name: 'Open Singles',
        price_cents: 4500,
      },
    ],
  }
}

function renderCheckout(
  status: string,
  paymentState: string,
  tournamentOverrides: Record<string, unknown> = {},
) {
  let reads = 0
  server.use(
    http.get('*/v1/tournaments/:tournamentId/checkouts/current', () => {
      reads += 1
      return HttpResponse.json(checkout(status, paymentState))
    }),
  )
  eventsTabPage.render({
    tournament: buildTournament({
      ...tournamentOverrides,
      events: [buildEvent({ id: eventId, name: 'Open Singles', entryFee: 45 })],
    }),
  })
  return () => reads
}

describe('EventsTab checkout recovery', () => {
  it.each([
    ['ready', 'expired'],
    ['action_required', 'cancelled'],
    ['expired', 'expired'],
  ] as const)(
    'renders a closed bound %s payment as a nonpayable blocker',
    async (paymentState, status) => {
      renderCheckout(status, paymentState)

      expect(await screen.findByText('Payment in progress')).toBeInTheDocument()
      expect(screen.queryByText('Your held places')).toBeNull()
      expect(screen.getByText('Payment is still being confirmed')).toBeInTheDocument()
      expect(eventsTabPage.querySelectButton('Open Singles')).toBeNull()
      expect(
        screen.queryByRole('link', { name: 'Continue to payment' }),
      ).toBeNull()
      expect(screen.queryByRole('button', { name: 'Release hold' })).toBeNull()
    },
  )

  it('does not expose closed terminal history as a checkout blocker', async () => {
    renderCheckout('cancelled', 'canceled')

    const select = await eventsTabPage.findSelectButton('Open Singles')
    await waitFor(() => expect(select).toBeEnabled())
    expect(screen.queryByText('Payment in progress')).toBeNull()
    expect(screen.queryByText('Your held places')).toBeNull()
  })

  it('keeps the hold title for an active checkout', async () => {
    renderCheckout('active', 'ready')

    expect(await screen.findByText('Your held places')).toBeInTheDocument()
    expect(screen.queryByText('Payment in progress')).toBeNull()
  })

  it.each([
    ['checkout unavailable', { checkoutAvailable: false }],
    ['registration closed', { registrationOpen: false }],
  ])(
    'cold-discovers an unresolved blocker when %s',
    async (_label, tournamentOverrides) => {
      const reads = renderCheckout('expired', 'checking', tournamentOverrides)

      expect(await screen.findByText('Payment in progress')).toBeInTheDocument()
      expect(reads()).toBe(1)
      expect(eventsTabPage.querySelectButton('Open Singles')).toBeNull()
      expect(screen.queryByRole('button', { name: /Hold .* place/ })).toBeNull()
    },
  )
})
