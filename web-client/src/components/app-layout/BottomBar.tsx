import { Link } from '@tanstack/react-router'
import { Icon } from '../Icon.tsx'
import './BottomBar.css'

// The bottom bar, on phones only (AppLayout.css's breakpoint), where there is
// no sidebar: the app's navigation on a phone, fixed to the bottom of the
// screen. Its pages' links sit at its start, the dashboard's then the
// matches list's, each with its icon and its label; the router's <Link>
// marks the current one aria-current="page" (Matches on /matches and the
// pages under it, as the sidebar's does). At its end, apart from them, is "New match", a
// link to the new match screen (/matches/new), drawn as the bar's one primary
// action, in the accent, where a right thumb rests: on a phone it is the way
// there, as the dashboard's own button is wider. Its <nav> is named "Bottom
// bar", never "Main" like the sidebar's, and at non-phone widths it is not
// displayed, so it is gone from the accessibility tree.
export function BottomBar() {
  return (
    <nav aria-label="Bottom bar" className="bottom-bar">
      <Link to="/" className="bottom-bar__item">
        <Icon name="layout-dashboard" />
        <span>Dashboard</span>
      </Link>
      <Link to="/matches" className="bottom-bar__item">
        <Icon name="list" />
        <span>Matches</span>
      </Link>
      <Link
        to="/matches/new"
        className="bottom-bar__item bottom-bar__item--action"
      >
        <Icon name="plus" />
        <span>New match</span>
      </Link>
    </nav>
  )
}
