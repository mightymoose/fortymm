import { PERM } from '@/lib/permissions'
import { buildAdminPermissions } from './admin-overview.factory'
import { adminOverviewPage } from './admin-overview.page'

describe('AdminOverview', () => {
  it('renders the system-health dashboard for a user with administration.view', async () => {
    adminOverviewPage.render(buildAdminPermissions())

    // Wiring only: the dashboard's contents are pinned by the SystemHealth tests.
    expect(await adminOverviewPage.findSystemHealth()).toBeInTheDocument()
    expect(adminOverviewPage.queryHeading()).toBeInTheDocument()
    expect(adminOverviewPage.queryAccessDenied()).not.toBeInTheDocument()
  })

  it('shows the access-denied panel to a guest, never mounting the dashboard', async () => {
    adminOverviewPage.render([])

    expect(await adminOverviewPage.findAccessDenied()).toBeInTheDocument()
    // The internal service hostnames live in SystemHealth — keep it unmounted.
    expect(adminOverviewPage.querySystemHealth()).not.toBeInTheDocument()
    expect(adminOverviewPage.queryHeading()).not.toBeInTheDocument()
  })

  it('gates specifically on administration.view, not any admin permission', async () => {
    adminOverviewPage.render([PERM.AUTH_MANAGE])

    expect(await adminOverviewPage.findAccessDenied()).toBeInTheDocument()
    expect(adminOverviewPage.querySystemHealth()).not.toBeInTheDocument()
  })
})
