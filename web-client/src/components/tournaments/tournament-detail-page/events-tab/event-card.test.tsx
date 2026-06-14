import userEvent from '@testing-library/user-event'

import { buildEvent, buildPredicate } from '../../data/seed.factory'
import { eventCardPage } from './event-card.page'

describe('EventCard', () => {
  it('shows the name, best-of badge, and eligibility chips', () => {
    eventCardPage.render({
      event: buildEvent({
        name: 'U1500 Singles',
        match: { rated: true, lengthGames: 3 },
        predicates: [buildPredicate({ field: 'rating', op: '<', value: 1500 })],
      }),
    })
    const card = eventCardPage.getOpenButton('U1500 Singles')
    expect(card).toBeInTheDocument()
    expect(document.body).toHaveTextContent('Bo3')
    expect(document.body).toHaveTextContent('USATT rating < 1500')
  })

  it('shows entries out of the player cap', () => {
    eventCardPage.render({
      event: buildEvent({ entered: 52, maxPlayers: 64 }),
    })
    expect(document.body).toHaveTextContent('52')
    expect(document.body).toHaveTextContent('/ 64')
  })

  it('opens the editor when clicked', async () => {
    const onOpen = vi.fn()
    eventCardPage.render({ event: buildEvent({ name: 'Open Singles' }), onOpen })
    await userEvent.click(eventCardPage.getOpenButton('Open Singles'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
