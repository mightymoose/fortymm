import { buildTimelineBarData } from './timeline-bar.factory'
import { timelineBarPage as page } from './timeline-bar.page'

describe('TimelineBar', () => {
  it('renders an estimate as tentative on its face — dashed tier, an explicit `est` mark', () => {
    page.render({ bar: buildTimelineBarData() })
    const bar = page.getBar('fx-a-1')
    expect(page.getTier('fx-a-1')).toBe('estimate')
    expect(bar).toHaveClass('border-dashed')
    expect(bar).toHaveTextContent('09:00–09:35 · est')
    expect(bar).toHaveAccessibleName(
      'player.1 vs player.4, U1200 Singles · Pool A, T1, 09:00–09:35. Estimate — the scheduler may still move it.',
    )
  })

  it('renders a called bar as a promise — solid tier, no `est` mark, the notified sentence', () => {
    page.render({
      bar: buildTimelineBarData({
        tier: 'called',
        pinnedAt: '2026-06-13T08:50:00',
      }),
    })
    const bar = page.getBar('fx-a-1')
    expect(page.getTier('fx-a-1')).toBe('called')
    expect(bar).not.toHaveClass('border-dashed')
    expect(bar).not.toHaveTextContent('est')
    expect(bar).toHaveAccessibleName(/Called — the players were notified\.$/)
  })

  it('renders a started bar as fact, reading its actual state', () => {
    page.render({
      bar: buildTimelineBarData({
        tier: 'started',
        status: 'in_progress',
      }),
    })
    expect(page.getTier('fx-a-1')).toBe('started')
    expect(page.getBar('fx-a-1')).toHaveAccessibleName(/In progress\.$/)
  })

  it('positions and sizes itself from the window origin and the estimated duration', () => {
    page.render({
      bar: buildTimelineBarData({ startMin: 600, durationMin: 35 }),
      originMin: 540,
    })
    const bar = page.getBar('fx-a-1')
    // 60 minutes past the origin at 3 px/min; 35 estimated minutes wide (−2px gap).
    expect(bar).toHaveStyle({ left: '180px', width: '103px' })
  })

  it('titles a player-row bar with the opponent, not the whole pairing', () => {
    page.render({ title: 'vs player.4' })
    expect(page.getBar('fx-a-1')).toHaveTextContent('vs player.4')
  })

  it('opens a tooltip with the match details on keyboard focus', async () => {
    page.render({ bar: buildTimelineBarData() })
    page.focusBar('fx-a-1')

    const tip = await page.findTooltip()
    expect(tip).toHaveTextContent('player.1 vs player.4')
    expect(tip).toHaveTextContent('U1200 Singles · Pool A')
    expect(tip).toHaveTextContent('T1 · Jun 13 · 09:00–09:35')
    expect(tip).toHaveTextContent('Estimate — the scheduler may still move it')
  })

  it('says the pin state in the tooltip of a called bar', async () => {
    page.render({
      bar: buildTimelineBarData({ tier: 'called', pinnedAt: '2026-06-13T08:50:00' }),
    })
    page.focusBar('fx-a-1')
    expect(await page.findTooltip()).toHaveTextContent(
      'Called — the players were notified',
    )
  })
})
