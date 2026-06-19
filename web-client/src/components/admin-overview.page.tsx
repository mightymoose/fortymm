import { http, HttpResponse } from 'msw'
import { render, screen, type Container } from '@/test/utilities'
import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { AdminOverview } from './admin-overview'
import { buildAdminPermissions } from './admin-overview.factory'

const scoped = (container: Container) => ({
  /** The system-health dashboard — present only on the authorized branch. */
  querySystemHealth() {
    return container.queryByTestId('system-health')
  },
  /** Resolves once the authorized branch has mounted the dashboard. */
  findSystemHealth() {
    return container.findByTestId('system-health')
  },
  /** The "Administration" page heading — present only on the authorized branch. */
  queryHeading() {
    return container.queryByRole('heading', { name: 'Administration' })
  },
  /** The shared access-denied panel — present only on the unauthorized branch. */
  queryAccessDenied() {
    return container.queryByText("You don't have access to this page")
  },
  /** Resolves once the unauthorized branch has rendered the panel — lets a
   * test await the gate's decision before asserting the dashboard stayed out. */
  findAccessDenied() {
    return container.findByText("You don't have access to this page")
  },
})

/** Test page-object for `AdminOverview`, the Administration Overview gate. The
 * gate reads `/v1/session` (stubbed here per scenario) and, when authorized,
 * mounts `SystemHealth` which fetches the public `/v1/health` (left to the
 * default MSW handler). Tests start by awaiting a find-accessor since the
 * session resolves asynchronously. */
export const adminOverviewPage = {
  /** Stub the session with `permissions`, then render. Pass `[]` for a guest. */
  render(permissions: string[] = buildAdminPermissions()) {
    server.use(
      http.get('*/v1/session', () =>
        HttpResponse.json(sessionResponse({ user: { permissions } })),
      ),
    )
    render(<AdminOverview />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
