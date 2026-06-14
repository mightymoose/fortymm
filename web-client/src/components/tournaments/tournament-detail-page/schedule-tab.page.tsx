import { render, screen, type Container } from '@/test/utilities'

import { ScheduleTab, type ScheduleTabProps } from './schedule-tab'
import { buildScheduleTabProps } from './schedule-tab.factory'

const scoped = (container: Container) => ({
  queryText(text: string) {
    return container.queryByText(text)
  },
})

/** Test page-object for `ScheduleTab`. */
export const scheduleTabPage = {
  render(overrides: Partial<ScheduleTabProps> = {}) {
    render(<ScheduleTab {...buildScheduleTabProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
