import { useNavigate, useSearch } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Tabs } from '../../components/Tabs'
import { AccountsSection } from './AccountsSection'
import { PermissionsSection } from './PermissionsSection'
import { RolesSection } from './RolesSection'
import { SigningKeysSection } from './SigningKeysSection'
import { adminTabs, type AdminTab } from './tabs'
import './admin.css'

// Each tab's label and panel. A Record, so a tab id without a panel fails
// tsc instead of shifting every index after it.
const tabs: Record<AdminTab, { label: string; panel: ReactNode }> = {
  roles: { label: 'Roles', panel: <RolesSection /> },
  permissions: { label: 'Permissions', panel: <PermissionsSection /> },
  accounts: { label: 'Accounts', panel: <AccountsSection /> },
  'signing-keys': { label: 'Signing keys', panel: <SigningKeysSection /> },
}

// The admin page, for accounts with `admin.view`: roles, permissions, which
// accounts hold which roles, and every device's signing key, one tab each.
// Each tab is its own task with its own table and actions, so tabs keep each
// one's table at the top. A tab loads its lists when it opens. The URL names
// the open tab, so Back from an account's page returns to Accounts.
export function Admin() {
  const { tab = 'roles' } = useSearch({ from: '/_authenticated/_shell/admin/' })
  const navigate = useNavigate()
  return (
    <div className="admin">
      <h1>Administration</h1>
      <Tabs
        label="Admin"
        lazy
        initial={adminTabs.indexOf(tab)}
        onChange={(index) =>
          navigate({ to: '/admin', search: { tab: adminTabs[index] }, replace: true })
        }
        tabs={adminTabs.map((id) => tabs[id])}
      />
    </div>
  )
}
