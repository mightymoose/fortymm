import { buildScheduleBoard, buildTimelinePlayerRow } from './gantt-board.factory'
import { playerTimelineBoardPage as page } from './player-timeline-board.page'
import { buildTimelinePlayerBarData } from './timeline-bar.factory'

describe('PlayerTimelineBoard', () => {
  it('rows each entrant with their bars over time, titled by opponent', () => {
    page.render()
    expect(page.rowNames()).toEqual(['player.1', 'player.4'])
    expect(page.barIdsIn('u-1')).toEqual(['fx-a-1', 'fx-a-2'])
    expect(page.barsIn('u-1').getBar('fx-a-1')).toHaveTextContent('vs player.4')
    // The same fixture from the other side of the net.
    expect(page.barsIn('u-4').getBar('fx-a-1')).toHaveTextContent('vs player.1')
  })

  it('keeps the three tiers distinguishable on a player’s own row', () => {
    page.render()
    const bars = page.barsIn('u-1')
    expect(bars.getTier('fx-a-1')).toBe('estimate')
    expect(bars.getTier('fx-a-2')).toBe('called')
    // Wiring only: the tier grammar is pinned by the timeline-bar tests.
  })

  it('gives a player whose fixtures are all unplaced an honest empty track', () => {
    page.render({
      board: buildScheduleBoard({
        players: [
          buildTimelinePlayerRow({
            userId: 'u-2',
            username: 'player.2',
            bars: [],
          }),
        ],
      }),
    })
    expect(page.getRow('u-2')).toHaveTextContent('player.2')
    expect(page.barIdsIn('u-2')).toEqual([])
  })

  it('scrolls inside a labelled, keyboard-focusable region — never the page', () => {
    page.render()
    const region = page.getScrollRegion()
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region).toHaveClass('overflow-x-auto')
  })

  it('shows a bar’s details in a tooltip on keyboard focus', async () => {
    page.render({
      board: buildScheduleBoard({
        players: [
          buildTimelinePlayerRow({
            bars: [buildTimelinePlayerBarData({ opponent: 'player.4' })],
          }),
        ],
      }),
    })
    page.barsIn('u-1').focusBar('fx-a-1')
    const tip = await page.findTooltip()
    expect(tip).toHaveTextContent('player.1 vs player.4')
    expect(tip).toHaveTextContent('T1 · Jun 13 · 09:00–09:35')
  })
})
