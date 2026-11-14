import { Link } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { Icon, type IconName } from './Icon.tsx'
import './Sidebar.css'

// The pages the sidebar links to, in order.
const links = [
  { to: '/health', label: 'Health', icon: 'heart-pulse' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
  { to: '/design-system', label: 'Design system', icon: 'palette' },
] as const satisfies readonly { to: string; label: string; icon: IconName }[]

// The sidebar, at non-phone widths only (AppLayout.css's breakpoint): the
// app's navigation, a link with an icon and a label for each page, the
// current page's marked aria-current="page" by the router's <Link>. Its
// toggle collapses it to icons only and expands it again; collapsed, each
// link keeps its label for assistive technology, hidden from view.
//
// It starts expanded. Collapsed or not lasts while the app is open (the
// layout stays mounted from page to page) and is kept nowhere.
export function Sidebar() {
  const [expanded, setExpanded] = useState(true)
  const navId = useId()

  return (
    <div className={expanded ? 'sidebar' : 'sidebar sidebar--collapsed'}>
      <div className="sidebar__inner">
        <button
          type="button"
          className="sidebar__item"
          aria-label="Sidebar"
          aria-expanded={expanded}
          aria-controls={navId}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name={expanded ? 'panel-left-close' : 'panel-left-open'} />
        </button>
        <nav id={navId} aria-label="Main">
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
    </div>
  )
}
