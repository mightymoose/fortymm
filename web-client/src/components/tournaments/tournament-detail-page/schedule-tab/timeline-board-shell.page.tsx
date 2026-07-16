import { render, screen, type Container } from '@/test/utilities'

import {
  TimelineBoardShell,
  type TimelineBoardShellProps,
} from './timeline-board-shell'

const scoped = (container: Container) => ({
  getRegion(label: string) {
    return container.getByRole('region', { name: label })
  },
  getRow(testId: string) {
    return container.getByTestId(testId)
  },
  queryRow(testId: string) {
    return container.queryByTestId(testId)
  },

  within(node: Container = screen) {
    return scoped(node)
  },
})

/** Test page-object for `TimelineBoardShell` — the boards' shared scroll region,
 * header/axis row and sticky-label tracks. */
export const timelineBoardShellPage = {
  render(props: TimelineBoardShellProps) {
    render(<TimelineBoardShell {...props} />)
  },

  ...scoped(screen),
}
