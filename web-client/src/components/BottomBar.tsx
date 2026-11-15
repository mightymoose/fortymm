import { Link } from '@tanstack/react-router'
import { Icon } from './Icon.tsx'
import './BottomBar.css'

// The bottom bar, on phones only (AppLayout.css's breakpoint), where there is
// no sidebar: the app's navigation on a phone, fixed to the bottom of the
// screen. Today it holds one link, to the dashboard, with its icon and its
// label; the router's <Link> marks it aria-current="page" there. Its <nav>
// is named "Bottom bar", never "Main" like the sidebar's, and at non-phone
// widths it is not displayed, so it is gone from the accessibility tree.
export function BottomBar() {
  return (
    <nav aria-label="Bottom bar" className="bottom-bar">
      <Link to="/" className="bottom-bar__item">
        <Icon name="layout-dashboard" />
        <span>Dashboard</span>
      </Link>
    </nav>
  )
}
