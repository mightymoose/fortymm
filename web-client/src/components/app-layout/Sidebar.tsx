import { Link } from '@tanstack/react-router'
import { Icon } from '../../design-system/Icon.tsx'
import { CollapsedSidebarLink } from './CollapsedSidebarLink.tsx'
import { sidebarLinks } from './sidebar-links.ts'
import './Sidebar.css'

// The sidebar, at non-phone widths only (AppLayout.css's breakpoint): the app's navigation, `id`
// on its <nav>, a link with an icon and a label for each page, the current page's marked
// aria-current="page" by the router's <Link>, drawn as the tinted pill (accent-soft). Collapsed
// (not `expanded`), it shows the icons only, and each link's name is its tooltip. Its toggle is in
// the top bar, and the layout keeps whether it is expanded.
export function Sidebar({ id, expanded }: { id: string; expanded: boolean }) {
  return (
    <div className={expanded ? 'sidebar' : 'sidebar sidebar--collapsed'}>
      <nav id={id} aria-label="Main" className="sidebar__inner">
        <ul className="sidebar__links">
          {sidebarLinks.map((link) => (
            <li key={link.to}>
              {expanded ? (
                <Link to={link.to} className="sidebar__item">
                  <Icon name={link.icon} />
                  <span>{link.label}</span>
                </Link>
              ) : (
                <CollapsedSidebarLink {...link} />
              )}
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}
