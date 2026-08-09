import userEvent from '@testing-library/user-event'

import { buildPool } from '../../data/seed.factory'
import { buildDrawStructureEvent } from './draw-structure-section.factory'
import { drawStructureSectionPage } from './draw-structure-section.page'

describe('DrawStructureSection', () => {
  it('says what the tab is for, in the reference’s words', () => {
    drawStructureSectionPage.render()

    expect(drawStructureSectionPage.getHeading()).toHaveTextContent(
      'Set what matters. We’ll work out the rest.',
    )
    expect(drawStructureSectionPage.getSection()).toHaveTextContent(
      'Pools play all-play-all. The top finishers move into a knockout bracket.',
    )
  })

  // The order is the reference's, and it is the order a director reads the draw in:
  // how many pools, how big, who is in them, how many come out.
  it('lists the four settings in order', () => {
    drawStructureSectionPage.render()

    expect(drawStructureSectionPage.getSettingNames()).toEqual([
      'Pool count',
      'Pool size',
      'Membership',
      'Qualifiers per pool',
    ])
  })

  /**
   * The reference's "Nothing set" state: 32 players over 4 pool reservations. Every
   * value AND every source sentence, because the sentence is what makes the number
   * checkable — `8` alone cannot tell a director whether the app divided their field or
   * invented a target.
   */
  describe('the reference’s "Nothing set" state — 32 players, 4 reservations', () => {
    it('derives 4 pools, and says the reservations are where that came from', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Pool count')
      expect(row.getValue()).toHaveTextContent('4')
      expect(row.queryUnit()).toHaveTextContent('pools')
      expect(row.getSource()).toHaveTextContent(
        "4 pool reservations · today's behaviour",
      )
    })

    it('derives 8 per pool, and shows the division it did', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Pool size')
      expect(row.getValue()).toHaveTextContent('8')
      expect(row.queryUnit()).toHaveTextContent('players per pool')
      expect(row.getSource()).toHaveTextContent('32 players ÷ 4 pools')
    })

    it('deals membership by snake, and says how the seeds spread', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Membership')
      expect(row.getValue()).toHaveTextContent('Snake automatically')
      expect(row.getSource()).toHaveTextContent('Seeds spread 1, 2, 3, 3, 2, 1.')
      // No number, so no unit — the value is already a sentence.
      expect(row.queryUnit()).toBeNull()
    })

    it('takes 2 through from each pool, aiming at the 8-player knockout', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Qualifiers per pool')
      expect(row.getValue()).toHaveTextContent('2')
      expect(row.queryUnit()).toHaveTextContent('through from each pool')
      expect(row.getSource()).toHaveTextContent(
        'Aiming at an 8-player knockout across 4 pools.',
      )
    })

    // ADR 20260808: the owner is readable as TEXT on every row, never as a shade.
    it('marks all four values Automatic, in words', () => {
      drawStructureSectionPage.render()

      for (const name of [
        'Pool count',
        'Pool size',
        'Membership',
        'Qualifiers per pool',
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
        pools: [
          buildPool({ id: 'p-a', name: 'Pool A', position: 0 }),
          buildPool({ id: 'p-b', name: 'Pool B', position: 1 }),
          buildPool({ id: 'p-c', name: 'Pool C', position: 2 }),
        ],
      }),
    })

    // 32 across 3 is 11, 11, 10.
    const row = drawStructureSectionPage.setting('Pool size')
    expect(row.getValue()).toHaveTextContent('10–11')
    expect(row.queryUnit()).toHaveTextContent('players · uneven')
  })

  it('says "pool", singular, when the field runs in one', () => {
    drawStructureSectionPage.render({
      event: buildDrawStructureEvent({ pools: [buildPool()] }),
    })

    const row = drawStructureSectionPage.setting('Pool count')
    expect(row.getValue()).toHaveTextContent('1')
    expect(row.queryUnit()).toHaveTextContent('pool')
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
      // …and the whole tab is derived against it: 16 over 4 pools is 4 apiece.
      expect(
        drawStructureSectionPage.setting('Pool size').getSource(),
      ).toHaveTextContent('16 players ÷ 4 pools')
    })

    it('sends the director to Basics to change it', async () => {
      const onGoToBasics = vi.fn()
      drawStructureSectionPage.render({ onGoToBasics })

      await userEvent.click(drawStructureSectionPage.getChangeInBasicsButton())

      expect(onGoToBasics).toHaveBeenCalledTimes(1)
    })
  })

  // Chore 2c fills this. It is present so the two-column layout is the layout the
  // preview will land in, rather than one it forces a re-shuffle of.
  it('leaves the preview column empty', () => {
    drawStructureSectionPage.render()

    expect(drawStructureSectionPage.getPreviewSlot()).toBeEmptyDOMElement()
  })
})
