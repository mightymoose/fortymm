import { render, screen, within, type Container } from '@/test/utilities'
import {
  PermissionsSummary,
  type PermissionsSummaryProps,
} from './permissions-summary'
import { buildPermissionsSummaryProps } from './permissions-summary.factory'

const scoped = (container: Container) => ({
  /** The summary region. Absent on the connected page, where the grant has
   * already been made. */
  querySummary() {
    return container.queryByRole('region', { name: "What you're granting" })
  },
  /**
   * Every bullet, in render order — scoped to the summary region, because the
   * page that embeds this also renders accordion lists whose `<li>`s a bare
   * `getAllByRole('listitem')` would sweep up (a closed `<details>` hides its
   * content by UA stylesheet, which jsdom does not implement).
   */
  getBullets() {
    const region = container.getByRole('region', {
      name: "What you're granting",
    })
    return within(region).getAllByRole('listitem')
  },
})

/** Test page-object for `PermissionsSummary` — a static consent block, so
 * assertions are about the exact words. */
export const permissionsSummaryPage = {
  render(overrides: Partial<PermissionsSummaryProps> = {}) {
    const props = buildPermissionsSummaryProps(overrides)
    render(<PermissionsSummary {...props} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
