import userEvent from '@testing-library/user-event'

import {
  buildImpossibleDrawFixes,
  buildImpossibleDrawIssue,
  buildUnevenDrawIssue,
} from './draw-issue-panel.factory'
import { drawIssuePanelPage } from './draw-issue-panel.page'

// Which kind reaches the panel is `drawIssueFor`'s call, and `./draw-issue.test.ts` pins
// it. This file pins what the panel does with the kind it is handed.
describe('DrawIssuePanel', () => {
  /**
   * The reference's **"Field too small"** state
   * (`docs/designs/rr-then-ko-draw-structure/field-too-small-panel.png`): 8 players across
   * 6 pools, which leaves four pools with one player in them.
   */
  describe('the refusal', () => {
    const renderRefusal = (
      overrides: Parameters<typeof drawIssuePanelPage.render>[0] = {},
    ) => {
      const onApplyFix = vi.fn()
      drawIssuePanelPage.render({
        issue: buildImpossibleDrawIssue(),
        fixes: buildImpossibleDrawFixes(),
        onApplyFix,
        ...overrides,
      })
      return { onApplyFix }
    }

    it('says the save is blocked, in words rather than in a colour', () => {
      renderRefusal()

      expect(drawIssuePanelPage.getTopline('Can’t save')).toBeInTheDocument()
    })

    it('names the cause, and what to do about it', () => {
      renderRefusal()

      expect(drawIssuePanelPage.getTitle()).toHaveTextContent(
        'Pool C would have one player',
      )
      expect(drawIssuePanelPage.getBody()).toHaveTextContent(
        'They would have nobody to play. Use fewer pools or raise the player limit.',
      )
    })

    /**
     * `alert`, not `status`. This notice reports a **blocked act** — the save is
     * unavailable while it is on screen — so it interrupts rather than waiting to be
     * reached. The uneven notice below makes the opposite call, which is what makes the
     * role variant data rather than a constant.
     */
    it('interrupts, as an alert and not a status', () => {
      renderRefusal()

      expect(drawIssuePanelPage.getPanel()).toHaveAttribute('role', 'alert')
    })

    it('offers each fix as a label, a detail line and one button', () => {
      renderRefusal()

      const [fewerPools, biggerField] = drawIssuePanelPage.getFixes()
      expect(fewerPools.getLabel()).toHaveTextContent('Use 4 pools')
      expect(fewerPools.getDetail()).toHaveTextContent(
        'Every pool gets at least two players.',
      )
      expect(fewerPools.getApply()).toHaveTextContent('Apply')
      expect(biggerField.getLabel()).toHaveTextContent(
        'Raise the player limit to 12',
      )
      expect(biggerField.getDetail()).toHaveTextContent('Keeps your pool count.')
    })

    /** Both ways out, in the reference's order — fewer pools first, then a bigger field.
     * A test that only counted the rows would pass on either order. */
    it('lists the fixes it was handed, in order', () => {
      renderRefusal()

      expect(drawIssuePanelPage.getFixLabels()).toEqual([
        'Use 4 pools',
        'Raise the player limit to 12',
      ])
    })

    /** Every button reads `Apply`, so the visible words alone name no fix. The accessible
     * name carries the label — otherwise a screen-reader user meeting a list of buttons
     * hears "Apply, Apply" and has to guess. */
    it('names the fix in each button’s accessible name', async () => {
      const { onApplyFix } = renderRefusal()

      await userEvent.click(
        drawIssuePanelPage.getApplyButton('Raise the player limit to 12'),
      )

      // ⚠️ The whole fix, not its label: the tab routes it by `kind` and writes its
      // number, so a panel that handed back only what it rendered would make the tab
      // re-derive the fix it just clicked.
      expect(onApplyFix).toHaveBeenCalledWith({
        kind: 'player-limit',
        label: 'Raise the player limit to 12',
        detail: 'Keeps your pool count.',
        maxPlayers: 12,
      })
    })

    /** The panel renders the fix list it is handed and derives none. A reader is handed
     * an empty one (ADR-0015 — a read-only surface is a view, not a disabled form), and
     * the refusal still has to say why it refuses. */
    it('still states the cause when there is nothing to offer', () => {
      renderRefusal({ fixes: [] })

      expect(drawIssuePanelPage.getTitle()).toHaveTextContent(
        'Pool C would have one player',
      )
      expect(drawIssuePanelPage.getFixes()).toHaveLength(0)
    })

    /** The refusal is not always about a pool: the derivation names one of three
     * competitions, and the panel prints whichever it was handed. */
    it('prints the derivation’s words, whichever refusal it is', () => {
      renderRefusal({
        issue: buildImpossibleDrawIssue({
          kind: 'bracket',
          title: 'The knockout would have one player',
          body: 'One player has nobody to play. Take more qualifiers or run more pools.',
        }),
        fixes: [
          {
            kind: 'qualifiers',
            label: 'Take top 2',
            detail: 'Creates a playable knockout.',
            qualifiersPerPool: 2,
          },
        ],
      })

      expect(drawIssuePanelPage.getTitle()).toHaveTextContent(
        'The knockout would have one player',
      )
      expect(drawIssuePanelPage.getFixLabels()).toEqual(['Take top 2'])
    })
  })

  describe('the uneven notice', () => {
    it('says the split is legal, in words rather than in a colour', () => {
      drawIssuePanelPage.render()

      expect(
        drawIssuePanelPage.getTopline('Legal, but uneven'),
      ).toBeInTheDocument()
    })

    // The reference's "Uneven field" state: 22 across 4 is 6, 6, 5, 5.
    it('reads the tally out largest pool first', () => {
      drawIssuePanelPage.render()

      expect(drawIssuePanelPage.getTitle()).toHaveTextContent(
        '2 pools of 6 · 2 pools of 5',
      )
    })

    /**
     * A deviation from the reference, which shows only a two-and-two tally. `1 pool` is
     * reachable today — a field of 7 over 2 pool reservations splits 4, 3 — and unlike
     * the `1 pool reservations` sentence next door this title has no Python twin
     * transcribing it against shared vectors, so pluralising it drifts nothing.
     */
    it('says "pool", singular, for a run of one', () => {
      drawIssuePanelPage.render({
        issue: buildUnevenDrawIssue({
          distribution: [
            { pools: 1, size: 4 },
            { pools: 1, size: 3 },
          ],
        }),
      })

      expect(drawIssuePanelPage.getTitle()).toHaveTextContent(
        '1 pool of 4 · 1 pool of 3',
      )
    })

    it('says what uneven costs, and what was not done to the numbers', () => {
      drawIssuePanelPage.render()

      expect(drawIssuePanelPage.getBody()).toHaveTextContent(
        'The bigger pools play more matches. Nothing has been silently reshaped.',
      )
    })

    /**
     * `status`, not `alert`. An uneven split is legal: it disables nothing and saving
     * stays available, so it must be announced when the reader reaches it rather than
     * interrupt whatever they were reading.
     */
    it('announces itself politely, as a status and not an alert', () => {
      drawIssuePanelPage.render()

      expect(drawIssuePanelPage.getPanel()).toHaveAttribute('role', 'status')
      expect(drawIssuePanelPage.getPanel()).not.toHaveAttribute('role', 'alert')
    })

    it('offers nothing to click — an uneven split has nothing to fix', () => {
      drawIssuePanelPage.render()

      expect(
        drawIssuePanelPage.getPanel().querySelectorAll('button, a, input'),
      ).toHaveLength(0)
    })
  })

  // The disagreement's panel comes with three resolutions no derivation can supply, so the
  // tab shows nothing rather than half of one. The live preview beside it already reads
  // `Your numbers disagree`, so the state is not silent.
  describe('the variant that is not built yet', () => {
    it('renders nothing for the disagreement kind (chore 5a)', () => {
      drawIssuePanelPage.render({
        issue: {
          kind: 'disagreement',
          disagreement: {
            poolCount: 6,
            poolSize: 5,
            seats: 30,
            fieldSize: 40,
            direction: 'unseated',
            count: 10,
          },
        },
      })

      expect(drawIssuePanelPage.queryPanel()).toBeNull()
    })
  })
})
