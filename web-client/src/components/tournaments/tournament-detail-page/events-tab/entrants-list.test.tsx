import { buildEntrant, buildEntrants, buildEvent } from '../../data/seed.factory'
import {
  ENTRY_CLOSED_COPY,
  entrantsListPage as page,
  NO_ENTRANTS_COPY,
  UNRATED_TAG,
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

  /**
   * #781's acceptance criterion, verbatim: "a signed-in player can enter an event
   * and **see themselves listed**."
   *
   * The server lists entrants oldest-entry-first, so entering an event that
   * already holds `MAX_VISIBLE` people appends you to the END of the roster —
   * past the truncation cut-off. Under a plain `slice(0, MAX_VISIBLE)` the count
   * ticked up and the control flipped to Withdraw, but your name was nowhere in
   * the list: you were told you were in, and shown a list you were not in.
   *
   * Every earlier test missed it because the only ones that asserted "my name is
   * in the roster" ran against an event with ZERO entrants — where the cut-off
   * cannot bite. So these all run against a BUSY event, on purpose.
   */
  describe('the signed-in player, in an event busier than the card can show', () => {
    const ME = 'rita.kovac'
    const myEntry = buildEntrant({
      id: 'entry-me',
      userId: 'u-me',
      username: ME,
    })

    /** The seeded 52-entrant Open Singles, the moment I enter it: I am the 53rd
     * and newest entry, so the server hands me back LAST. */
    const busyEventIAmIn = () =>
      buildEvent({ name: EVENT, entrants: [...buildEntrants(52), myEntry] })

    it('sees their own name, however many people entered ahead of them', () => {
      page.render({ event: busyEventIAmIn(), username: ME })

      expect(page.queryEntrant(EVENT, ME)).toBeInTheDocument()
    })

    it('sees it FIRST, with everyone else still oldest-entry-first behind it', () => {
      page.render({ event: busyEventIAmIn(), username: ME })

      expect(page.getEntrantNames(EVENT)).toEqual([
        ME,
        'player.1',
        'player.2',
        'player.3',
        'player.4',
        'player.5',
        'player.6',
        'player.7',
      ])
    })

    it('marks the chip as theirs — a chip that jumped the queue says why', () => {
      page.render({ event: busyEventIAmIn(), username: ME })

      expect(page.queryYouTag(EVENT)).toBeInTheDocument()
    })

    it('still counts the hidden entrants exactly, with self hoisted out of them', () => {
      // 53 entrants, 8 chips shown (me + the 7 oldest) → 45 hidden. Pinning me is
      // a REORDER: it must neither drop `player.8` from the count (44) nor count
      // me among the hidden (46).
      page.render({ event: busyEventIAmIn(), username: ME })

      // 8 chips + the tail.
      expect(page.getEntrantItems(EVENT)).toHaveLength(9)
      expect(page.queryTruncationTail(EVENT)).toHaveTextContent('+45 more')
    })

    it('keeps the roster inert — the card still owns the only click', () => {
      page.render({ event: busyEventIAmIn(), username: ME })

      expect(page.queryAllButtons()).toHaveLength(0)
    })
  })

  describe('a roster with nobody of mine in it', () => {
    it('is untouched for a signed-in player who has not entered', () => {
      // Nothing to pin, so nothing moves: the oldest 8, the honest tail (52 - 8),
      // and no chip claimed as anyone's.
      page.render({
        event: buildEvent({ name: EVENT, entrants: buildEntrants(52) }),
        username: 'rita.kovac',
      })

      expect(page.getEntrantNames(EVENT)[0]).toBe('player.1')
      expect(page.queryEntrant(EVENT, 'player.8')).toBeInTheDocument()
      expect(page.queryTruncationTail(EVENT)).toHaveTextContent('+44 more')
      expect(page.queryYouTag(EVENT)).toBeNull()
    })

    it('is untouched for a signed-out viewer, who is nobody', () => {
      page.render({
        event: buildEvent({ name: EVENT, entrants: buildEntrants(52) }),
        username: null,
      })

      expect(page.getEntrantNames(EVENT)[0]).toBe('player.1')
      expect(page.queryTruncationTail(EVENT)).toHaveTextContent('+44 more')
      expect(page.queryYouTag(EVENT)).toBeNull()
    })
  })

  /**
   * ADR-0783 §3, the visible half.
   *
   * An unrated player **passes every rating rule** — `rating < 1500` admits someone
   * who holds no rating at all — because the alternative bars a beginner from the
   * beginners' event. The accepted cost is that a rating cap becomes **opt-out**:
   * never play a rated match, stay unrated, stay eligible for every capped event.
   *
   * The mitigation is *this list*. The director is the only person who can act on a
   * ringer (they may withdraw them, #784), and they can only act on what they can
   * see. So an unrated entrant is marked — and marked in a **word**, because a
   * colour-only mark is no mark at all to a director who cannot see it, and a
   * screen reader reads the DOM, not the hue.
   */
  describe('an unrated entrant — the visible loophole', () => {
    /** A roster the director must be able to read the loophole off: one rated
     * player, one who holds no rating on the tournament's ladder. */
    const mixedRoster = () =>
      buildEvent({
        name: EVENT,
        entrants: [
          buildEntrant({ id: 'e-1', username: 'rita.kovac', rating: 1720 }),
          buildEntrant({ id: 'e-2', username: 'sam.oduya', rating: null }),
        ],
      })

    it('marks the entrant who holds no rating, and only them', () => {
      page.render({ event: mixedRoster() })

      // WHO is marked is the assertion — a count alone would pass with the mark on
      // the wrong chip, which is the same lie as no mark at all.
      expect(page.getUnratedNames(EVENT)).toEqual(['sam.oduya'])
    })

    it('states it in a WORD, so the mark is not a colour a director cannot see', () => {
      page.render({ event: mixedRoster() })

      // The text is in the DOM, inside the chip it belongs to: that is what a
      // screen reader announces ("sam.oduya, Unrated") and what survives a
      // greyscale monitor, a colour-blind reader and a high-contrast theme. A
      // tint would satisfy none of the three, and no test could tell.
      const [tag] = page.getUnratedTags(EVENT)
      expect(tag).toHaveTextContent(UNRATED_TAG)
      expect(tag.closest('li')).toHaveTextContent('sam.oduya')
    })

    it('leaves a rated entrant unmarked and unadorned', () => {
      page.render({ event: mixedRoster() })

      // Both chips are still there — the mark is an addition to a roster, not a
      // filter over it.
      expect(page.getEntrantNames(EVENT)).toEqual(['rita.kovac', 'sam.oduya'])
      expect(page.getUnratedTags(EVENT)).toHaveLength(1)
    })

    it("does not print a rated entrant's rating number", () => {
      // A DECISION, pinned: only the *absence* of a rating is shown. The server
      // already judged every rated entrant against the event's rules when they
      // entered (ADR-0783 — eligibility is computed in exactly one place), so their
      // number is not actionable; printing eight of them would bury the one chip
      // that is. The audit view is the draw sheet's (#785).
      page.render({ event: mixedRoster() })

      expect(page.getEntrantsList(EVENT)).not.toHaveTextContent('1720')
    })

    it('marks nobody when the whole roster is rated', () => {
      page.render({ event: buildEvent({ name: EVENT, entrants: buildEntrants(3) }) })

      expect(page.getUnratedTags(EVENT)).toHaveLength(0)
    })

    it('renders normally when EVERY entrant is unrated', () => {
      // The degenerate roster: a brand-new club's first beginners' event, where
      // nobody has finished a rated match yet. Every chip is marked, the list is
      // still a list, and it is still inert.
      page.render({
        event: buildEvent({
          name: EVENT,
          entrants: buildEntrants(4, { rating: null }),
        }),
      })

      expect(page.getEntrantItems(EVENT)).toHaveLength(4)
      expect(page.getUnratedNames(EVENT)).toEqual([
        'player.1',
        'player.2',
        'player.3',
        'player.4',
      ])
      expect(page.queryEmptyCopy()).toBeNull()
      expect(page.queryAllButtons()).toHaveLength(0)
    })

    it('marks the signed-in player when it is THEY who are unrated', () => {
      // The mark follows the fact, not the stranger: my own chip is pinned and
      // accented *and* marked. A rule that only ever marked other people would hide
      // the opt-out from the one person taking it.
      const me = buildEntrant({
        id: 'entry-me',
        userId: 'u-me',
        username: 'rita.kovac',
        rating: null,
      })
      page.render({
        event: buildEvent({
          name: EVENT,
          entrants: [buildEntrant({ id: 'e-1', username: 'player.1' }), me],
        }),
        username: 'rita.kovac',
      })

      expect(page.getUnratedNames(EVENT)).toEqual(['rita.kovac'])
      expect(page.queryYouTag(EVENT)).toBeInTheDocument()
    })

    it('marks an unrated entrant hoisted into a truncated roster', () => {
      // The two rules compose: the pin REORDERS, the mark ANNOTATES, and neither
      // consumes the other. 52 rated strangers plus unrated me, shown 8-at-a-time.
      const me = buildEntrant({
        id: 'entry-me',
        userId: 'u-me',
        username: 'rita.kovac',
        rating: null,
      })
      page.render({
        event: buildEvent({ name: EVENT, entrants: [...buildEntrants(52), me] }),
        username: 'rita.kovac',
      })

      expect(page.getEntrantNames(EVENT)[0]).toBe('rita.kovac')
      expect(page.getUnratedNames(EVENT)).toEqual(['rita.kovac'])
      expect(page.queryTruncationTail(EVENT)).toHaveTextContent('+45 more')
    })
  })

  it('marks my chip in a small event too — where nothing needed hoisting', () => {
    // Three entrants, all visible either way. The pin is not *load-bearing* here,
    // but the mark still is: one rule, not two.
    const me = buildEntrant({ id: 'entry-me', userId: 'u-me', username: 'rita.kovac' })
    page.render({
      event: buildEvent({
        name: EVENT,
        entrants: [buildEntrant({ id: 'e-1', username: 'player.1' }), me],
      }),
      username: 'rita.kovac',
    })

    expect(page.getEntrantNames(EVENT)).toEqual(['rita.kovac', 'player.1'])
    expect(page.queryYouTag(EVENT)).toBeInTheDocument()
    expect(page.queryTruncationTail(EVENT)).toBeNull()
  })
})
