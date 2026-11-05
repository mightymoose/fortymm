import { useNavigate, useSearch } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Tabs } from '../../components/Tabs'
import { AccountsSection } from './AccountsSection'
import { PermissionsSection } from './PermissionsSection'
import { PlayersSection } from './PlayersSection'
import { RolesSection } from './RolesSection'
import { SigningKeysSection } from './SigningKeysSection'
import { adminTabs, type AdminTab } from './tabs'
import './admin.css'

const tabs: Record<AdminTab, { label: string; panel: ReactNode }> = {
  roles: { label: 'Roles', panel: <RolesSection /> },
  permissions: { label: 'Permissions', panel: <PermissionsSection /> },
  accounts: { label: 'Accounts', panel: <AccountsSection /> },
  players: { label: 'Players', panel: <PlayersSection /> },
  'signing-keys': { label: 'Signing keys', panel: <SigningKeysSection /> },
}

// The admin page, for accounts with `admin.view`: roles, permissions, which
// accounts hold which roles, every player, and every device's signing key,
// one tab each.
// Each tab is its own task with its own table and actions, so tabs keep each
// one's table at the top. A tab loads its lists when it opens. The URL names
// the open tab, so Back from an account's or a player's page returns to its
// tab.
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
