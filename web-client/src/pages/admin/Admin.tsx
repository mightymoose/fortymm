import { Tabs } from '../../components/Tabs'
import { AccountsSection } from './AccountsSection'
import { PermissionsSection } from './PermissionsSection'
import { RolesSection } from './RolesSection'
import './admin.css'

// The admin page, for accounts with `admin.view`: roles, permissions and
// which accounts hold which roles, one tab each. Each tab is its own task
// with its own table and actions, so tabs keep each one's table at the top.
// A tab loads its lists when it opens.
export function Admin() {
  return (
    <div className="admin">
      <h1>Admin</h1>
      <Tabs
        label="Admin"
        lazy
        tabs={[
          { label: 'Roles', panel: <RolesSection /> },
          { label: 'Permissions', panel: <PermissionsSection /> },
          { label: 'Accounts', panel: <AccountsSection /> },
        ]}
      />
    </div>
  )
}
