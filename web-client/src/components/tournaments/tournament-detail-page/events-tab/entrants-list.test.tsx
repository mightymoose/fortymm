import { buildEntrant, buildEntrants, buildEvent } from '../../data/seed.factory'
import {
  ENTRY_CLOSED_COPY,
  entrantsListPage as page,
  NO_ENTRANTS_COPY,
} from './entrants-list.page'

const EVENT = 'Open Singles'

describe('EntrantsList', () => {
  it("lists the event's entrants by name", () => {
    page.render({
      event: buildEvent({
        name: EVENT,
        entrants: [
          buildEntrant({ id: 'e-1', username: 'rita.kovac' }),
          buildEntrant({ id: 'e-2', username: 'sam.oduya' }),
        ],
      }),
    })

    expect(page.queryEntrant(EVENT, 'rita.kovac')).toBeInTheDocument()
    expect(page.queryEntrant(EVENT, 'sam.oduya')).toBeInTheDocument()
    expect(page.getEntrantItems(EVENT)).toHaveLength(2)
  })

  it('renders the roster as a real list, named for its event', () => {
    // Semantics, not looks: a screen reader announces "Entrants in Open
    // Singles, list, 2 items" — and the per-event name keeps one card's roster
    // distinguishable from the next one's on a tab full of them.
    page.render({
      event: buildEvent({ name: EVENT, entrants: buildEntrants(2) }),
    })

    expect(page.getEntrantsList(EVENT)).toBeInTheDocument()
  })

  describe('a singles event nobody has entered', () => {
    it('shows the designed empty copy, not an empty container', () => {
      page.render({ event: buildEvent({ name: EVENT, entrants: [] }) })

      // The COPY is the assertion. "Zero list items" would also be true of a
      // blank gap, which is exactly the failure this state exists to prevent.
      expect(page.queryEmptyCopy()).toBeInTheDocument()
      expect(document.body).toHaveTextContent(NO_ENTRANTS_COPY)
      expect(document.body).toHaveTextContent(
        'Players who enter this event will be listed here.',
      )
    })

    it('renders no empty list alongside the copy', () => {
      page.render({ event: buildEvent({ name: EVENT, entrants: [] }) })

      expect(page.queryEntrantsList(EVENT)).toBeNull()
    })
  })

  // "Nobody has entered" and "nobody CAN enter" are different states, and the
  // difference is the whole point: a doubles event is not waiting for its first
  // entrant — the API refuses entry to it (one row cannot express a pairing,
  // ADR-0016) and the card offers no Enter control. Telling a player "no one has
  // entered yet" there invites them through a door that does not exist.
  describe('an event whose format cannot be entered', () => {
    it.each([
      { format: 'doubles', name: 'Mixed Doubles' },
      { format: 'teams', name: 'Club Teams' },
    ] as const)(
      'tells a $format event honestly that entry is not open',
      ({ format, name }) => {
        page.render({ event: buildEvent({ name, format, entrants: [] }) })

        expect(page.queryEntryClosedCopy(format)).toBeInTheDocument()
        expect(document.body).toHaveTextContent(ENTRY_CLOSED_COPY[format])
        expect(document.body).toHaveTextContent(
          'Entry is open for singles only, so no one can sign up for this event.',
        )
      },
    )

    it('does NOT show the "be the first" empty copy', () => {
      page.render({
        event: buildEvent({
          name: 'Mixed Doubles',
          format: 'doubles',
          entrants: [],
        }),
      })

      expect(page.queryEmptyCopy()).toBeNull()
      expect(document.body).not.toHaveTextContent(NO_ENTRANTS_COPY)
    })

    it('says nothing about the format when it does have entrants', () => {
      // Belt and braces for director-entry (#784): if a doubles event ever comes
      // back with people in it, the roster lists them — it does not insist the
      // event is unenterable while showing its entrants.
      page.render({
        event: buildEvent({
          name: 'Mixed Doubles',
          format: 'doubles',
          entrants: [buildEntrant({ username: 'rita.kovac' })],
        }),
      })

      expect(page.queryEntrant('Mixed Doubles', 'rita.kovac')).toBeInTheDocument()
      expect(page.queryEntryClosedCopy('doubles')).toBeNull()
    })

    it('renders no blank gap — the state has copy, not silence', () => {
      page.render({
        event: buildEvent({
          name: 'Mixed Doubles',
          format: 'doubles',
          entrants: [],
        }),
      })

      expect(page.queryEntrantsList('Mixed Doubles')).toBeNull()
      expect(page.queryAllButtons()).toHaveLength(0)
    })
  })

  // CONTRACT TEST — an honest one. This component does NOT filter withdrawn
  // players out, and must not: the server derives `entrants` (and the `entered`
  // count) from the ACTIVE entries alone (ADR-0016), so a withdrawn player is
  // already absent from the payload the card is handed. What this pins is that
  // the list renders exactly what it is given — no more (it doesn't invent the
  // withdrawn player back) and no less. If the read model ever started shipping
  // withdrawn entries, this test would NOT catch it; the api suite in 1e is what
  // guards that end of the contract.
  it('does not show a player who has withdrawn', () => {
    const stayed = buildEntrant({ id: 'e-1', username: 'rita.kovac' })
    const withdrew = buildEntrant({ id: 'e-2', username: 'sam.oduya' })
    // The event as the server reports it AFTER `sam.oduya` withdrew: their entry
    // row still exists, but it is not an entrant any more.
    page.render({ event: buildEvent({ name: EVENT, entrants: [stayed] }) })

    expect(page.queryEntrant(EVENT, stayed.username)).toBeInTheDocument()
    expect(page.queryEntrant(EVENT, withdrew.username)).toBeNull()
    expect(page.getEntrantItems(EVENT)).toHaveLength(1)
  })

  describe('an event with more entrants than the card can show', () => {
    it('lists the first few and says how many it is not showing', () => {
      // 52 entrants in a 64-slot draw — the seeded Open Singles. The card is a
      // summary row; a 52-chip roster would push the next event off the screen.
      page.render({
        event: buildEvent({ name: EVENT, entrants: buildEntrants(52) }),
      })

      expect(page.queryEntrant(EVENT, 'player.1')).toBeInTheDocument()
      expect(page.queryEntrant(EVENT, 'player.8')).toBeInTheDocument()
      expect(page.queryEntrant(EVENT, 'player.9')).toBeNull()
      // The count it hides is stated, not silently dropped: 52 - 8 = 44.
      expect(page.queryTruncationTail(EVENT)).toHaveTextContent('+44 more')
    })

    it('keeps the tail non-interactive — the card owns the only click', () => {
      // The whole card is covered by a stretched open-target <button>. A "show
      // more" control here would be a second interactive element fighting it
      // (and, under that overlay, an unclickable one). The tail is text.
      page.render({
        event: buildEvent({ name: EVENT, entrants: buildEntrants(52) }),
      })

      expect(page.queryAllButtons()).toHaveLength(0)
    })

    it('shows every entrant, with no tail, when they all fit', () => {
      page.render({
        event: buildEvent({ name: EVENT, entrants: buildEntrants(8) }),
      })

      expect(page.getEntrantItems(EVENT)).toHaveLength(8)
      expect(page.queryTruncationTail(EVENT)).toBeNull()
    })
  })
})
