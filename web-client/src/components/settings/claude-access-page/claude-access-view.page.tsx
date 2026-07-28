import { screen, type Container } from '@/test/utilities'
import { renderWithRoutes } from '@/test/router'
import {
  ClaudeAccessView,
  type ClaudeAccessViewProps,
} from './claude-access-view'
import { buildClaudeAccessViewProps } from './claude-access-view.factory'
import { detailAccordionPage } from './claude-access-view/detail-accordion.page'
import { permissionsSummaryPage } from './claude-access-view/permissions-summary.page'
import { setupPanelPage } from './claude-access-view/setup-panel.page'
import { statusRowPage } from './claude-access-view/status-row.page'

const scoped = (container: Container) => ({
  ...statusRowPage.within(container),
  ...permissionsSummaryPage.within(container),
  accordions: detailAccordionPage.within(container),
  // Named rather than spread: the panel's fields and the status row's both
  // speak of "fields" and "copy", and a silent shadowing between them would
  // make a green assertion mean something other than it says.
  setup: setupPanelPage.within(container),
})

/**
 * Test page-object for `ClaudeAccessView`.
 *
 * The guest status row renders a typed `<Link>`, so this goes through the
 * memory-router harness too and tests start with `await findStatus()`.
 */
export const claudeAccessViewPage = {
  render(overrides: Partial<ClaudeAccessViewProps> = {}) {
    const props = buildClaudeAccessViewProps(overrides)
    renderWithRoutes(<ClaudeAccessView {...props} />, {
      linkTargets: ['/settings'],
    })
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
