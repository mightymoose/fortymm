import userEvent from '@testing-library/user-event'

import { buildReservation } from '../../data/seed.factory'
import { buildDrawStructureEvent } from './draw-structure-section.factory'
import { drawStructureSectionPage } from './draw-structure-section.page'

describe('DrawStructureSection', () => {
  it('says what the tab is for, in the reference’s words', () => {
    drawStructureSectionPage.render()

    expect(drawStructureSectionPage.getHeading()).toHaveTextContent(
      'Set what matters. We’ll work out the rest.',
    )
    expect(drawStructureSectionPage.getSection()).toHaveTextContent(
      'Groups play all-play-all. The top finishers move into a knockout bracket.',
    )
  })

  // The order is the reference's, and it is the order a director reads the draw in:
  // how many groups, how big, who is in them, how many come out.
  it('lists the four settings in order', () => {
    drawStructureSectionPage.render()

    expect(drawStructureSectionPage.getSettingNames()).toEqual([
      'Group count',
      'Group size',
      'Membership',
      'Qualifiers per group',
    ])
  })

  /**
   * The reference's "Nothing set" state: 32 players over 4 reservations. Every
   * value AND every source sentence, because the sentence is what makes the number
   * checkable — `8` alone cannot tell a director whether the app divided their field or
   * invented a target.
   */
  describe('the reference’s "Nothing set" state — 32 players, 4 reservations', () => {
    it('derives 4 groups, and says the reservations are where that came from', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Group count')
      expect(row.getValue()).toHaveTextContent('4')
      expect(row.queryUnit()).toHaveTextContent('groups')
      expect(row.getSource()).toHaveTextContent(
        "4 reservations · today's behaviour",
      )
    })

    it('derives 8 per group, and shows the division it did', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Group size')
      expect(row.getValue()).toHaveTextContent('8')
      expect(row.queryUnit()).toHaveTextContent('players per group')
      expect(row.getSource()).toHaveTextContent('32 players ÷ 4 groups')
    })

    it('deals membership by snake, and says how the seeds spread', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Membership')
      expect(row.getValue()).toHaveTextContent('Snake automatically')
      expect(row.getSource()).toHaveTextContent('Seeds spread 1, 2, 3, 3, 2, 1.')
      // No number, so no unit — the value is already a sentence.
      expect(row.queryUnit()).toBeNull()
    })

    it('takes 2 through from each group, aiming at the 8-player knockout', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Qualifiers per group')
      expect(row.getValue()).toHaveTextContent('2')
      expect(row.queryUnit()).toHaveTextContent('through from each group')
      expect(row.getSource()).toHaveTextContent(
        'Aiming at an 8-player knockout across 4 groups.',
      )
    })

    // ADR 20260808: the owner is readable as TEXT on every row, never as a shade.
    it('marks all four values Automatic, in words', () => {
      drawStructureSectionPage.render()

      for (const name of [
        'Group count',
        'Group size',
        'Membership',
        'Qualifiers per group',
      ]) {
        expect(
          drawStructureSectionPage.setting(name).getOwnershipBadge(),
        ).toHaveTextContent('Automatic')
      }
    })
  })

  // Row copy, not the 2d notice panel: an all-automatic split is uneven whenever the
  // field does not divide, and the row has to say so rather than round.
  it('reads an uneven split as a range, and says "uneven" in the unit', () => {
    drawStructureSectionPage.render({
      event: buildDrawStructureEvent({
        reservations: [
          buildReservation({ id: 'res-a', name: 'Reservation A', position: 0 }),
          buildReservation({ id: 'res-b', name: 'Reservation B', position: 1 }),
          buildReservation({ id: 'res-c', name: 'Reservation C', position: 2 }),
        ],
      }),
    })

    // 32 across 3 is 11, 11, 10.
    const row = drawStructureSectionPage.setting('Group size')
    expect(row.getValue()).toHaveTextContent('10–11')
    expect(row.queryUnit()).toHaveTextContent('players · uneven')
  })

  it('says "group", singular, when the field runs in one', () => {
    drawStructureSectionPage.render({
      event: buildDrawStructureEvent({ reservations: [buildReservation()] }),
    })

    const row = drawStructureSectionPage.setting('Group count')
    expect(row.getValue()).toHaveTextContent('1')
    expect(row.queryUnit()).toHaveTextContent('group')
  })

  describe('the field the preview derives against', () => {
    it('is the cap the director set, and says so', () => {
      drawStructureSectionPage.render()

      expect(drawStructureSectionPage.getPreviewFieldSize()).toHaveTextContent(
        '32',
      )
      expect(drawStructureSectionPage.getPreviewBasis()).toHaveTextContent(
        '32-player cap',
      )
    })

    /**
     * ⚠️ The deviation #1320 requires. The reference labels the basis `{n}-player cap`
     * in every state, which for an uncapped event names a cap nobody set — and would
     * send a director to the Basics tab looking for a number that is not there.
     */
    it('falls back to 16 for an uncapped event, and does NOT call the 16 a cap', () => {
      drawStructureSectionPage.render({
        event: buildDrawStructureEvent({ maxPlayers: null }),
      })

      expect(drawStructureSectionPage.getPreviewFieldSize()).toHaveTextContent(
        '16',
      )
      expect(drawStructureSectionPage.getPreviewBasis()).toHaveTextContent(
        '16 players because this event has no cap',
      )
      expect(drawStructureSectionPage.getPreviewBasis()).not.toHaveTextContent(
        '16-player cap',
      )
      // …and the whole tab is derived against it: 16 over 4 groups is 4 apiece.
      expect(
        drawStructureSectionPage.setting('Group size').getSource(),
      ).toHaveTextContent('16 players ÷ 4 groups')
    })

    it('sends the director to Basics to change it', async () => {
      const onGoToBasics = vi.fn()
      drawStructureSectionPage.render({ onGoToBasics })

      await userEvent.click(drawStructureSectionPage.getChangeInBasicsButton())

      expect(onGoToBasics).toHaveBeenCalledTimes(1)
    })
  })

  /**
   * Wiring only: the preview's copy, states and arithmetic are pinned by
   * `draw-preview.test.tsx`. What the tab owns is that the preview sits in the right
   * column and is fed the same derivation the rows read.
   */
  describe('the live preview', () => {
    it('fills the right-hand column', () => {
      drawStructureSectionPage.render()

      expect(drawStructureSectionPage.getPreviewSlot()).toContainElement(
        drawStructureSectionPage.preview.getPreview(),
      )
    })

    it('is derived from the same numbers the rows read out', () => {
      drawStructureSectionPage.render()

      expect(drawStructureSectionPage.preview.getEquation()).toHaveTextContent(
        '32 players ÷ 4 groups = 8 per group',
      )
      expect(
        drawStructureSectionPage.preview.getFact('Reservations'),
      ).toHaveTextContent('4')
    })

    // One call to `previewBasisLabel`, two readers — so the heading block and the
    // preview can never come to say different things about the same number.
    it('says the same thing about the preview field as the heading block does', () => {
      drawStructureSectionPage.render({
        event: buildDrawStructureEvent({ maxPlayers: null }),
      })

      const basis = '16 players because this event has no cap'
      expect(drawStructureSectionPage.getPreviewBasis()).toHaveTextContent(basis)
      expect(
        drawStructureSectionPage.preview.getFact('Preview basis'),
      ).toHaveTextContent(basis)
    })

    // There is exactly one verdict on this tab. A second summary would give a director
    // two places to look and let one of them go stale.
    it('is the tab’s only summary of the draw', () => {
      drawStructureSectionPage.render()

      expect(drawStructureSectionPage.preview.queryAllPreviews()).toHaveLength(1)
      expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
        'Ready to save',
      )
    })
  })

  /**
   * Wiring and precedence. The panel's copy and its role are pinned by
   * `draw-issue-panel.test.tsx`; what the tab owns is which notice appears, and where.
   */
  describe('the one notice', () => {
    it('says nothing about a draw that divides — 32 across 4', () => {
      drawStructureSectionPage.render()

      expect(drawStructureSectionPage.issuePanel.queryPanel()).toBeNull()
    })

    // The reference's "Uneven field" state: 22 across 4 is 6, 6, 5, 5.
    it('reads out an uneven split, under the settings that produced it', () => {
      drawStructureSectionPage.render({
        event: buildDrawStructureEvent({ maxPlayers: 22 }),
      })

      const panel = drawStructureSectionPage.issuePanel.getPanel()
      expect(drawStructureSectionPage.issuePanel.getTitle()).toHaveTextContent(
        '2 groups of 6 · 2 groups of 5',
      )
      // The left column, beside the preview and not inside it.
      expect(drawStructureSectionPage.getPreviewSlot()).not.toContainElement(
        panel,
      )
    })

    /**
     * ⚠️ The case the precedence exists for, and the reference's "Field too small" state:
     * 8 players over 6 reservations splits `2, 2, 1, 1, 1, 1`. That is an uneven
     * tally AND four groups nobody can play in, both reported at once — and
     * `Legal, but uneven` is not the thing to say about a group of one.
     *
     * The Group size row proves the tally really is there. Without it this test would
     * also pass on a draw that is not uneven at all, and prove nothing about the order.
     */
    it('drops the uneven notice when a group cannot be played — 8 across 6', () => {
      drawStructureSectionPage.render({
        event: buildDrawStructureEvent({
          maxPlayers: 8,
          reservations: Array.from({ length: 6 }, (_, i) =>
            buildReservation({ id: `res-${i}`, name: `Reservation ${i}`, position: i }),
          ),
        }),
      })

      const row = drawStructureSectionPage.setting('Group size')
      expect(row.getValue()).toHaveTextContent('1–2')
      expect(row.queryUnit()).toHaveTextContent('players · uneven')

      expect(drawStructureSectionPage.issuePanel.queryPanel()).toBeNull()
      // …and the director is not left guessing: the preview says so.
      expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
        'This draw can’t work yet',
      )
    })
  })
})
