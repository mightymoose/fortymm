import { render, screen, within, type Container } from '@/test/utilities'

import { TimelineAxis, type TimelineAxisProps } from './timeline-axis'
import { buildTimelineAxisProps } from './timeline-axis.factory'

const scoped = (container: Container) => ({
  getAxis() {
    return container.getByTestId('timeline-axis')
  },
  /** The tick labels, left to right. */
  getTickLabels(): string[] {
    return within(container.getByTestId('timeline-axis'))
      .queryAllByText(/^\d{2}:\d{2}$/)
      .map((el) => el.textContent ?? '')
  },
  /** One tick's element, by its label — for asserting its x-position. */
  getTick(label: string) {
    return within(container.getByTestId('timeline-axis')).getByText(label)
  },

  within(node: Container = screen) {
    return scoped(node)
  },
})

/** Test page-object for `TimelineAxis` — the boards' shared time ruler. */
export const timelineAxisPage = {
  render(overrides: Partial<TimelineAxisProps> = {}) {
    render(<TimelineAxis {...buildTimelineAxisProps(overrides)} />)
  },


  ...scoped(screen),
}
