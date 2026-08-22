import { buildUnevenDrawIssue } from './draw-issue-panel.factory'
import { drawIssuePanelPage } from './draw-issue-panel.page'

// Which kind reaches the panel is `drawIssueFor`'s call, and `./draw-issue.test.ts` pins
// it. This file pins what the panel does with the kind it is handed.
describe('DrawIssuePanel', () => {
  describe('the uneven notice', () => {
    it('says the split is legal, in words rather than in a colour', () => {
      drawIssuePanelPage.render()

      expect(drawIssuePanelPage.getTopline()).toBeInTheDocument()
    })

    // The reference's "Uneven field" state: 22 across 4 is 6, 6, 5, 5.
    it('reads the tally out largest group first', () => {
      drawIssuePanelPage.render()

      expect(drawIssuePanelPage.getTitle()).toHaveTextContent(
        '2 groups of 6 · 2 groups of 5',
      )
    })

    /**
     * A deviation from the reference, which shows only a two-and-two tally. `1 group` is
     * reachable today — a field of 7 over 2 reservations splits 4, 3 — and unlike
     * the `1 reservations` sentence next door this title has no Python twin
     * transcribing it against shared vectors, so pluralising it drifts nothing.
     */
    it('says "group", singular, for a run of one', () => {
      drawIssuePanelPage.render({
        issue: buildUnevenDrawIssue({
          distribution: [
            { groups: 1, size: 4 },
            { groups: 1, size: 3 },
          ],
        }),
      })

      expect(drawIssuePanelPage.getTitle()).toHaveTextContent(
        '1 group of 4 · 1 group of 3',
      )
    })

    it('says what uneven costs, and what was not done to the numbers', () => {
      drawIssuePanelPage.render()

      expect(drawIssuePanelPage.getBody()).toHaveTextContent(
        'The bigger groups play more matches. Nothing has been silently reshaped.',
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

  // Both panels come with fixes and `Apply` buttons no derivation can supply, so the tab
  // shows nothing rather than half of one. The live preview beside it already reads
  // `This draw can’t work yet` / `Your numbers disagree`, so neither state is silent.
  describe('the two variants that are not built yet', () => {
    it('renders nothing for the impossible kind (chore 4c)', () => {
      drawIssuePanelPage.render({
        issue: {
          kind: 'impossible',
          problem: {
            kind: 'group',
            title: 'Group C would have one player',
            body: 'They would have nobody to play. Use fewer groups or raise the player limit.',
          },
        },
      })

      expect(drawIssuePanelPage.queryPanel()).toBeNull()
    })

    it('renders nothing for the disagreement kind (chore 5a)', () => {
      drawIssuePanelPage.render({
        issue: {
          kind: 'disagreement',
          disagreement: {
            groupCount: 6,
            groupSize: 5,
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
