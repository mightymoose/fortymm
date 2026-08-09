import { buildDrawPreviewPropsFor } from './draw-preview.factory'
import { drawPreviewPage } from './draw-preview.page'

describe('DrawPreview', () => {
  /**
   * The reference's **"Nothing set"** state
   * (`docs/designs/rr-then-ko-draw-structure/nothing-set.png`): 32 players across 4 pool
   * reservations, every setting the system's.
   */
  describe('the reference’s "Nothing set" state — 32 players, 4 reservations', () => {
    it('says the draw is ready, in words and on the badge', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getVerdict()).toHaveTextContent('Ready to save')
      expect(drawPreviewPage.getBadge()).toHaveTextContent('Sound')
    })

    it('states the division it did', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getEquation()).toHaveTextContent(
        '32 players ÷ 4 pools = 8 per pool',
      )
    })

    it('draws one card per pool, lettered in order', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getPoolNames()).toEqual([
        'Pool A',
        'Pool B',
        'Pool C',
        'Pool D',
      ])
      for (const letter of ['A', 'B', 'C', 'D']) {
        const card = drawPreviewPage.pool(letter).getCard()
        expect(card).toHaveTextContent('8')
        expect(card).toHaveTextContent('players')
        expect(card).toHaveTextContent('top 2 advance')
      }
    })

    it('reads the knockout out of the pools it feeds', () => {
      drawPreviewPage.render()

      const knockout = drawPreviewPage.getKnockout()
      expect(knockout).toHaveTextContent('Knockout')
      expect(knockout).toHaveTextContent('8-player bracket')
      expect(knockout).toHaveTextContent('No first-round byes')
      expect(knockout).toHaveTextContent('112 pool matches')
    })

    it('deals membership by snake', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getFact('Membership')).toHaveTextContent('Snake')
    })

    // …and says so in its own, shorter words when the director takes it: the setting row
    // one column over reads `Assign at cut time`, this fact reads `By hand at cut`.
    it('says when the director will place the field themselves', () => {
      drawPreviewPage.render({ membershipMode: 'manual' })

      expect(drawPreviewPage.getFact('Membership')).toHaveTextContent(
        'By hand at cut',
      )
    })

    it('says where the field it derived against came from', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getFact('Preview basis')).toHaveTextContent(
        '32-player cap',
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
  // equation has to say so rather than round to a number no pool holds.
  it('reads an uneven split as a range', () => {
    drawPreviewPage.render(
      buildDrawPreviewPropsFor({
        previewFieldSize: 22,
        poolReservationCount: 4,
      }),
    )

    // 22 across 4 is 6, 6, 5, 5.
    expect(drawPreviewPage.getEquation()).toHaveTextContent(
      '22 players ÷ 4 pools = 5–6 per pool',
    )
  })

  /**
   * ⚠️ **An uneven split is sound.** The tab says so under the settings
   * (`Legal, but uneven`) and the draw saves, so the verdict here is the ready one.
   *
   * This is the guard on the verdict's one non-obvious mapping. The preview asks
   * `drawIssueFor` which notice the tab is showing — one precedence, shared with the
   * panel — and that function reports FOUR outcomes against three verdicts. A lookup keyed
   * straight off the issue kind would leave this state with no verdict at all.
   */
  it('still calls an uneven draw ready', () => {
    drawPreviewPage.render(
      buildDrawPreviewPropsFor({
        previewFieldSize: 22,
        poolReservationCount: 4,
      }),
    )

    expect(drawPreviewPage.getVerdict()).toHaveTextContent('Ready to save')
    expect(drawPreviewPage.getBadge()).toHaveTextContent('Sound')
  })

  /**
   * The reference's **"Numbers disagree"** state
   * (`docs/designs/rr-then-ko-draw-structure/numbers-disagree.png`): 6 pools of 5 seat
   * 30, and the field is 40.
   */
  describe('when the director’s two numbers disagree', () => {
    const disagreeing = () =>
      buildDrawPreviewPropsFor({
        previewFieldSize: 40,
        poolReservationCount: 6,
        poolCountMode: 'manual',
        manualPoolCount: 6,
        poolSizeMode: 'manual',
        manualPoolSize: 5,
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

      expect(drawPreviewPage.getPoolCards()).toHaveLength(6)
      expect(drawPreviewPage.getKnockout()).toHaveTextContent(
        '6-player bracket',
      )
      expect(drawPreviewPage.getKnockout()).toHaveTextContent('60 pool matches')
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
        poolReservationCount: 3,
        poolCountMode: 'manual',
        manualPoolCount: 3,
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
   * The reference's **"Field too small"** state: 8 players across 6 manual pools is
   * 2, 2, 1, 1, 1, 1 — four pools with nobody to play.
   */
  describe('when the draw cannot be played', () => {
    const tooSmall = () =>
      buildDrawPreviewPropsFor({
        previewFieldSize: 8,
        poolReservationCount: 6,
        poolCountMode: 'manual',
        manualPoolCount: 6,
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

    // The derivation names only the FIRST unplayable pool. The cards name every one of
    // them, because that is what a director has to fix.
    /**
     * The precedence, pinned. Four manual pools of one against a field of 32 trips
     * BOTH conditions at once: the seats do not add up (a disagreement) and every pool
     * has one player in it (impossible). `data/draw-structure.ts` reports the two
     * independently and says the order belongs to whatever renders them — so it is this
     * component's, and a draw nobody can play is not "your call".
     */
    it('calls a draw that is both impossible and disagreeing impossible', () => {
      drawPreviewPage.render(
        buildDrawPreviewPropsFor({
          previewFieldSize: 32,
          poolReservationCount: 4,
          poolCountMode: 'manual',
          manualPoolCount: 4,
          poolSizeMode: 'manual',
          manualPoolSize: 1,
        }),
      )

      expect(drawPreviewPage.getVerdict()).toHaveTextContent(
        'This draw can’t work yet',
      )
      expect(drawPreviewPage.getBadge()).toHaveTextContent('Impossible')
      expect(drawPreviewPage.getBadge()).not.toHaveTextContent('Your call')
    })

    it('marks each unplayable pool, not just the first', () => {
      drawPreviewPage.render(tooSmall())

      expect(drawPreviewPage.pool('A').queryTooSmall()).toBeNull()
      expect(drawPreviewPage.pool('B').queryTooSmall()).toBeNull()
      for (const letter of ['C', 'D', 'E', 'F']) {
        expect(drawPreviewPage.pool(letter).queryTooSmall()).toBeInTheDocument()
      }
    })
  })

  /**
   * ⚠️ The ADR's departure from the reference
   * (`20260808-an-events-pool-count-is-its-pool-rows-and-a-derived-count-is-a-projection`).
   * The reference renders this fact as `max(reservations, derived)`, which for this very
   * state would print `8` and hide the gap. Both halves are asserted together, because
   * the gap — not either number — is the thing being reported.
   */
  it('states the event’s real pool rows, even when the structure needs more', () => {
    drawPreviewPage.render(
      buildDrawPreviewPropsFor({
        previewFieldSize: 40,
        poolReservationCount: 4,
        poolSizeMode: 'manual',
        manualPoolSize: 5,
      }),
    )

    // 40 in pools of 5 needs 8 pools. The event has 4 rows.
    expect(drawPreviewPage.getEquation()).toHaveTextContent('8 pools')
    expect(drawPreviewPage.getFact('Pool reservations')).toHaveTextContent('4')
  })

  // The cards are a shape, not an inventory: the equation above them keeps the real
  // count, so a big draw does not turn the column into a wall of cards.
  it('draws at most eight cards, and still states the true pool count', () => {
    drawPreviewPage.render(
      buildDrawPreviewPropsFor({
        previewFieldSize: 48,
        poolReservationCount: 12,
      }),
    )

    expect(drawPreviewPage.getPoolCards()).toHaveLength(8)
    expect(drawPreviewPage.getEquation()).toHaveTextContent('12 pools')
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

    // Atomic, it would re-read the equation, all eight pools, the knockout and the three
    // facts every time one digit moved.
    it('announces only the part that changed', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getLiveRegion()).toHaveAttribute(
        'aria-atomic',
        'false',
      )
    })

    it('names the panel and the pool group', () => {
      drawPreviewPage.render()

      expect(drawPreviewPage.getPreview()).toHaveAccessibleName(
        'The draw as it stands',
      )
      expect(drawPreviewPage.getPoolList()).toHaveAccessibleName(
        'Projected pools',
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
