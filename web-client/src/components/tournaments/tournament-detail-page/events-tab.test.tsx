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
})
