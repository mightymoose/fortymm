import { createFileRoute } from '@tanstack/react-router'
import { Admin } from '../../../../pages/admin/Admin'
import { parseAdminTab, type AdminTab } from '../../../../pages/admin/tabs'

export const Route = createFileRoute('/_authenticated/_shell/admin/')({
  // The open tab, so a link back from an account page opens Accounts. The
  // router lays this over the raw query, so an unknown tab must come back
  // as undefined, not be left out.
  validateSearch: (search: Record<string, unknown>): { tab?: AdminTab } => ({
    tab: parseAdminTab(search.tab),
  }),
  component: Admin,
})
