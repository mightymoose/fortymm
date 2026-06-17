import userEvent from '@testing-library/user-event'

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
})
