import { Link, useMatchRoute } from '@tanstack/react-router'
import { Icon } from '../../design-system/Icon.tsx'
import './BottomBar.css'

// The bottom bar, on phones only (AppLayout.css's breakpoint), where there is no sidebar: the
// app's navigation on a phone, fixed to the bottom of the screen. Its four items share its width
// equally: the dashboard's, the matches list's and the user list's links, each with its icon and
// its label, the router's <Link> marking the current one aria-current="page"; then "New match", a
// link to /matches/new drawn as the bar's one primary action, where a right thumb rests. On its own
// page it is the current page, the tinted pill like the others, and Matches is not current there,
// though the page is under /matches. Its <nav> is named "Bottom bar", never "Main" like the
// sidebar's, and at non-phone widths it is not displayed, so it is gone from the accessibility tree.
export function BottomBar() {
  const onNewMatch = useMatchRoute()({ to: '/matches/new' }) !== false
  return (
    <nav aria-label="Bottom bar" className="bottom-bar">
      <Link to="/" className="bottom-bar__item">
        <Icon name="layout-dashboard" />
        <span>Dashboard</span>
      </Link>
      <Link to="/matches" activeOptions={{ exact: onNewMatch }} className="bottom-bar__item">
        <Icon name="list" />
        <span>Matches</span>
      </Link>
      <Link to="/users" className="bottom-bar__item">
        <Icon name="users" />
        <span>Users</span>
      </Link>
      <Link to="/matches/new" className="bottom-bar__item bottom-bar__item--action">
        <Icon name="plus" />
        <span>New match</span>
      </Link>
    </nav>
  )
}
