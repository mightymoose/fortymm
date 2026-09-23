import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { toast } from 'sonner'

import { mockEventEnterEndpoint } from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import { buildTournamentEntrantRead } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { render, screen, waitFor } from '@/test/utilities'

import {
  buildDrawnEvent,
  buildTournament,
  buildEntrant,
  buildEntrants,
  buildEvent,
  groupIdFor,
} from '../data/seed.factory'
import { eventsTabPage } from './events-tab.page'
import { EventsTab } from './events-tab'
import { buildEventsTabProps } from './events-tab.factory'

vi.mock('sonner', async () => {
  const actual = await vi.importActual<typeof import('sonner')>('sonner')
  return {
    ...actual,
    toast: { ...actual.toast, error: vi.fn() },
  }
})

beforeEach(() => {
  vi.mocked(toast.error).mockClear()
})

describe('EventsTab', () => {
  it('opens an event from its card', async () => {
    const onOpenEvent = vi.fn()
    eventsTabPage.render({
      tournament: buildTournament({ events: [buildEvent({ name: 'Open Singles' })] }),
      onOpenEvent,
    })
    await userEvent.click(eventsTabPage.getOpenButton('Open Singles'))
    expect(onOpenEvent).toHaveBeenCalledTimes(1)
  })

  it('shows the empty state and creates a first event', async () => {
    const onNewEvent = vi.fn()
    eventsTabPage.render({
      tournament: buildTournament({ events: [] }),
      onNewEvent,
    })
    expect(document.body).toHaveTextContent('No events yet')
    await userEvent.click(eventsTabPage.getNewEventButton())
    expect(onNewEvent).toHaveBeenCalledTimes(1)
  })

  it('hides every "new event" affordance for a non-creator', () => {
    eventsTabPage.render({
      tournament: buildTournament({ events: [buildEvent()] }),
      canEdit: false,
    })
    expect(eventsTabPage.queryNewEventButtons()).toHaveLength(0)
  })

  it('hides the empty-state CTA for a non-creator', () => {
    eventsTabPage.render({
      tournament: buildTournament({ events: [] }),
      canEdit: false,
    })
    expect(document.body).toHaveTextContent('No events yet')
    expect(eventsTabPage.queryNewEventButtons()).toHaveLength(0)
  })

  // The default MSW session is `rita.kovac`, a default user holding no
  // permissions (entering needs none, #1092) — and she is not among the seeded
  // entrants.
  describe('the self-registration control on each card', () => {
    it('waits for the session before loading the viewer checkout', async () => {
      let checkoutReads = 0
      server.use(
        http.get('*/v1/session', () => new Promise(() => {})),
        http.get('*/v1/tournaments/:tournamentId/checkouts/current', () => {
          checkoutReads += 1
          return HttpResponse.json({ detail: 'Checkout not found.' }, { status: 404 })
        }),
      )

      eventsTabPage.render({
        tournament: buildTournament({ events: [buildEvent({ name: 'Open Singles' })] }),
      })

      await new Promise((resolve) => window.setTimeout(resolve, 50))
      expect(checkoutReads).toBe(0)
    })

    it('offers paid selection on a singles event', async () => {
      eventsTabPage.render({
        tournament: buildTournament({
          events: [buildEvent({ name: 'Open Singles' })],
        }),
      })

      expect(
        await eventsTabPage.findSelectButton('Open Singles'),
      ).toBeInTheDocument()
    })

    it('keeps paid selection mounted but disabled until the checkout read settles', async () => {
      let releaseRead!: () => void
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      server.use(
        http.get(
          '*/v1/tournaments/:tournamentId/checkouts/current',
          async () => {
            await readGate
            return HttpResponse.json(
              { detail: 'Checkout not found.' },
              { status: 404 },
            )
          },
        ),
      )
      eventsTabPage.render({
        tournament: buildTournament({
          events: [buildEvent({ name: 'Open Singles', entryFee: 45 })],
        }),
      })

      const selectButton = await eventsTabPage.findSelectButton('Open Singles')
      expect(selectButton).toBeDisabled()

      releaseRead()
      await waitFor(() => expect(selectButton).toBeEnabled())
    })

    it.each([
      ['checkout is unavailable', { checkoutAvailable: false }],
      ['the tournament is a draft', { status: 'draft' as const }],
      ['registration is closed', { registrationOpen: false }],
    ])('does not read checkout state when %s', async (_label, overrides) => {
      let checkoutReads = 0
      server.use(
        http.get('*/v1/tournaments/:tournamentId/checkouts/current', () => {
          checkoutReads += 1
          return HttpResponse.json({ detail: 'Checkout not found.' }, { status: 404 })
        }),
      )
      eventsTabPage.render({
        tournament: buildTournament({
          ...overrides,
          events: [buildEvent({ name: 'Open Singles', entryFee: 45 })],
        }),
      })

      await new Promise((resolve) => window.setTimeout(resolve, 50))
      expect(checkoutReads).toBe(0)
    })

    it('explains when paid checkout is unavailable for this organizer', async () => {
      eventsTabPage.render({
        tournament: buildTournament({
          checkoutAvailable: false,
          events: [buildEvent({ name: 'Open Singles', entryFee: 45 })],
        }),
      })

      expect(
        await screen.findByTestId('checkout-unavailable-notice'),
      ).toHaveTextContent('Checkout is not available for this tournament.')
      expect(eventsTabPage.querySelectButton('Open Singles')).toBeNull()
    })

    it('does not offer checkout for a preserved subminimum fee', async () => {
      eventsTabPage.render({
        tournament: buildTournament({
          events: [buildEvent({ name: 'Legacy Singles', entryFee: 0.25 })],
        }),
      })

      expect(
        await screen.findByTestId('checkout-unavailable-notice'),
      ).toHaveTextContent('This legacy entry fee must be updated before checkout.')
      expect(eventsTabPage.querySelectButton('Legacy Singles')).toBeNull()
    })

    it('prunes a selected event when refreshed data makes it ineligible', async () => {
      const eventId = '00000000-0000-4000-8000-000000000060'
      const paidEvent = buildEvent({
        id: eventId,
        name: 'Open Singles',
        entryFee: 45,
      })
      const props = buildEventsTabProps({
        tournament: buildTournament({ events: [paidEvent] }),
      })
      const renderError = vi.spyOn(console, 'error').mockImplementation(() => {})
      function ControlledEventsTab({
        tournament,
      }: Pick<typeof props, 'tournament'>) {
        const [draft, setDraft] = useState<Set<string>>(() => new Set())
        return (
          <EventsTab
            {...props}
            tournament={tournament}
            checkoutDraftIds={draft}
            onCheckoutDraftChange={setDraft}
          />
        )
      }
      const view = render(<ControlledEventsTab tournament={props.tournament} />)

      await userEvent.click(await eventsTabPage.findSelectButton('Open Singles'))
      expect(screen.getByText('Entry summary')).toBeInTheDocument()

      view.rerender(
        <ControlledEventsTab
          tournament={buildTournament({
            events: [{ ...paidEvent, format: 'doubles' }],
          })}
        />,
      )

      await waitFor(() => expect(screen.queryByText('Entry summary')).toBeNull())
      expect(renderError.mock.calls.flat().join(' ')).not.toContain(
        'Cannot update a component while rendering',
      )
      renderError.mockRestore()
    })

    it('holds multiple paid events as one itemized checkout', async () => {
      const firstId = '00000000-0000-4000-8000-000000000001'
      const secondId = '00000000-0000-4000-8000-000000000002'
      let postedEventIds: string[] = []
      let cancelled = 0
      const createdCheckoutIds: string[] = []
      const checkoutRead = (requestId: string, id: string, status = 'active') => ({
        id,
        request_id: requestId,
        tournament_id: '00000000-0000-4000-8000-000000000020',
        registration_generation: 0,
        status,
        payment_state: 'unavailable',
        currency: 'USD',
        total_cents: 7500,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        remaining_seconds: 600,
        lines: [
          { event_id: firstId, event_name: 'Open Singles', price_cents: 4500 },
          { event_id: secondId, event_name: 'U1500', price_cents: 3000 },
        ],
      })
      server.use(
        http.get('*/v1/tournaments/:tournamentId/checkouts/current', () => {
          if (createdCheckoutIds.length === cancelled) {
            return HttpResponse.json(
              { detail: 'Checkout not found.' },
              { status: 404 },
            )
          }
          return HttpResponse.json(
            checkoutRead(crypto.randomUUID(), createdCheckoutIds.at(-1)!),
          )
        }),
        http.post('*/v1/tournaments/:tournamentId/checkouts', async ({ request }) => {
          const body = (await request.json()) as {
            event_ids: string[]
            request_id: string
          }
          postedEventIds = body.event_ids
          const id = `00000000-0000-4000-8000-${String(createdCheckoutIds.length + 10).padStart(12, '0')}`
          createdCheckoutIds.push(id)
          return HttpResponse.json(checkoutRead(body.request_id, id), {
            status: 201,
          })
        }),
        http.delete('*/v1/tournaments/:tournamentId/checkouts/:checkoutId', () => {
          cancelled += 1
          return HttpResponse.json(
            checkoutRead(crypto.randomUUID(), createdCheckoutIds.at(-1)!, 'cancelled'),
          )
        }),
      )
      eventsTabPage.render({
        tournament: buildTournament({
          events: [
            buildEvent({ id: firstId, name: 'Open Singles', entryFee: 45 }),
            buildEvent({ id: secondId, name: 'U1500', entryFee: 30 }),
          ],
        }),
      })

      await userEvent.click(await eventsTabPage.findSelectButton('Open Singles'))
      await userEvent.click(await eventsTabPage.findSelectButton('U1500'))
      expect(screen.getByText('Entry summary')).toBeInTheDocument()
      expect(screen.getByText('$75.00')).toBeInTheDocument()
      await userEvent.click(
        screen.getByRole('button', {
          name: 'Remove U1500 from entry summary',
        }),
      )
      expect(screen.getByRole('button', { name: 'Hold 1 place' })).toBeInTheDocument()
      await userEvent.click(await eventsTabPage.findSelectButton('U1500'))
      await userEvent.click(screen.getByRole('button', { name: 'Hold 2 places' }))

      await waitFor(() => expect(postedEventIds).toEqual([firstId, secondId]))
      expect(await screen.findByText('Your held places')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Release hold' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Change selection' })).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Change selection' }))
      expect(screen.getByText(/releases this checkout hold/i)).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Keep hold' }))
      await userEvent.click(screen.getByRole('button', { name: 'Change selection' }))
      await userEvent.click(screen.getByRole('button', { name: 'Release and change' }))
      await waitFor(() => expect(cancelled).toBe(1))
      expect(await screen.findByText('Entry summary')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Hold 2 places' }))
      await waitFor(() => expect(createdCheckoutIds).toHaveLength(2))
      expect(createdCheckoutIds[1]).not.toBe(createdCheckoutIds[0])
      expect(await screen.findByText('Your held places')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Release hold' }))
      await waitFor(() => expect(cancelled).toBe(2))
      expect(screen.queryByText('Your held places')).toBeNull()
    })

    it.each([
      'unavailable',
      'preparing',
      'ready',
      'checking',
      'action_required',
      'succeeded',
      'failed',
      'expired',
      'canceled',
    ] as const)(
      'preserves active checkout controls when its payment state is %s',
      async (paymentState) => {
        const eventId = '00000000-0000-4000-8000-000000000021'
        server.use(
          http.get('*/v1/tournaments/:tournamentId/checkouts/current', () =>
            HttpResponse.json({
              id: '00000000-0000-4000-8000-000000000022',
              request_id: '00000000-0000-4000-8000-000000000023',
              tournament_id: '00000000-0000-4000-8000-000000000020',
              registration_generation: 0,
              status: 'active',
              payment_state: paymentState,
              currency: 'USD',
              total_cents: 4500,
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 600_000).toISOString(),
              remaining_seconds: 600,
              lines: [
                {
                  event_id: eventId,
                  event_name: 'Open Singles',
                  price_cents: 4500,
                },
              ],
            }),
          ),
        )
        eventsTabPage.render({
          tournament: buildTournament({
            events: [
              buildEvent({ id: eventId, name: 'Open Singles', entryFee: 45 }),
            ],
          }),
        })

        expect(await screen.findByText('Your held places')).toBeInTheDocument()
        expect(
          screen.getByRole('link', { name: 'Continue to payment' }),
        ).toBeInTheDocument()
        expect(
          screen.getByRole('button', { name: 'Change selection' }),
        ).toBeEnabled()
        expect(screen.getByRole('button', { name: 'Release hold' })).toBeEnabled()
      },
    )

    it('refreshes checkout and tournament state when the hold expires', async () => {
      const eventId = '00000000-0000-4000-8000-000000000031'
      let reads = 0
      server.use(
        http.get('*/v1/tournaments/:tournamentId/checkouts/current', () => {
          reads += 1
          if (reads > 1) {
            return HttpResponse.json({ detail: 'Checkout not found.' }, { status: 404 })
          }
          return HttpResponse.json({
            id: '00000000-0000-4000-8000-000000000032',
            request_id: '00000000-0000-4000-8000-000000000033',
            tournament_id: '00000000-0000-4000-8000-000000000020',
            registration_generation: 0,
            status: 'active',
            payment_state: 'unavailable',
            currency: 'USD',
            total_cents: 4500,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 50).toISOString(),
            remaining_seconds: 1,
            lines: [
              {
                event_id: eventId,
                event_name: 'Open Singles',
                price_cents: 4500,
              },
            ],
          })
        }),
      )
      eventsTabPage.render({
        tournament: buildTournament({
          events: [buildEvent({ id: eventId, name: 'Open Singles', entryFee: 45 })],
        }),
      })

      expect(await screen.findByText('Your held places')).toBeInTheDocument()
      await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2), {
        timeout: 2_000,
      })
      await waitFor(() => expect(screen.queryByText('Your held places')).toBeNull())
    })

    it('polls an active checkout so external invalidation releases the UI', async () => {
      const eventId = '00000000-0000-4000-8000-000000000037'
      let reads = 0
      server.use(
        http.get('*/v1/tournaments/:tournamentId/checkouts/current', () => {
          reads += 1
          if (reads > 1) {
            return HttpResponse.json({ detail: 'Checkout not found.' }, { status: 404 })
          }
          return HttpResponse.json({
            id: '00000000-0000-4000-8000-000000000038',
            request_id: '00000000-0000-4000-8000-000000000039',
            tournament_id: '00000000-0000-4000-8000-000000000020',
            registration_generation: 0,
            status: 'active',
            payment_state: 'unavailable',
            currency: 'USD',
            total_cents: 4500,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            remaining_seconds: 600,
            lines: [
              {
                event_id: eventId,
                event_name: 'Open Singles',
                price_cents: 4500,
              },
            ],
          })
        }),
      )
      eventsTabPage.render({
        tournament: buildTournament({
          events: [buildEvent({ id: eventId, name: 'Open Singles', entryFee: 45 })],
        }),
      })

      expect(await screen.findByText('Your held places')).toBeInTheDocument()
      await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2), { timeout: 6_500 })
      await waitFor(() => expect(screen.queryByText('Your held places')).toBeNull())
    }, 8_000)

    it('restores choices when a committed change cancellation loses its response', async () => {
      const eventId = '00000000-0000-4000-8000-000000000034'
      let cancelled = false
      server.use(
        http.get('*/v1/tournaments/:tournamentId/checkouts/current', () =>
          cancelled
            ? HttpResponse.json({ detail: 'Checkout not found.' }, { status: 404 })
            : HttpResponse.json({
                id: '00000000-0000-4000-8000-000000000035',
                request_id: '00000000-0000-4000-8000-000000000036',
                tournament_id: '00000000-0000-4000-8000-000000000020',
                registration_generation: 0,
                status: 'active',
                payment_state: 'unavailable',
                currency: 'USD',
                total_cents: 4500,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 600_000).toISOString(),
                remaining_seconds: 600,
                lines: [
                  {
                    event_id: eventId,
                    event_name: 'Open Singles',
                    price_cents: 4500,
                  },
                ],
              }),
        ),
        http.delete('*/v1/tournaments/:tournamentId/checkouts/:checkoutId', () => {
          cancelled = true
          return HttpResponse.error()
        }),
      )
      eventsTabPage.render({
        tournament: buildTournament({
          events: [buildEvent({ id: eventId, name: 'Open Singles', entryFee: 45 })],
        }),
      })

      expect(await screen.findByText('Your held places')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Change selection' }))
      await userEvent.click(screen.getByRole('button', { name: 'Release and change' }))

      expect(await screen.findByText('Entry summary')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Hold 1 place' })).toBeInTheDocument()
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('discards the draft when reconciliation finds a checkout after a lost create response', async () => {
      const eventId = '00000000-0000-4000-8000-000000000037'
      let created = false
      let cancelled = false
      const activeCheckout = {
        id: '00000000-0000-4000-8000-000000000038',
        request_id: '00000000-0000-4000-8000-000000000039',
        tournament_id: '00000000-0000-4000-8000-000000000020',
        registration_generation: 0,
        status: 'active',
        payment_state: 'unavailable',
        currency: 'USD',
        total_cents: 4500,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        remaining_seconds: 600,
        lines: [
          { event_id: eventId, event_name: 'Open Singles', price_cents: 4500 },
        ],
      }
      server.use(
        http.get('*/v1/tournaments/:tournamentId/checkouts/current', () =>
          created && !cancelled
            ? HttpResponse.json(activeCheckout)
            : HttpResponse.json(
                { detail: 'Checkout not found.' },
                { status: 404 },
              ),
        ),
        http.post('*/v1/tournaments/:tournamentId/checkouts', () => {
          created = true
          return HttpResponse.error()
        }),
        http.delete('*/v1/tournaments/:tournamentId/checkouts/:checkoutId', () => {
          cancelled = true
          return HttpResponse.json({ ...activeCheckout, status: 'cancelled' })
        }),
      )
      eventsTabPage.render({
        tournament: buildTournament({
          events: [buildEvent({ id: eventId, name: 'Open Singles', entryFee: 45 })],
        }),
      })

      await userEvent.click(await eventsTabPage.findSelectButton('Open Singles'))
      await userEvent.click(screen.getByRole('button', { name: 'Hold 1 place' }))
      expect(await screen.findByText('Your held places')).toBeInTheDocument()
      expect(toast.error).not.toHaveBeenCalled()

      await userEvent.click(screen.getByRole('button', { name: 'Release hold' }))
      await waitFor(() => expect(screen.queryByText('Your held places')).toBeNull())
      expect(screen.queryByText('Entry summary')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Hold 1 place' })).toBeNull()
    })

    it('hides paid selection toggles while a checkout is active', async () => {
      const eventId = '00000000-0000-4000-8000-000000000041'
      server.use(
        http.get('*/v1/tournaments/:tournamentId/checkouts/current', () =>
          HttpResponse.json({
            id: '00000000-0000-4000-8000-000000000042',
            request_id: '00000000-0000-4000-8000-000000000043',
            tournament_id: '00000000-0000-4000-8000-000000000020',
            registration_generation: 0,
            status: 'active',
            payment_state: 'unavailable',
            currency: 'USD',
            total_cents: 4500,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            remaining_seconds: 600,
            lines: [
              {
                event_id: eventId,
                event_name: 'Open Singles',
                price_cents: 4500,
              },
            ],
          }),
        ),
      )
      eventsTabPage.render({
        tournament: buildTournament({
          events: [
            buildEvent({ id: eventId, name: 'Open Singles', entryFee: 45 }),
            buildEvent({ name: 'U1500', entryFee: 30 }),
          ],
        }),
      })

      expect(await screen.findByText('Your held places')).toBeInTheDocument()
      expect(eventsTabPage.querySelectButton('Open Singles')).toBeNull()
      expect(eventsTabPage.querySelectButton('U1500')).toBeNull()
    })

    it('locks the submitted selection until checkout creation finishes', async () => {
      const firstId = '00000000-0000-4000-8000-000000000051'
      let releaseRequest!: () => void
      let created = false
      const requestGate = new Promise<void>((resolve) => {
        releaseRequest = resolve
      })
      server.use(
        http.get('*/v1/tournaments/:tournamentId/checkouts/current', () =>
          created
            ? HttpResponse.json({
                id: '00000000-0000-4000-8000-000000000052',
                request_id: '00000000-0000-4000-8000-000000000053',
                tournament_id: '00000000-0000-4000-8000-000000000020',
                registration_generation: 0,
                status: 'active',
                payment_state: 'unavailable',
                currency: 'USD',
                total_cents: 4500,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 600_000).toISOString(),
                remaining_seconds: 600,
                lines: [
                  {
                    event_id: firstId,
                    event_name: 'Open Singles',
                    price_cents: 4500,
                  },
                ],
              })
            : HttpResponse.json(
                { detail: 'Checkout not found.' },
                { status: 404 },
              ),
        ),
        http.post('*/v1/tournaments/:tournamentId/checkouts', async ({ request }) => {
          const body = (await request.json()) as {
            event_ids: string[]
            request_id: string
          }
          await requestGate
          created = true
          return HttpResponse.json(
            {
              id: '00000000-0000-4000-8000-000000000052',
              request_id: body.request_id,
              tournament_id: '00000000-0000-4000-8000-000000000020',
              registration_generation: 0,
              status: 'active',
              payment_state: 'unavailable',
              currency: 'USD',
              total_cents: 4500,
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 600_000).toISOString(),
              remaining_seconds: 600,
              lines: [
                {
                  event_id: firstId,
                  event_name: 'Open Singles',
                  price_cents: 4500,
                },
              ],
            },
            { status: 201 },
          )
        }),
      )
      eventsTabPage.render({
        tournament: buildTournament({
          events: [
            buildEvent({ id: firstId, name: 'Open Singles', entryFee: 45 }),
            buildEvent({ name: 'U1500', entryFee: 30 }),
          ],
        }),
      })

      await userEvent.click(await eventsTabPage.findSelectButton('Open Singles'))
      await userEvent.click(screen.getByRole('button', { name: 'Hold 1 place' }))

      await waitFor(() =>
        expect(
          screen.getByRole('button', {
            name: 'Remove Open Singles from entry summary',
          }),
        ).toBeDisabled(),
      )
      expect(eventsTabPage.querySelectButton('U1500')).toBeNull()

      releaseRequest()
      expect(await screen.findByText('Your held places')).toBeInTheDocument()
    })

    it('offers none on a doubles event', async () => {
      eventsTabPage.render({
        tournament: buildTournament({
          events: [
            buildEvent({ name: 'Open Singles' }),
            buildEvent({
              id: 'ev-open-doubles',
              name: 'Open Doubles',
              format: 'doubles',
            }),
          ],
        }),
      })

      // The singles card's control is the gate: once it is on screen the
      // session has landed, so the doubles card's absence is a real absence.
      await eventsTabPage.findSelectButton('Open Singles')
      expect(eventsTabPage.querySelectButton('Open Doubles')).toBeNull()
    })

    it('enters the event on click — and does NOT open the editor', async () => {
      let entered = 0
      mockEventEnterEndpoint(server, () => {
        entered += 1
        return HttpResponse.json(buildTournamentEntrantRead(), { status: 201 })
      })
      const onOpenEvent = vi.fn()
      eventsTabPage.render({
        tournament: buildTournament({
          id: 't-1',
          events: [buildEvent({ name: 'Open Singles', entryFee: 0 })],
        }),
        onOpenEvent,
      })

      await userEvent.click(await eventsTabPage.findEnterButton('Open Singles'))

      await waitFor(() => expect(entered).toBe(1))
      // Handler wiring only. jsdom has no layout or paint, so this passes
      // regardless of z-index — the control's click-isolation from the card's
      // stretched open-overlay is only truly asserted in the browser (2e).
      expect(onOpenEvent).not.toHaveBeenCalled()
    })

    // The seam this merge creates. ADR 0015 says a non-owner gets a *rendering,
    // not controls* — and its guards assert zero interactive controls in the
    // editor panels. Entering is not one of those controls: it is a PLAYER
    // affordance, not an OWNER one gated on
    // `canEdit`, and self-registration is by definition something you do to
    // someone else's tournament. So the non-owner who gets the read-only view
    // must still get Enter. (`EnterEventControl` never reads `canEdit`; this
    // pins that it never starts to.)
    it('still offers selection to a non-owner, who gets the read-only view', async () => {
      eventsTabPage.render({
        tournament: buildTournament({
          events: [buildEvent({ name: 'Open Singles' })],
        }),
        canEdit: false,
      })

      expect(
        await eventsTabPage.findSelectButton('Open Singles'),
      ).toBeInTheDocument()
      // The card opens a read-only view, not an editor — ADR 0015 still holds
      // around the control.
      expect(
        eventsTabPage.getOpenButton('Open Singles', 'View'),
      ).toBeInTheDocument()
      expect(eventsTabPage.queryNewEventButtons()).toHaveLength(0)
    })
  })

  // The tab is where the session is READ (one query, every card): the roster's
  // "which entrant is me" join is only as good as the username that reaches it.
  it('tells every card who the viewer is, so they see themselves in a busy roster', async () => {
    // The 52-entrant Open Singles with the default MSW session's player
    // (`rita.kovac`) entered LAST — the exact shape of #781, where the card
    // showed the first 8 and left her looking for herself in vain.
    eventsTabPage.render({
      tournament: buildTournament({
        events: [
          buildEvent({
            name: 'Open Singles',
            entrants: [
              ...buildEntrants(52),
              buildEntrant({
                id: 'entry-me',
                userId: 'u-me',
                username: 'rita.kovac',
              }),
            ],
          }),
        ],
      }),
    })

    // `find`, not `query`: the username arrives with the session.
    expect(
      await eventsTabPage.findEntrant('Open Singles', 'rita.kovac'),
    ).toBeInTheDocument()
    expect(
      eventsTabPage.queryTruncationTail('Open Singles'),
    ).toHaveTextContent('+45 more')
  })

  // Clicking a card opens the editor for the organizer and a read-only view for
  // everyone else, so the subtitle promises what the click delivers (ADR 0015,
  // rule 5). Asserted both ways: the discriminating word is the verb.
  describe('the "click any event" subtitle', () => {
    it('invites the creator to edit', () => {
      eventsTabPage.render({ tournament: buildTournament() })
      expect(screen.getByText(/Click any event to edit\./)).toBeInTheDocument()
      expect(screen.queryByText(/Click any event for details\./)).toBeNull()
    })

    it('offers a non-creator details, not editing', () => {
      eventsTabPage.render({ tournament: buildTournament(), canEdit: false })
      expect(
        screen.getByText(/Click any event for details\./),
      ).toBeInTheDocument()
      expect(screen.queryByText(/Click any event to edit\./)).toBeNull()
    })
  })

  // The draw hangs off the EVENT (ADR-0786) — there is no Draw tab, because a draw
  // belongs to one event and a tab would have to ask which. Wiring only: the panel's own
  // quartet pins the groups, the rounds, the refusals and the empty state.
  describe('the draw on each card', () => {
    it('gives every event its own draw panel, fed that event’s tournament', async () => {
      eventsTabPage.render({
        tournament: buildTournament({
          id: 't-1',
          events: [buildDrawnEvent(), buildEvent({ id: 'ev-open-singles' })],
        }),
      })

      // The drawn event expands into its groups…
      expect(eventsTabPage.getGroupLines(groupIdFor('res-a'))).toEqual([
        'player.1 vs player.4',
        'player.1 vs player.5',
        'player.4 vs player.5',
      ])
      // …and the undrawn one shows its designed empty state, not a gap.
      expect(eventsTabPage.queryPanel('ev-open-singles')).toBeInTheDocument()
      expect(eventsTabPage.getEmptyState()).toHaveTextContent('No draw yet.')
    })

    it('gates the draw verbs on the tournament’s canEdit, like every other owner action', () => {
      const tournament = buildTournament({ events: [buildDrawnEvent()] })

      eventsTabPage.render({ tournament, canEdit: false })

      expect(eventsTabPage.queryRecutButton('U1200 Singles')).toBeNull()
      expect(eventsTabPage.queryDeleteButton('U1200 Singles')).toBeNull()
      expect(eventsTabPage.getPanelControls('ev-u1200')).toHaveLength(0)
    })

    it('offers the creator the draw verbs on the card itself', () => {
      eventsTabPage.render({
        tournament: buildTournament({ events: [buildDrawnEvent()] }),
        canEdit: true,
      })

      expect(eventsTabPage.queryRecutButton('U1200 Singles')).toBeInTheDocument()
      expect(eventsTabPage.queryDeleteButton('U1200 Singles')).toBeInTheDocument()
    })
  })
})
