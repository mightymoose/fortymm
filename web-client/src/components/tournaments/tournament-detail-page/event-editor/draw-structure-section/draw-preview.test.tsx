import { buildDrawPreviewPropsFor } from './draw-preview.factory'
import { drawPreviewPage } from './draw-preview.page'

describe('DrawPreview', () => {
  /**
   * The factory's default state: a 20-player cap, every setting the system's, so the
   * default divisor of five derives 4 groups of 5 — even, and sound.
   */
  describe('the default state — a 20-player cap, every setting the system’s', () => {
    it('says the draw is ready, in words and on the badge', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getVerdict()).toHaveTextContent('Ready to save')
      expect(drawPreviewPage.getBadge()).toHaveTextContent('Sound')
    })

    it('states the division it did', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getEquation()).toHaveTextContent(
        '20 players ÷ 4 groups = 5 per group',
      )
    })

    it('draws one card per group, lettered in order', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getGroupNames()).toEqual([
        'Group A',
        'Group B',
        'Group C',
        'Group D',
      ])
      for (const letter of ['A', 'B', 'C', 'D']) {
        const card = drawPreviewPage.group(letter).getCard()
        expect(card).toHaveTextContent('5')
        expect(card).toHaveTextContent('players')
        expect(card).toHaveTextContent('top 2 advance')
      }
    })

    it('reads the knockout out of the groups it feeds', () => {
      drawPreviewPage.render()

      const knockout = drawPreviewPage.getKnockout()
      expect(knockout).toHaveTextContent('Knockout')
      expect(knockout).toHaveTextContent('8-player bracket')
      expect(knockout).toHaveTextContent('No first-round byes')
      expect(knockout).toHaveTextContent('40 group matches')
    })

    it('deals membership by snake', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getFact('Membership')).toHaveTextContent('Snake')
    })

    it('says where the field it derived against came from', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getFact('Preview basis')).toHaveTextContent(
        '20-player cap',
      )
    })

    it('says when entrants actually get placed', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getFoot()).toHaveTextContent(
        'Entrants are placed only when registration closes and you cut the draw.',
      )
    })
  })

  // An all-automatic split is uneven whenever the field does not divide, and the
  // equation has to say so rather than round to a number no group holds.
  it('reads an uneven split as a range', () => {
    drawPreviewPage.render(
      buildDrawPreviewPropsFor({
        previewFieldSize: 22,
      }),
    )

    // 22 under the default divisor is five groups of 5, 5, 4, 4, 4.
    expect(drawPreviewPage.getEquation()).toHaveTextContent(
      '22 players ÷ 5 groups = 4–5 per group',
    )
  })

  /**
   * The reference's **"Numbers disagree"** state
   * (`docs/designs/rr-then-ko-draw-structure/numbers-disagree.png`): 6 groups of 5 seat
   * 30, and the field is 40.
   */
  describe('when the director’s two numbers disagree', () => {
    const disagreeing = () =>
      buildDrawPreviewPropsFor({
        previewFieldSize: 40,
        groupCountMode: 'manual',
        manualGroupCount: 6,
        groupSizeMode: 'manual',
        manualGroupSize: 5,
        qualifiersMode: 'manual',
        manualQualifiers: 1,
      })

    it('hands the call back to the director rather than picking a number', () => {
      drawPreviewPage.render(disagreeing())

      expect(drawPreviewPage.getVerdict()).toHaveTextContent(
        'Your numbers disagree',
      )
      expect(drawPreviewPage.getBadge()).toHaveTextContent('Your call')
    })

    it('still draws the structure those numbers describe', () => {
      drawPreviewPage.render(disagreeing())

      expect(drawPreviewPage.getGroupCards()).toHaveLength(6)
      expect(drawPreviewPage.getKnockout()).toHaveTextContent(
        '6-player bracket',
      )
      expect(drawPreviewPage.getKnockout()).toHaveTextContent('60 group matches')
    })

    it('counts more than one bye in the plural', () => {
      drawPreviewPage.render(disagreeing())

      expect(drawPreviewPage.getKnockout()).toHaveTextContent(
        '2 first-round byes',
      )
    })
  })

  // A bracket of three needs one player to sit out the first round, and "1 first-round
  // byes" is the kind of copy a director reads as a bug in the arithmetic.
  it('counts a single bye in the singular', () => {
    drawPreviewPage.render(
      buildDrawPreviewPropsFor({
        previewFieldSize: 32,
        groupCountMode: 'manual',
        manualGroupCount: 3,
        qualifiersMode: 'manual',
        manualQualifiers: 1,
      }),
    )

    expect(drawPreviewPage.getKnockout()).toHaveTextContent(
      '1 first-round bye',
    )
    expect(drawPreviewPage.getKnockout()).not.toHaveTextContent(
      '1 first-round byes',
    )
  })

  /**
   * The reference's **"Field too small"** state: 8 players across 6 manual groups is
   * 2, 2, 1, 1, 1, 1 — four groups with nobody to play.
   */
  describe('when the draw cannot be played', () => {
    const tooSmall = () =>
      buildDrawPreviewPropsFor({
        previewFieldSize: 8,
        groupCountMode: 'manual',
        manualGroupCount: 6,
        qualifiersMode: 'manual',
        manualQualifiers: 1,
      })

    it('refuses to call it ready', () => {
      drawPreviewPage.render(tooSmall())

      expect(drawPreviewPage.getVerdict()).toHaveTextContent(
        'This draw can’t work yet',
      )
      expect(drawPreviewPage.getBadge()).toHaveTextContent('Impossible')
    })

    // The derivation names only the FIRST unplayable group. The cards name every one of
    // them, because that is what a director has to fix.
    /**
     * The precedence, pinned. Four manual groups of one against a field of 32 trips
     * BOTH conditions at once: the seats do not add up (a disagreement) and every group
     * has one player in it (impossible). `data/draw-structure.ts` reports the two
     * independently and says the order belongs to whatever renders them — so it is this
     * component's, and a draw nobody can play is not "your call".
     */
    it('calls a draw that is both impossible and disagreeing impossible', () => {
      drawPreviewPage.render(
        buildDrawPreviewPropsFor({
          previewFieldSize: 32,
          groupCountMode: 'manual',
          manualGroupCount: 4,
          groupSizeMode: 'manual',
          manualGroupSize: 1,
        }),
      )

      expect(drawPreviewPage.getVerdict()).toHaveTextContent(
        'This draw can’t work yet',
      )
      expect(drawPreviewPage.getBadge()).toHaveTextContent('Impossible')
      expect(drawPreviewPage.getBadge()).not.toHaveTextContent('Your call')
    })

    it('marks each unplayable group, not just the first', () => {
      drawPreviewPage.render(tooSmall())

      expect(drawPreviewPage.group('A').queryTooSmall()).toBeNull()
      expect(drawPreviewPage.group('B').queryTooSmall()).toBeNull()
      for (const letter of ['C', 'D', 'E', 'F']) {
        expect(drawPreviewPage.group(letter).queryTooSmall()).toBeInTheDocument()
      }
    })
  })

  /**
   * ⚠️ The departure from the reference, now on both counts: the reference renders this
   * fact as `max(reservations, derived)`, which for this very state would print `8` and
   * hide the gap — and since #1386 the derivation does not read the reservation rows at
   * all, so the fact is fed its own prop. Both halves are asserted together, because
   * the gap — not either number — is the thing being reported.
   */
  it('states the event’s real reservation rows, even when the structure needs more', () => {
    drawPreviewPage.render(
      buildDrawPreviewPropsFor({
        previewFieldSize: 40,
        groupSizeMode: 'manual',
        manualGroupSize: 5,
      }),
    )

    // 40 in groups of 5 needs 8 groups. The factory's event has 4 reservation rows.
    expect(drawPreviewPage.getEquation()).toHaveTextContent('8 groups')
    expect(drawPreviewPage.getFact('Reservations')).toHaveTextContent('4')
  })

  // The cards are a shape, not an inventory: the equation above them keeps the real
  // count, so a big draw does not turn the column into a wall of cards.
  it('draws at most eight cards, and still states the true group count', () => {
    drawPreviewPage.render(
      buildDrawPreviewPropsFor({
        previewFieldSize: 48,
      }),
    )

    // 48 under the default divisor is ten groups.
    expect(drawPreviewPage.getGroupCards()).toHaveLength(8)
    expect(drawPreviewPage.getEquation()).toHaveTextContent('10 groups')
  })

  it('shows the preview basis it was given, cap or no cap', () => {
    drawPreviewPage.render({
      previewBasis: '16 players because this event has no cap',
    })

    expect(drawPreviewPage.getFact('Preview basis')).toHaveTextContent(
      '16 players because this event has no cap',
    )
  })

  describe('reading the preview without seeing it', () => {
    // The numbers move on every keystroke next door. A preview that swaps its text
    // silently is a preview a screen-reader user never learns changed.
    it('puts the derived numbers in a polite live region', () => {
      drawPreviewPage.render()

      const live = drawPreviewPage.getLiveRegion()
      expect(live).toContainElement(drawPreviewPage.getVerdict())
      expect(live).toContainElement(drawPreviewPage.getEquation())
      expect(live).toContainElement(drawPreviewPage.getKnockout())
    })

    // Atomic, it would re-read the equation, all eight groups, the knockout and the three
    // facts every time one digit moved.
    it('announces only the part that changed', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getLiveRegion()).toHaveAttribute(
        'aria-atomic',
        'false',
      )
    })

    it('names the panel and the group list', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getPreview()).toHaveAccessibleName(
        'The draw as it stands',
      )
      expect(drawPreviewPage.getGroupList()).toHaveAccessibleName(
        'Projected groups',
      )
    })
  })

  // The draw stays on screen while the director scrolls the settings that change it.
  it('sticks to the top of its column', () => {
    drawPreviewPage.render()

    expect(drawPreviewPage.getPreview()).toHaveClass('sticky')
  })

  // The reference ends with `Preview cut-time assignment →`. That screen is #1324, and a
  // link to nowhere is the unexplained dead end ADR-0015 forbids.
  it('offers no way out to a screen that does not exist yet', () => {
    drawPreviewPage.render()

    expect(drawPreviewPage.queryAllLinks()).toHaveLength(0)
  })
})
