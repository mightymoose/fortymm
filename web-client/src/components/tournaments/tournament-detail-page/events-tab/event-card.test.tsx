import userEvent from '@testing-library/user-event'

import {
  buildEntrant,
  buildEntrants,
  buildEvent,
  buildPredicate,
} from '../../data/seed.factory'
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
      event: buildEvent({ entrants: buildEntrants(52), maxPlayers: 64 }),
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

  it('opens the editor from the keyboard alone', async () => {
    const onOpen = vi.fn()
    eventCardPage.render({ event: buildEvent({ name: 'Open Singles' }), onOpen })

    await userEvent.tab()

    expect(eventCardPage.getOpenButton('Open Singles')).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledTimes(1)

    await userEvent.keyboard(' ')
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  // The card hosts its own control (Enter / Withdraw). It must be a sibling of
  // the stretched open target, never nested inside it: a button in a button is
  // invalid HTML, a keyboard trap, and would swallow the control's own click.
  describe('hosting a control of its own', () => {
    it('renders it as a sibling of the open target, not nested inside it', () => {
      eventCardPage.render({
        event: buildEvent({ name: 'Open Singles' }),
        action: <button type="button">Enter</button>,
      })

      expect(eventCardPage.queryNestedButtons()).toHaveLength(0)
      expect(eventCardPage.getActionControl('Enter')).toBeInTheDocument()
      expect(
        eventCardPage.getOpenButton('Open Singles').contains(
          eventCardPage.getActionControl('Enter'),
        ),
      ).toBe(false)
    })

    it('gives the control its own click — it does not open the editor', async () => {
      const onOpen = vi.fn()
      const onAction = vi.fn()
      eventCardPage.render({
        event: buildEvent({ name: 'Open Singles' }),
        onOpen,
        action: (
          <button type="button" onClick={onAction}>
            Enter
          </button>
        ),
      })

      await userEvent.click(eventCardPage.getActionControl('Enter'))

      expect(onAction).toHaveBeenCalledTimes(1)
      expect(onOpen).not.toHaveBeenCalled()
    })

    it('keeps both the control and the open target keyboard-reachable', async () => {
      eventCardPage.render({
        event: buildEvent({ name: 'Open Singles' }),
        action: <button type="button">Enter</button>,
      })

      await userEvent.tab()
      expect(eventCardPage.getActionControl('Enter')).toHaveFocus()

      await userEvent.tab()
      expect(eventCardPage.getOpenButton('Open Singles')).toHaveFocus()
    })
  })

  // The card shows the roster behind its `entered` numeral. These pin that the
  // card MOUNTS it — `EntrantsList`'s own suite pins how it behaves.
  describe('the entrants roster', () => {
    it("lists the event's entrants by name", () => {
      eventCardPage.render({
        event: buildEvent({
          name: 'Open Singles',
          entrants: [
            buildEntrant({ id: 'e-1', username: 'rita.kovac' }),
            buildEntrant({ id: 'e-2', username: 'sam.oduya' }),
          ],
        }),
      })

      expect(
        eventCardPage.queryEntrant('Open Singles', 'rita.kovac'),
      ).toBeInTheDocument()
      expect(
        eventCardPage.queryEntrant('Open Singles', 'sam.oduya'),
      ).toBeInTheDocument()
    })

    it('shows the designed empty copy when nobody has entered', () => {
      eventCardPage.render({
        event: buildEvent({ name: 'U1500 Singles', entrants: [] }),
      })

      expect(eventCardPage.queryEmptyCopy()).toBeInTheDocument()
      expect(eventCardPage.queryEntrantsList('U1500 Singles')).toBeNull()
    })

    it('tells a doubles card entry is not open, rather than "be the first"', () => {
      // A doubles card offers no Enter control (2c) because the API refuses
      // entry — so its roster must not imply the player could be the first in.
      eventCardPage.render({
        event: buildEvent({
          name: 'Mixed Doubles',
          format: 'doubles',
          entrants: [],
        }),
      })

      expect(eventCardPage.queryEntryClosedCopy('doubles')).toBeInTheDocument()
      expect(eventCardPage.queryEmptyCopy()).toBeNull()
    })
  })

  it('renders no action slot when it is given no control', () => {
    eventCardPage.render({ event: buildEvent({ name: 'Open Singles' }) })

    expect(eventCardPage.queryNestedButtons()).toHaveLength(0)
    // The bare card is exactly one button: the stretched open target.
    expect(eventCardPage.queryAllButtons()).toHaveLength(1)
  })
})
