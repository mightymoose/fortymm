import { ButtonLink } from './ButtonLink.tsx'
import { Icon } from './Icon.tsx'
import './DashboardScreen.css'

// The dashboard, at /: its heading with, beside it at non-phone widths, the
// "New match" button, a link to the new match screen (/matches/new). On a
// phone the bottom bar's "New match" is the way there instead, and this one
// is not displayed (AppLayout.css's breakpoint), so it is gone from the
// accessibility tree. Until what the dashboard shows is decided, nothing
// else. It renders in the layout's <main> (AppLayout).
export function DashboardScreen() {
  return (
    <div className="dashboard__head">
      <h1>Dashboard</h1>
      <ButtonLink
        to="/matches/new"
        variant="primary"
        className="dashboard__new-match"
      >
        <Icon name="plus" />
        New match
      </ButtonLink>
    </div>
  )
}
