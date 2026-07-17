import { timelineAxisPage as page } from './timeline-axis.page'

describe('TimelineAxis', () => {
  it('labels the window in wall-clock half hours', () => {
    page.render() // 09:00–10:30
    expect(page.getTickLabels()).toEqual(['09:00', '09:30', '10:00', '10:30'])
  })

  it('positions ticks on the shared px-per-minute scale', () => {
    page.render()
    // 09:30 is 30 minutes past the window start, at 3 px/min.
    expect(page.getTick('09:30')).toHaveStyle({ left: '90px' })
    expect(page.getAxis()).toHaveStyle({ width: '270px' })
  })

  it('is decoration to a screen reader — the bars say their own times', () => {
    page.render()
    expect(page.getAxis()).toHaveAttribute('aria-hidden', 'true')
  })
})
