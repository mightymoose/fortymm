import { Link } from '@tanstack/react-router'
import { Icon, type IconName } from './Icon.tsx'
import './Sidebar.css'

// The pages the sidebar links to, in order.
const links = [
  { to: '/health', label: 'Health', icon: 'heart-pulse' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
  { to: '/design-system', label: 'Design system', icon: 'palette' },
] as const satisfies readonly { to: string; label: string; icon: IconName }[]

// The sidebar, at non-phone widths only (AppLayout.css's breakpoint): the
// app's navigation, `id` on its <nav>, a link with an icon and a label for
// each page, the current page's marked aria-current="page" by the router's
// <Link>. Collapsed (not `expanded`), it shows the icons only; each link
// keeps its label for assistive technology, hidden from view. Its toggle is
// in the top bar, and the layout keeps whether it is expanded.
export function Sidebar({ id, expanded }: { id: string; expanded: boolean }) {
  return (
    <div className={expanded ? 'sidebar' : 'sidebar sidebar--collapsed'}>
      <nav id={id} aria-label="Main" className="sidebar__inner">
        <ul className="sidebar__links">
          {links.map(({ to, label, icon }) => (
            <li key={to}>
              <Link to={to} className="sidebar__item">
                <Icon name={icon} />
                <span className={expanded ? undefined : 'visually-hidden'}>
                  {label}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}
