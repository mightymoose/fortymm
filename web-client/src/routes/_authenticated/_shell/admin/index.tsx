import { createFileRoute } from '@tanstack/react-router'
import { Admin } from '../../../../pages/admin/Admin'
import { parseAdminTab, type AdminTab } from '../../../../pages/admin/tabs'

export const Route = createFileRoute('/_authenticated/_shell/admin/')({
  // The open tab, so a link back from an account page opens Accounts.
  validateSearch: (search: Record<string, unknown>): { tab?: AdminTab } => {
    const tab = parseAdminTab(search.tab)
    return tab ? { tab } : {}
  },
  component: Admin,
})
