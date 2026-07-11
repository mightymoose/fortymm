import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'

import { mockEventEnterEndpoint } from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import { buildTournamentEntrantRead } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { waitFor } from '@/test/utilities'

import { buildTournament, buildEvent } from '../data/seed.factory'
import { eventsTabPage } from './events-tab.page'

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

  // The default MSW session is `rita.kovac`, a beta tester holding
  // `tournament.enter` — and she is not among the seeded entrants.
  describe('the self-registration control on each card', () => {
    it('offers Enter on a singles event', async () => {
      eventsTabPage.render({
        tournament: buildTournament({
          events: [buildEvent({ name: 'Open Singles' })],
        }),
      })

      expect(
        await eventsTabPage.findEnterButton('Open Singles'),
      ).toBeInTheDocument()
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
      await eventsTabPage.findEnterButton('Open Singles')
      expect(eventsTabPage.queryEnterButton('Open Doubles')).toBeNull()
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
          events: [buildEvent({ name: 'Open Singles' })],
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
  })
})
