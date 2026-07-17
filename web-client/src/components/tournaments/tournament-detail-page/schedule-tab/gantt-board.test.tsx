import { interactiveElementsIn } from '@/test/read-only'

import {
  buildScheduleBoard,
  buildTimelineTableRow,
} from './gantt-board.factory'
import { ganttBoardPage as page } from './gantt-board.page'
import { buildTimelineBarData } from './timeline-bar.factory'

describe('GanttBoard', () => {
  it('gives every tournament table a row — the empty one included — with its bars in place', () => {
    page.render()
    expect(page.barIdsIn('t1')).toEqual(['fx-a-1', 'fx-a-3'])
    expect(page.barIdsIn('t2')).toEqual(['fx-a-2'])
    // T3 has nothing scheduled: a row of empty track, not a missing row.
    expect(page.barIdsIn('t3')).toEqual([])
    expect(page.getRow('t3')).toHaveTextContent('T3')
  })

  it('renders the three tiers distinguishably', () => {
    page.render()
    expect(page.getTier('fx-a-1')).toBe('estimate')
    expect(page.getTier('fx-a-2')).toBe('called')
    expect(page.getTier('fx-a-3')).toBe('started')
    // Wiring only: the tier grammar itself (classes, est mark, sentences) is
    // pinned by the timeline-bar tests.
  })

  it('flags a row for a table the catalogue no longer lists, and still draws its bar', () => {
    page.render({
      board: buildScheduleBoard({
        tables: [
          buildTimelineTableRow({
            tableId: 't-gone',
            label: 't-gone',
            known: false,
            bars: [buildTimelineBarData({ fixtureId: 'fx-ghost', tableId: 't-gone' })],
          }),
        ],
      }),
    })
    expect(page.getRow('t-gone')).toHaveTextContent('Removed from the catalogue')
    expect(page.barIdsIn('t-gone')).toEqual(['fx-ghost'])
  })

  it('lists the fixtures it cannot draw in the side rail', () => {
    page.render()
    expect(page.getItem('fx-b-1')).toHaveTextContent('player.2 vs player.3')
  })

  it('scrolls inside a labelled, keyboard-focusable region — never the page', () => {
    page.render()
    const region = page.getScrollRegion()
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region).toHaveClass('overflow-x-auto')
  })

  it('shows a bar’s details in a tooltip on keyboard focus', async () => {
    page.render()
    page.focusBar('fx-a-2')
    const tip = await page.findTooltip()
    expect(tip).toHaveTextContent('player.1 vs player.5')
    expect(tip).toHaveTextContent('Called — the players were notified')
  })

  it('offers no mutating control — every interactive element is a bar or the scroll region', () => {
    page.render()
    const others = interactiveElementsIn(page.getBoard()).filter(
      (el) =>
        !(el.getAttribute('data-testid') ?? '').startsWith('timeline-bar-') &&
        el.getAttribute('role') !== 'region',
    )
    expect(others).toHaveLength(0)
  })
})
