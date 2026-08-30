import userEvent from '@testing-library/user-event'

import {
  buildDrawnEvent,
  buildEntrant,
  buildEntrants,
  buildEvent,
  buildReservation,
  buildPredicate,
  groupIdFor,
} from '../../data/seed.factory'
import { DrawPanel } from './draw-panel'
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
    expect(document.body).toHaveTextContent('Rating < 1500')
  })

  /**
   * #1608: a badge like `Rating ≥ 1800` reads as "unrated players excluded",
   * while the server admits them — an unrated player passes every rule
   * (ADR-0783 §3). The card states the rules' true scope beside the badges, in
   * visible text, so the exception reaches every reader. It speaks only for the
   * RULES — capacity and the registration window refuse on their own terms, so
   * the line must never promise entry beside an `Event full` notice.
   */
  describe('the eligibility scope line', () => {
    const SCOPE =
      "Players rated on this tournament's ladder must satisfy every rule. Unrated players are exempt."

    it('tells the reader the rules bind ladder-rated players and exempt unrated ones', () => {
      // The exact rule QA reproduced against: `Rating ≥ 1800` still admitted an
      // unrated player.
      eventCardPage.render({
        event: buildEvent({
          predicates: [
            buildPredicate({ field: 'rating', op: '>=', value: 1800 }),
          ],
        }),
      })
      expect(eventCardPage.queryEligibilityScope()).toHaveTextContent(SCOPE)
    })

    it('states the same scope for a between rule and for several rules at once', () => {
      eventCardPage.render({
        event: buildEvent({
          predicates: [
            buildPredicate({ id: 'pr-1', op: 'between', value: [1200, 1500] }),
            buildPredicate({ id: 'pr-2', op: '<', value: 1500 }),
          ],
        }),
      })
      expect(eventCardPage.queryEligibilityScope()).toHaveTextContent(SCOPE)
    })

    // The repair #1608's own first cut needed: the line is gated on
    // `predicates.length > 0` alone, so it renders on a FULL event too — and
    // "unrated players may enter" beside a full card is a fresh contradiction of
    // exactly the species this ticket exists to remove. It speaks for the RULES
    // (exempt), never for entry, which capacity and the registration window
    // refuse on their own terms.
    it('states the exemption without promising entry on a full event', () => {
      eventCardPage.render({
        event: buildEvent({
          entrants: buildEntrants(16),
          maxPlayers: 16,
          predicates: [
            buildPredicate({ field: 'rating', op: '>=', value: 1800 }),
          ],
        }),
      })
      const scope = eventCardPage.queryEligibilityScope()
      // Asserted FIRST, because it is the discriminating one: this is the whole
      // of what the full card would have contradicted.
      expect(scope).not.toHaveTextContent(/may enter/)
      expect(scope).toHaveTextContent(SCOPE)
    })

    it('carries no rated/unrated qualifier for an event with no rules', () => {
      eventCardPage.render({ event: buildEvent({ predicates: [] }) })
      expect(eventCardPage.queryEligibilityScope()).toBeNull()
      expect(document.body).not.toHaveTextContent('Unrated players are exempt')
      expect(document.body).not.toHaveTextContent('must satisfy every rule')
    })
  })

  /** The card names the event's draw type in the **server's** words (ADR 20260726) —
   * it looks the stored slug up in the catalogue it was handed, exactly as the editor's
   * read-only row does, so the two cannot say different things about one event.
   *
   * Asserted against a catalogue that is NOT the seed's: "Round robin" would pass
   * against the hardcoded `DRAW_TYPE_OPTIONS` this replaced and would prove nothing. */
  describe('the draw type, in the server’s words', () => {
    it('labels the stored slug from the served catalogue', () => {
      eventCardPage.render({
        event: buildEvent({ name: 'Open Singles', drawType: 'round-robin' }),
        drawTypes: [{ value: 'round-robin', label: 'Everyone plays everyone' }],
      })

      expect(document.body).toHaveTextContent('Everyone plays everyone')
      expect(document.body).not.toHaveTextContent('round-robin')
    })

    /** No catalogue reached the card. It still must not print the slug: the em-dash
     * keeps the row's shape and admits it does not know the words, which is the honest
     * answer — and the one `labelFor` exists to give. */
    it('shows an em-dash, never the raw slug, with no catalogue', () => {
      eventCardPage.render({
        event: buildEvent({ name: 'Open Singles', drawType: 'round-robin' }),
        drawTypes: [],
      })

      expect(document.body).not.toHaveTextContent('round-robin')
      expect(document.body).toHaveTextContent('—')
    })
  })

  describe('the entries capacity', () => {
    it('shows entries out of the player cap, with a fill bar and the places left', () => {
      eventCardPage.render({
        event: buildEvent({ entrants: buildEntrants(52), maxPlayers: 64 }),
      })
      expect(document.body).toHaveTextContent('52')
      expect(document.body).toHaveTextContent('/ 64')
      expect(eventCardPage.queryCapacityBar()).toBeInTheDocument()
      expect(eventCardPage.queryCapacityNote()).toHaveTextContent('12 places left')
      // The numeral is punctuation to a screen reader ("52 slash 64"), so the a11y
      // tree gets the sentence instead.
      expect(eventCardPage.queryEnteredSummary('52 of 64 entered')).toBeInTheDocument()
    })

    it('marks a capped event full once it reaches its cap — not "0 places left"', () => {
      eventCardPage.render({
        event: buildEvent({ entrants: buildEntrants(64), maxPlayers: 64 }),
      })
      expect(document.body).toHaveTextContent('/ 64')
      expect(eventCardPage.queryCapacityBar()).toBeInTheDocument()
      expect(eventCardPage.queryCapacityNote()).toHaveTextContent('Full')
      expect(eventCardPage.queryCapacityNote()).not.toHaveTextContent('0 places')
      // The "full" numeral and fill both flip to the warn tint at capacity.
      expect(
        document.querySelectorAll('.text-\\[color\\:var\\(--warn\\)\\]').length,
      ).toBeGreaterThan(0)
    })

    /**
     * ⚠️ **The uncapped card** (ADR-0935: `maxPlayers === null`). It has no ceiling to
     * count against, so every number the card would ordinarily print is a number it must
     * not invent: no denominator ("200 of null", "200 of 0"), no fill bar (a rail drawn
     * at 0% reads as empty and at 100% as full — it is neither), and above all **never
     * full**, however many have entered. The 200-entrant roster is deliberate: a fixture
     * of two would render the same whether the card handled the null cap or quietly read
     * it as a big number, so it could not tell the fix from the bug.
     */
    it('shows an uncapped event as a bare entered count with no denominator or bar, never full', () => {
      eventCardPage.render({
        event: buildEvent({ entrants: buildEntrants(200), maxPlayers: null }),
      })
      // The numeral and "entered" label are sibling spans laid out with a CSS
      // gap, so the DOM text runs together: "200entered".
      expect(document.body).toHaveTextContent('200entered')
      // No "/ max" denominator, and no "/ " with a blank max either.
      expect(document.body).not.toHaveTextContent('/')
      // No capacity fill bar.
      expect(eventCardPage.queryCapacityBar()).toBeNull()
      // The caption states the fact rather than leaving the one blank line on a wall
      // of cards that all state one — and it is emphatically not "Full".
      expect(eventCardPage.queryCapacityNote()).toHaveTextContent('No entry limit')
      expect(eventCardPage.queryCapacityNote()).not.toHaveTextContent('Full')
      // …and a screen reader is told the same thing, with no invented denominator.
      expect(
        eventCardPage.queryEnteredSummary('200 entered, no entry limit'),
      ).toBeInTheDocument()
      // Never full, however many are in: no warn-tinted numeral/fill.
      expect(
        document.querySelectorAll('.text-\\[color\\:var\\(--warn\\)\\]').length,
      ).toBe(0)
    })
  })

  /**
   * How much room is left (#783). The card already showed `entered / max` — a
   * numeral that leaves the reader to do the subtraction, and that has no way to
   * say the one thing an entrant most needs to hear: that there is no room at all.
   *
   * The line is read off the **numbers**, never off `entryState`: `entryState` is
   * the server's judgement about *this caller* (ADR-0783), and it is not a count.
   * The last test in here is the one that pins that apart — see its comment.
   */
  describe('the places it has left', () => {
    it('says how many places are left in an event with room', () => {
      eventCardPage.render({
        event: buildEvent({ entrants: buildEntrants(6), maxPlayers: 16 }),
      })

      expect(eventCardPage.queryCapacityNote()).toHaveTextContent('10 places left')
    })

    it('says "1 place left" for the last free place', () => {
      eventCardPage.render({
        event: buildEvent({ entrants: buildEntrants(15), maxPlayers: 16 }),
      })

      expect(eventCardPage.queryCapacityNote()).toHaveTextContent('1 place left')
    })

    // THE BOUNDARY: exactly full. "0 places left" is arithmetic, not news — the
    // card must say the event is FULL.
    it('reads an exactly-full event as full, not as "0 places left"', () => {
      eventCardPage.render({
        event: buildEvent({ entrants: buildEntrants(16), maxPlayers: 16 }),
      })

      const note = eventCardPage.queryCapacityNote()
      expect(note).toHaveTextContent('Full')
      expect(note).not.toHaveTextContent('0 places left')
    })

    // THE OTHER BOUNDARY, and a representable one: a director can lower
    // `max_players` under a field that has already formed (the server's capacity
    // guard is `>=` and evicts nobody), so `entered > maxPlayers` really does
    // arrive on the wire. The naive `max - entered` renders it "-3 places left".
    it('reads an OVER-full event as full — never as a negative number of places', () => {
      eventCardPage.render({
        event: buildEvent({ entrants: buildEntrants(19), maxPlayers: 16 }),
      })

      const note = eventCardPage.queryCapacityNote()
      expect(note).toHaveTextContent('Full')
      expect(note).not.toHaveTextContent('-3')
      expect(note?.textContent).not.toContain('-')
    })

    /**
     * ⚠️ THE ONE THAT PINS THE SOURCE. A full event, seen by a caller the event
     * ALSO refuses on rating: the server judges eligibility before capacity, so
     * `entryState` reads `rating_ineligible` and the `event_full` arm never
     * reaches this caller at all.
     *
     * The card must still say **Full** — because the capacity line is a fact about
     * the *event* (16 people are in it; there is no 17th place), not about who is
     * looking. Re-key it off `entryState` and every other test here still passes
     * while this one goes red on the state a real ineligible player actually sees.
     */
    it('still reads FULL when the caller is refused for their RATING instead', () => {
      eventCardPage.render({
        event: buildEvent({
          entrants: buildEntrants(16),
          maxPlayers: 16,
          predicates: [buildPredicate({ id: 'pr-u1500' })],
          entryState: {
            state: 'rating_ineligible',
            predicateId: 'pr-u1500',
            rating: 1650,
          },
        }),
      })

      expect(eventCardPage.queryCapacityNote()).toHaveTextContent('Full')
    })

    // An event with room refused on rating is the mirror image: the places really
    // are there — this caller just cannot take one. Both facts, honestly.
    it('still counts the places left when the caller is refused for their rating', () => {
      eventCardPage.render({
        event: buildEvent({
          entrants: buildEntrants(9),
          maxPlayers: 24,
          predicates: [buildPredicate({ id: 'pr-u1200' })],
          entryState: {
            state: 'rating_ineligible',
            predicateId: 'pr-u1200',
            rating: 1650,
          },
        }),
      })

      expect(eventCardPage.queryCapacityNote()).toHaveTextContent('15 places left')
    })

    // The `6 / 16` numeral is typography: read aloud it is "6 slash 16". The card
    // hides it from the accessibility tree and offers the sentence instead.
    it('gives a screen reader the count as a sentence, not as a numeral', () => {
      eventCardPage.render({
        event: buildEvent({ entrants: buildEntrants(6), maxPlayers: 16 }),
      })

      expect(eventCardPage.queryEnteredSummary('6 of 16 entered')).toBeInTheDocument()
    })
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

  // "1 reservation · 1 tables" — the table count was hardcoded plural while the
  // reservation count beside it pluralized correctly. (The counts are sibling
  // spans laid out with a CSS gap, so the text runs together: "1 reservation·1
  // table".)
  it('renders a singular table count for a single-table event', () => {
    eventCardPage.render({
      event: buildEvent({ reservations: [buildReservation({ tableIds: ['t1'] })] }),
    })
    expect(document.body).toHaveTextContent('1 reservation·1 table')
    // "1 table" is a substring of "1 tables", so the positive assertion alone
    // would pass against the bug.
    expect(document.body).not.toHaveTextContent('1 tables')
  })

  it('renders a plural table count for a multi-table event', () => {
    eventCardPage.render({
      event: buildEvent({ reservations: [buildReservation({ tableIds: ['t1', 't2'] })] }),
    })
    expect(document.body).toHaveTextContent('1 reservation·2 tables')
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

    // The seam: the card is where the viewer's username reaches the roster. Drop
    // the prop and the roster silently forgets who is looking at it — which is
    // exactly the state #781 shipped in.
    it('hands the roster the viewer, so an entered player sees themselves in a busy event', () => {
      eventCardPage.render({
        event: buildEvent({
          name: 'Open Singles',
          entrants: [
            ...buildEntrants(52),
            buildEntrant({ id: 'entry-me', userId: 'u-me', username: 'rita.kovac' }),
          ],
        }),
        username: 'rita.kovac',
      })

      // 53rd of 53, and still on screen — because the card told the roster who
      // "me" is.
      expect(
        eventCardPage.queryEntrant('Open Singles', 'rita.kovac'),
      ).toBeInTheDocument()
      expect(
        eventCardPage.queryTruncationTail('Open Singles'),
      ).toHaveTextContent('+45 more')
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

  // Wiring only — the draw's content (groups, rounds, the vs-lines, the refusals) is
  // pinned by `DrawPanel`'s own quartet. What the CARD owes it is a home that is not
  // underneath the stretched open target, and a hosted control that is a *sibling* of
  // that target rather than a button inside a button.
  describe('the draw slot', () => {
    it('hosts the draw it is given', () => {
      eventCardPage.render({
        event: buildDrawnEvent(),
        draw: (
          <DrawPanel
            tournamentId="bay-area-open-2026"
            event={buildDrawnEvent()}
            canEdit
          />
        ),
      })

      expect(eventCardPage.queryPanel('ev-u1200')).toBeInTheDocument()
      expect(eventCardPage.getGroupLines(groupIdFor('res-a'))).toEqual([
        'player.1 vs player.4',
        'player.1 vs player.5',
        'player.4 vs player.5',
      ])
    })

    it('keeps the draw’s controls out of the open target — never a button in a button', () => {
      eventCardPage.render({
        event: buildDrawnEvent(),
        draw: (
          <DrawPanel
            tournamentId="bay-area-open-2026"
            event={buildDrawnEvent()}
            canEdit
          />
        ),
      })

      expect(eventCardPage.queryNestedButtons()).toHaveLength(0)
      // The open target, plus the draw's own two verbs.
      expect(eventCardPage.queryAllButtons()).toHaveLength(3)
    })

    it('renders no draw section at all when it is given none', () => {
      eventCardPage.render({ event: buildEvent({ id: 'ev-open-singles' }) })

      expect(eventCardPage.queryPanel('ev-open-singles')).toBeNull()
    })
  })
})
