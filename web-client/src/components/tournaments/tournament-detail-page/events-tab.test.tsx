import userEvent from '@testing-library/user-event'

import { screen } from '@/test/utilities'

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
})
