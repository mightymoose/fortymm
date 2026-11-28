import { Link } from '@tanstack/react-router'
import { Icon } from '../../design-system/Icon.tsx'
import { DeviceAvatar } from './DeviceAvatar.tsx'
import './TopBar.css'

// The top bar across every screen. At non-phone widths: the sidebar's toggle, then the FortyMM
// wordmark, a link to the dashboard (/), on the left. On phones (AppLayout.css's breakpoint) there
// is no sidebar, so no toggle, and the wordmark is centred. The wordmark is the brand, not the
// page's heading: each screen has its own <h1>. At the far end, at every width, the device's
// avatar (DeviceAvatar), once it knows who it is.
//
// The toggle collapses the sidebar (`sidebarId`, its <nav>) to icons only and expands it again;
// the layout keeps whether it is expanded.
export function TopBar({
  sidebarExpanded,
  sidebarId,
  onToggleSidebar,
}: {
  sidebarExpanded: boolean
  sidebarId: string
  onToggleSidebar: () => void
}) {
  return (
    <header className="top-bar">
      <button
        type="button"
        className="top-bar__toggle"
        aria-label="Sidebar"
        aria-expanded={sidebarExpanded}
        aria-controls={sidebarId}
        onClick={onToggleSidebar}
      >
        <Icon name={sidebarExpanded ? 'panel-left-close' : 'panel-left-open'} />
      </button>
      <Link to="/" activeOptions={{ exact: true }} className="top-bar__brand">
        FortyMM
      </Link>
      <DeviceAvatar />
    </header>
  )
}
