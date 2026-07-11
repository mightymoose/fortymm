import userEvent from '@testing-library/user-event'

import { buildEvent, buildPool, buildPredicate } from '../../data/seed.factory'
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

  it('shows the time slot as a window', () => {
    eventCardPage.render({
      event: buildEvent({
        slot: { date: '2026-06-13', start: '09:00', end: '12:00' },
      }),
    })
    expect(document.body).toHaveTextContent('Jun 13 · 09:00–12:00')
  })

  // An unset bound used to leave the template's punctuation behind — "09:00–"
  // with a dangling en dash, or a bare "–" with neither bound set.
  it('shows a lone start without a dangling dash', () => {
    eventCardPage.render({
      event: buildEvent({ slot: { date: '2026-06-13', start: '09:00', end: '' } }),
    })
    expect(document.body).toHaveTextContent('Jun 13 · 09:00')
    expect(document.body).not.toHaveTextContent('09:00–')
  })

  it('shows an em-dash when the whole window is unset', () => {
    eventCardPage.render({
      event: buildEvent({ slot: { date: '2026-06-13', start: '', end: '' } }),
    })
    expect(document.body).toHaveTextContent('Jun 13 · —')
  })

  // "1 pool · 1 tables" — the table count was hardcoded plural while the pool
  // count beside it pluralized correctly. (The counts are sibling spans laid out
  // with a CSS gap, so the text runs together: "1 pool·1 table".)
  it('renders a singular table count for a single-table event', () => {
    eventCardPage.render({
      event: buildEvent({ pools: [buildPool({ tableIds: ['t1'] })] }),
    })
    expect(document.body).toHaveTextContent('1 pool·1 table')
    // "1 table" is a substring of "1 tables", so the positive assertion alone
    // would pass against the bug.
    expect(document.body).not.toHaveTextContent('1 tables')
  })

  it('renders a plural table count for a multi-table event', () => {
    eventCardPage.render({
      event: buildEvent({ pools: [buildPool({ tableIds: ['t1', 't2'] })] }),
    })
    expect(document.body).toHaveTextContent('1 pool·2 tables')
  })

  it('opens the editor when clicked', async () => {
    const onOpen = vi.fn()
    eventCardPage.render({ event: buildEvent({ name: 'Open Singles' }), onOpen })
    await userEvent.click(eventCardPage.getOpenButton('Open Singles'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('labels the open affordance "View" for a non-owner (read-only)', () => {
    eventCardPage.render({
      event: buildEvent({ name: 'Open Singles' }),
      canEdit: false,
    })
    expect(
      eventCardPage.getOpenButton('Open Singles', 'View'),
    ).toBeInTheDocument()
    expect(document.body).toHaveTextContent('View')
  })
})
