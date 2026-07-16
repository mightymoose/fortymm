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

  it('renders a called bar as a promise — solid tier, no `est` mark, the notified sentence and the called-at marker', () => {
    page.render({
      bar: buildTimelineBarData({
        tier: 'called',
        pinnedAt: '2026-06-13T08:50:00',
        callNotifiedCount: 1,
      }),
    })
    const bar = page.getBar('fx-a-1')
    expect(page.getTier('fx-a-1')).toBe('called')
    expect(bar).not.toHaveClass('border-dashed')
    expect(bar).not.toHaveTextContent('est')
    // The called-at marker rides the accessible name too, so what the promise
    // cost never depends on the tooltip opening. One notification is the
    // ordinary call — no `notified n×` counter yet.
    expect(bar).toHaveAccessibleName(
      /Called — the players were notified\. Called 08:50\.$/,
    )
  })

  it('renders a SILENT pin as pinned, not called — no notified claim, no call time', async () => {
    // Pinned is not told (the server pins EVERY full manual placement; live only
    // gates the notify): a pre-live director placement is pinned with a count of
    // 0, and the words must not invent a call that never went out.
    page.render({
      bar: buildTimelineBarData({
        tier: 'called',
        pinnedAt: '2026-06-13T08:50:00',
        callNotifiedCount: 0,
      }),
    })
    const bar = page.getBar('fx-a-1')
    // Same visual tier as a call — the solver treats both as immovable…
    expect(page.getTier('fx-a-1')).toBe('called')
    // …but the words say pinned, and never "notified" or a called-at minute.
    expect(bar).toHaveAccessibleName(/Pinned — placed by the director\.$/)
    expect(bar).not.toHaveAccessibleName(/notified/)
    page.focusBar('fx-a-1')
    const tip = await page.findTooltip()
    expect(tip).toHaveTextContent('Pinned — placed by the director')
    expect(tip).not.toHaveTextContent('Called')
    expect(tip).not.toHaveTextContent('notified')
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

  it('says the pin state in the tooltip of a called bar — with the called-at time, not just the sentence', async () => {
    page.render({
      bar: buildTimelineBarData({
        tier: 'called',
        pinnedAt: '2026-06-13T08:50:00',
        callNotifiedCount: 1,
      }),
    })
    page.focusBar('fx-a-1')
    const tip = await page.findTooltip()
    expect(tip).toHaveTextContent('Called — the players were notified')
    expect(tip).toHaveTextContent('Called 08:50')
    // One call, no corrections: the counter stays off the marker.
    expect(tip).not.toHaveTextContent('notified 1×')
  })

  it('counts the notifications on a re-called bar — `notified 2×` is the cost of the correction, made visible', async () => {
    page.render({
      bar: buildTimelineBarData({
        tier: 'called',
        pinnedAt: '2026-06-13T08:50:00',
        callNotifiedCount: 2,
      }),
    })
    page.focusBar('fx-a-1')
    expect(await page.findTooltip()).toHaveTextContent(
      'Called 08:50 · notified 2×',
    )
    expect(page.getBar('fx-a-1')).toHaveAccessibleName(
      /Called 08:50 · notified 2×\.$/,
    )
  })

  it('shows no called-at marker on an estimate — nothing was promised', async () => {
    page.render({ bar: buildTimelineBarData() })
    page.focusBar('fx-a-1')
    const tip = await page.findTooltip()
    expect(tip).not.toHaveTextContent('Called')
    expect(tip).not.toHaveTextContent('notified')
  })
})
