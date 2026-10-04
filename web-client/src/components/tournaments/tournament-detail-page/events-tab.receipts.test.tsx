import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import { CHECKOUT_TOURNAMENT_ID } from '@/mocks/factories/checkouts/checkout.factory'
import { mockUuid } from '@/mocks/mock-uuid'
import { server } from '@/mocks/server'
import { render, screen, within } from '@/test/utilities'

import { buildEvent, buildTournament } from '../data/seed.factory'
import { EventsTab } from './events-tab'
import { buildEventsTabProps } from './events-tab.factory'

const PAYMENT_ID = mockUuid('receipt-list-payment')

const tournament = () =>
  buildTournament({
    id: CHECKOUT_TOURNAMENT_ID,
    events: [buildEvent({ name: 'Open Singles', entryFee: 45 })],
  })

const servePayments = (payments: unknown[]) =>
  server.use(
    http.get(`*/v1/tournaments/${CHECKOUT_TOURNAMENT_ID}/payments`, () =>
      HttpResponse.json(payments),
    ),
  )

describe('EventsTab receipts (#1810)', () => {
  it('links each succeeded payment to its receipt, for a payer who left before success', async () => {
    servePayments([
      {
        id: PAYMENT_ID,
        reference: 'PAY-7K3M9QX2',
        amount_cents: 7_500,
        created_at: new Date().toISOString(),
        event_names: ['Open Singles', 'U1500'],
      },
    ])
    const onViewReceipt = vi.fn()
    const user = userEvent.setup()
    render(
      <EventsTab
        {...buildEventsTabProps({ tournament: tournament(), canEdit: false })}
        onViewReceipt={onViewReceipt}
      />,
    )

    const section = await screen.findByRole('region', { name: 'Your receipts' })
    const link = within(section).getByRole('link', {
      name: 'Open Singles, U1500 · $75.00',
    })
    expect(link).toHaveAttribute('href', `/payments/${PAYMENT_ID}/receipt`)

    await user.click(link)

    expect(onViewReceipt).toHaveBeenCalledWith(PAYMENT_ID)
  })

  it('shows no receipts section when the player has paid for nothing here', async () => {
    servePayments([])
    render(
      <EventsTab {...buildEventsTabProps({ tournament: tournament(), canEdit: false })} />,
    )

    await screen.findByText('Open Singles')
    expect(screen.queryByRole('region', { name: 'Your receipts' })).not.toBeInTheDocument()
  })
})
