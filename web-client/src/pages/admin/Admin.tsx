import { useNavigate, useSearch } from '@tanstack/react-router'
import { Tabs } from '../../components/Tabs'
import { AccountsSection } from './AccountsSection'
import { PermissionsSection } from './PermissionsSection'
import { RolesSection } from './RolesSection'
import { adminTabs } from './tabs'
import './admin.css'

// The admin page, for accounts with `admin.view`: roles, permissions and
// which accounts hold which roles, one tab each. Each tab is its own task
// with its own table and actions, so tabs keep each one's table at the top.
// A tab loads its lists when it opens. The URL names the open tab, so Back
// from an account's page returns to Accounts.
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
        tabs={[
          { label: 'Roles', panel: <RolesSection /> },
          { label: 'Permissions', panel: <PermissionsSection /> },
          { label: 'Accounts', panel: <AccountsSection /> },
        ]}
      />
    </div>
  )
}
