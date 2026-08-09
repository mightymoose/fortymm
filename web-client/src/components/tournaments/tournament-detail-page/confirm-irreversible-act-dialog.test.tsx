import {
  buildDeleteDrawConsequence,
  buildEndTournamentConsequence,
  buildPublishTournamentConsequence,
  buildRecutDrawConsequence,
  buildRemovePoolReservationsConsequence,
  buildStartTournamentConsequence,
} from './confirm-irreversible-act-dialog.factory'
import { confirmIrreversibleActDialogPage as page } from './confirm-irreversible-act-dialog.page'

describe('ConfirmIrreversibleActDialog', () => {
  it('prices a RE-CUT: a completely new set of pairings, the named event, and the schedule that goes with them', () => {
    page.render({
      consequence: buildRecutDrawConsequence({ eventName: 'Womens Doubles' }),
    })

    const dialog = page.getDialog()
    expect(dialog).toHaveTextContent('Re-cut this draw?')
    // The event is named: the Events tab shows one card per event, so "the draw" alone
    // would be ambiguous the moment a director runs more than one.
    expect(dialog).toHaveTextContent('Re-cutting Womens Doubles')
    // Copy unique to THIS act — a re-cut replaces, it does not remove.
    expect(dialog).toHaveTextContent('deals a completely new set of pairings')
    expect(dialog).toHaveTextContent(
      'The pairings standing now are discarded, and so is any schedule built on them.',
    )
    // The confirm carries the act's own verb — never a bare "OK".
    expect(page.getConfirmButton()).toHaveTextContent('Re-cut the draw')
    expect(page.getCancelButton()).toHaveTextContent('Go back')
  })

  it('prices a DELETE: the draw and every fixture in it, the solved schedule included', () => {
    page.render({
      consequence: buildDeleteDrawConsequence({ eventName: 'Under 15s' }),
    })

    const dialog = page.getDialog()
    expect(dialog).toHaveTextContent('Delete this draw?')
    expect(dialog).toHaveTextContent('Deleting the draw for Under 15s')
    // Copy unique to THIS act — nothing replaces what is removed.
    expect(dialog).toHaveTextContent(
      'removes its pairings and every fixture in it, the solved schedule included',
    )
    expect(dialog).toHaveTextContent('Nothing is kept.')
    expect(page.getConfirmButton()).toHaveTextContent('Delete the draw')
  })

  it('neither draw variant borrows the other act’s sentence', () => {
    page.render({ consequence: buildRecutDrawConsequence() })
    expect(page.getDialog()).not.toHaveTextContent('Nothing is kept.')
    expect(page.getConfirmButton()).not.toHaveTextContent('Delete the draw')
  })

  /**
   * The three **lifecycle** edges (ADR-0017): `draft → published → live → archived`, with
   * no edge back and `archived` terminal. They are one-way exactly as the draw acts are,
   * and each is priced in its own terms — what it opens, what it mints, where it ends.
   *
   * The copy is asserted phrase by phrase rather than by "some dialog appeared", because
   * the ADR's whole demand is that a variant cannot borrow another act's sentence: a
   * generic "This cannot be undone. Continue?" would satisfy every looser assertion.
   */
  it('prices a PUBLISH: the tournament leaves the drafts and becomes enterable by anyone', () => {
    page.render({
      consequence: buildPublishTournamentConsequence({
        tournamentName: 'Spring Open',
      }),
    })

    const dialog = page.getDialog()
    expect(dialog).toHaveTextContent('Publish this tournament?')
    // The TOURNAMENT is named — not an event. A lifecycle act moves the whole thing.
    expect(dialog).toHaveTextContent('Publishing Spring Open')
    // The visibility boundary, which is what this edge and only this edge crosses.
    expect(dialog).toHaveTextContent('puts it in front of everybody')
    expect(dialog).toHaveTextContent('players can find it and enter it')
    expect(dialog).toHaveTextContent('There is no un-publishing it.')
    // Verb plus object, like every other act's button — and asserted as an EXACT name,
    // because a bare `Publish` is what the header's own button says: two controls sharing
    // one accessible name put them in the same role query, where an assertion meant for
    // one can resolve to the other and pass while checking nothing.
    expect(page.getConfirmButton()).toHaveAccessibleName('Publish the tournament')
  })

  it('prices a START: registration shuts and every ready fixture becomes a real match', () => {
    page.render({
      consequence: buildStartTournamentConsequence({
        tournamentName: 'Spring Open',
      }),
    })

    const dialog = page.getDialog()
    expect(dialog).toHaveTextContent('Start this tournament?')
    expect(dialog).toHaveTextContent('Starting Spring Open')
    // BOTH halves. Since #788 this edge spends the players' attention, not merely the
    // tournament's visibility, and copy that named only the closing window would be
    // pricing the smaller half of what the click buys.
    expect(dialog).toHaveTextContent('closes registration for good')
    expect(dialog).toHaveTextContent(
      'turns every ready fixture into a match its players can go and play',
    )
    expect(dialog).toHaveTextContent('It cannot be un-started.')
    expect(page.getConfirmButton()).toHaveTextContent('Start the tournament')
  })

  it('prices an END: archived is terminal, with no edge out of it', () => {
    page.render({
      consequence: buildEndTournamentConsequence({ tournamentName: 'Spring Open' }),
    })

    const dialog = page.getDialog()
    expect(dialog).toHaveTextContent('End this tournament?')
    expect(dialog).toHaveTextContent('Ending Spring Open')
    expect(dialog).toHaveTextContent('archived is the last thing a tournament is')
    expect(dialog).toHaveTextContent('no way back to live and no way to re-open it')
    expect(page.getConfirmButton()).toHaveTextContent('End the tournament')
  })

  /**
   * The **pool-count** act (ADR 20260808): an event's pool count is its pool rows, so
   * lowering it removes rows — and a row is a reservation with a window and a set of
   * tables somebody chose.
   *
   * The names are the point. "2 pools" would leave a director counting cards on the other
   * tab to find out which two they are about to lose.
   */
  it('prices a LOWERED POOL COUNT: the named pools, with the windows and tables they hold', () => {
    page.render({
      consequence: buildRemovePoolReservationsConsequence({
        eventName: 'Under 15s',
        poolNames: ['Pool E', 'Pool F'],
      }),
    })

    const dialog = page.getDialog()
    expect(dialog).toHaveTextContent('Remove 2 pool reservations?')
    expect(dialog).toHaveTextContent('Lowering the pool count for Under 15s')
    expect(dialog).toHaveTextContent('removes Pool E and Pool F')
    expect(dialog).toHaveTextContent(
      'Each one takes its time window and its reserved tables with it.',
    )
    expect(page.getConfirmButton()).toHaveTextContent('Remove 2 pools')
  })

  /** One pool is one reservation — the count, the noun and the button's object all move
   * together, so the dialog never reads "Remove 1 pool reservations?". */
  it('says a single removed pool in the singular, all the way to the button', () => {
    page.render({
      consequence: buildRemovePoolReservationsConsequence({ poolNames: ['Pool D'] }),
    })

    expect(page.getDialog()).toHaveTextContent('Remove 1 pool reservation?')
    expect(page.getDialog()).toHaveTextContent('removes Pool D.')
    expect(page.getConfirmButton()).toHaveTextContent('Remove the pool')
  })

  /** Three names read as a list. */
  it('lists three removed pools with a comma and an “and”', () => {
    page.render({
      consequence: buildRemovePoolReservationsConsequence({
        poolNames: ['Pool D', 'Pool E', 'Pool F'],
      }),
    })

    expect(page.getDialog()).toHaveTextContent('removes Pool D, Pool E and Pool F.')
  })

  /** The box admits 512, so "name every pool that goes" is a sentence that can run to
   * hundreds of names. Past the cap it names three and counts the rest. */
  it('caps the list rather than reading out every one of a long removal', () => {
    page.render({
      consequence: buildRemovePoolReservationsConsequence({
        poolNames: ['Pool C', 'Pool D', 'Pool E', 'Pool F', 'Pool G', 'Pool H'],
      }),
    })

    const dialog = page.getDialog()
    expect(dialog).toHaveTextContent('Remove 6 pool reservations?')
    expect(dialog).toHaveTextContent('removes Pool C, Pool D, Pool E and 3 more.')
    expect(dialog).not.toHaveTextContent('Pool H')
  })

  /** A pool's name is the one thing on its card a director can *clear*, and the confirm
   * comes before the save that refuses it. "removes  and Pool F" names nothing. */
  it('calls a pool with an emptied name box what it is', () => {
    page.render({
      consequence: buildRemovePoolReservationsConsequence({
        poolNames: ['   ', 'Pool F'],
      }),
    })

    expect(page.getDialog()).toHaveTextContent(
      'removes an unnamed pool and Pool F.',
    )
  })

  // Said the other way round, across all six: the sum type exists so that a variant
  // cannot render another act's sentence, and "X is present" alone would never catch a
  // dialog that also said everything else — or a generic "This cannot be undone" that
  // said nothing in particular.
  const SAID = {
    'recut-draw': 'deals a completely new set of pairings',
    'delete-draw': 'Nothing is kept.',
    'publish-tournament': 'puts it in front of everybody',
    'start-tournament': 'closes registration for good',
    'end-tournament': 'archived is the last thing a tournament is',
    'remove-pool-reservations': 'Lowering the pool count for',
  } as const

  it.each([
    { variant: 'recut-draw', consequence: buildRecutDrawConsequence() },
    { variant: 'delete-draw', consequence: buildDeleteDrawConsequence() },
    {
      variant: 'publish-tournament',
      consequence: buildPublishTournamentConsequence(),
    },
    { variant: 'start-tournament', consequence: buildStartTournamentConsequence() },
    { variant: 'end-tournament', consequence: buildEndTournamentConsequence() },
    {
      variant: 'remove-pool-reservations',
      consequence: buildRemovePoolReservationsConsequence(),
    },
  ] as const)(
    'gives $variant a sentence no other act says',
    ({ variant, consequence }) => {
      page.render({ consequence })

      for (const [other, sentence] of Object.entries(SAID)) {
        if (other === variant) expect(page.getDialog()).toHaveTextContent(sentence)
        else expect(page.getDialog()).not.toHaveTextContent(sentence)
      }
    },
  )

  /**
   * The button treatment, per act — decided in the same switch that writes the copy.
   *
   * `destructive` is for the three acts that throw work away — the two draw verbs (pairings,
   * and the schedule solved on them) and a lowered pool count (reservations, with their
   * windows and their tables). The three lifecycle edges destroy nothing: publishing opens a door,
   * starting mints matches, ending archives. They are one-way, which is what earns them
   * the dialog — not destructive, which is what would earn them the red. It also keeps
   * them off `variant="destructive"`, which fails AA colour contrast (#1039, open) and
   * carries an axe exclusion wherever it is on screen in `e2e/tournaments/`.
   */
  it.each([
    { name: 'a re-cut', consequence: buildRecutDrawConsequence(), destructive: true },
    { name: 'a delete', consequence: buildDeleteDrawConsequence(), destructive: true },
    {
      name: 'a publish',
      consequence: buildPublishTournamentConsequence(),
      destructive: false,
    },
    {
      name: 'a start',
      consequence: buildStartTournamentConsequence(),
      destructive: false,
    },
    { name: 'an end', consequence: buildEndTournamentConsequence(), destructive: false },
    {
      name: 'a lowered pool count',
      consequence: buildRemovePoolReservationsConsequence(),
      destructive: true,
    },
  ])('paints the confirm for $name', ({ consequence, destructive }) => {
    page.render({ consequence })

    // `bg-destructive` is the class the axe exclusion is keyed on
    // (`KNOWN_DESTRUCTIVE_BUTTON_CONTRAST`), so it is the thing worth pinning rather
    // than a prop name that never reaches the DOM.
    expect(page.getConfirmButton().className.includes('bg-destructive')).toBe(
      destructive,
    )
  })

  it('reports the confirm ONCE and as no kind of cancel — Radix closes on the action click through the same channel Escape uses', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    page.render({ onConfirm, onCancel })

    page.confirm()

    expect(onConfirm).toHaveBeenCalledTimes(1)
    // The whole point: Radix reports the ACTION's close through onOpenChange(false),
    // the same call Escape and the overlay make. A confirm that also fired the cancel
    // path would destroy the draw AND tell the caller nothing happened.
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('reads Escape as the cancel, and sends no confirm with it', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    page.render({ onConfirm, onCancel })

    page.pressEscape()

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('reads Go back as the cancel, and sends no confirm with it', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    page.render({ onConfirm, onCancel })

    page.cancel()

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('consumes the confirm per close: a dialog re-opened after confirming still cancels on Escape', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    page.render({ onConfirm, onCancel })

    page.confirm()
    expect(onCancel).not.toHaveBeenCalled()

    // The parent kept it mounted. The remembered confirm must NOT swallow the next
    // dismiss, or a director's second thoughts read as a second confirm.
    page.pressEscape()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('under the production wiring, confirming dismisses the dialog and still reports no cancel', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    page.renderControlled({ onConfirm, onCancel })

    page.confirm()

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(page.queryDialog()).not.toBeInTheDocument()
    // The dismiss the parent performs must not come back as a cancel either.
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('renders nothing while closed, and is a focus-trapping alertdialog while open', () => {
    page.render({ open: false })
    expect(page.queryDialog()).not.toBeInTheDocument()

    page.render({})
    expect(page.getDialog()).toHaveAttribute('role', 'alertdialog')
    expect(page.getDialog().contains(document.activeElement)).toBe(true)
  })
})
