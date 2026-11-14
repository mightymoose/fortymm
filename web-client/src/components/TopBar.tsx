import { Link } from '@tanstack/react-router'
import './TopBar.css'

// The top bar across every screen: the FortyMM wordmark, a link to the start
// page. On the left at non-phone widths, centred on phones (the breakpoint is
// AppLayout.css's). The wordmark is the brand, not the page's heading: each
// screen has its own <h1>.
export function TopBar() {
  return (
    <header className="top-bar">
      <Link
        to="/"
        activeOptions={{ exact: true }}
        className="top-bar__brand scoreboard-display"
      >
        FortyMM
      </Link>
    </header>
  )
}
