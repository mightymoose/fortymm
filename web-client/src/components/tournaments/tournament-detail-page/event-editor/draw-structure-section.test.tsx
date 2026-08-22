import userEvent from '@testing-library/user-event'

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
   * The default state: a 20-player cap, nothing set. Every value AND every source
   * sentence, because the sentence is what makes the number checkable — `5` alone
   * cannot tell a director whether the app divided their field or invented a target.
   */
  describe('the default state — a 20-player cap, nothing set', () => {
    it('derives 4 groups, and says the default divisor is where that came from', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Group count')
      expect(row.getValue()).toHaveTextContent('4')
      expect(row.queryUnit()).toHaveTextContent('groups')
      expect(row.getSource()).toHaveTextContent(
        '20 players ÷ about 5 per group',
      )
    })

    it('derives 5 per group, and shows the division it did', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Group size')
      expect(row.getValue()).toHaveTextContent('5')
      expect(row.queryUnit()).toHaveTextContent('players per group')
      expect(row.getSource()).toHaveTextContent('20 players ÷ 4 groups')
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
      event: buildDrawStructureEvent({ maxPlayers: 22 }),
    })

    // 22 under the default divisor is five groups of 5, 5, 4, 4, 4.
    const row = drawStructureSectionPage.setting('Group size')
    expect(row.getValue()).toHaveTextContent('4–5')
    expect(row.queryUnit()).toHaveTextContent('players · uneven')
  })

  it('says "group", singular, when the field runs in one', () => {
    drawStructureSectionPage.render({
      event: buildDrawStructureEvent({ maxPlayers: 4 }),
    })

    const row = drawStructureSectionPage.setting('Group count')
    expect(row.getValue()).toHaveTextContent('1')
    expect(row.queryUnit()).toHaveTextContent('group')
  })

  describe('the field the preview derives against', () => {
    it('is the cap the director set, and says so', () => {
      drawStructureSectionPage.render()

      expect(drawStructureSectionPage.getPreviewFieldSize()).toHaveTextContent(
        '20',
      )
      expect(drawStructureSectionPage.getPreviewBasis()).toHaveTextContent(
        '20-player cap',
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
        '20 players ÷ 4 groups = 5 per group',
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
    it('says nothing about a draw that divides — 20 across 4', () => {
      drawStructureSectionPage.render()

      expect(drawStructureSectionPage.issuePanel.queryPanel()).toBeNull()
    })

    // A 22-player cap under the default divisor is five groups of 5, 5, 4, 4, 4.
    it('reads out an uneven split, under the settings that produced it', () => {
      drawStructureSectionPage.render({
        event: buildDrawStructureEvent({ maxPlayers: 22 }),
      })

      const panel = drawStructureSectionPage.issuePanel.getPanel()
      expect(drawStructureSectionPage.issuePanel.getTitle()).toHaveTextContent(
        '2 groups of 5 · 3 groups of 4',
      )
      // The left column, beside the preview and not inside it.
      expect(drawStructureSectionPage.getPreviewSlot()).not.toContainElement(
        panel,
      )
    })

    /**
     * ⚠️ The case the precedence exists for. A 7-player cap derives two groups of
     * `4, 3`, and the automatic qualifier count — `ceil(8 / 2)` is four — takes more
     * than the smaller group holds. That is an uneven tally AND an impossible
     * competition, both reported at once — and `Legal, but uneven` is not the thing to
     * say about a draw nobody can play.
     *
     * The Group size row proves the tally really is there. Without it this test would
     * also pass on a draw that is not uneven at all, and prove nothing about the order.
     */
    it('drops the uneven notice when the draw cannot be played — a 7-player cap', () => {
      drawStructureSectionPage.render({
        event: buildDrawStructureEvent({ maxPlayers: 7 }),
      })

      const row = drawStructureSectionPage.setting('Group size')
      expect(row.getValue()).toHaveTextContent('3–4')
      expect(row.queryUnit()).toHaveTextContent('players · uneven')

      expect(drawStructureSectionPage.issuePanel.queryPanel()).toBeNull()
      // …and the director is not left guessing: the preview says so.
      expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
        'This draw can’t work yet',
      )
    })
  })

  /**
   * #1388. Removing a reservation must not move the group count this tab reads out.
   *
   * The tab is where a director would notice a group count and a reservation count
   * disagreeing, and this ticket's decision 2 is that nothing reports that. The
   * derivation stopped reading the reservation rows in #1386, and the call site was
   * rewired with it — but a call site can keep feeding a reservation count into a
   * parameter that no longer governs, and this is the assertion that would catch it.
   *
   * The `Reservations` fact is asserted alongside, so the fixture is proven to have
   * really changed. Without it the test would also pass on a component that ignored
   * the event entirely.
   *
   * Only the group count is pinned here. The tab's three notice kinds are a separate
   * question: the uneven and impossible notices are reachable with automatic settings
   * and report nothing about a reservation count, and the disagreement notice is
   * unreachable while both ownership modes are `automatic` — so a test asserting "no
   * warning" would red on the uneven notice, and that red would not be a defect.
   */
  describe('a reservation removal', () => {
    it.each([
      ['four reservations', 4],
      ['one reservation', 1],
      ['no reservations', 0],
    ])('reads the same 4 groups with %s', (_label, count) => {
      drawStructureSectionPage.render({
        event: buildDrawStructureEvent({
          reservations: buildDrawStructureEvent().reservations.slice(0, count),
        }),
      })

      const row = drawStructureSectionPage.setting('Group count')
      expect(row.getValue()).toHaveTextContent('4')
      expect(row.getSource()).toHaveTextContent('20 players ÷ about 5 per group')
      // The event really did change under the tab.
      expect(
        drawStructureSectionPage.preview.getFact('Reservations'),
      ).toHaveTextContent(String(count))
    })
  })
})
