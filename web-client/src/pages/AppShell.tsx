import { useQuery } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { can, Permission } from '../api/permissions'
import { sessionQuery } from '../api/queries'
import { Button } from '../components/Button'
import { Icon, type IconName } from '../components/Icon'
import { Wordmark } from '../components/Wordmark'
import { useTooltip } from '../components/tooltipContext'
import { useNarrowLayout } from './useNarrowLayout'
import { UserMenu } from './userMenu/UserMenu'

const FOLDED_KEY = 'fortymm.sidebar.folded'

function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLDED_KEY) === 'true'
  } catch {
    return false
  }
}

function saveFolded(folded: boolean) {
  try {
    localStorage.setItem(FOLDED_KEY, String(folded))
  } catch {
    // Storage can be off, e.g. in a private window. Folding still works.
  }
}

// The frame of the authenticated pages, styled by `.app-shell` in
// styles/base.css: a topbar across the top over a sidebar of the pages. The
// sidebar folds to its icons and remembers it. Below 900px it becomes a tab
// bar along the bottom. The visitor's account menu sits at the topbar's right
// end. Its menu holds the links to the admin page and the mobile betas.
// Matches and Players show to an account that may see them. In the tab bar,
// New match joins them, and Home shows it no more. The links wait for the
// session without suspending, like the account menu.
// The page goes in `.page` (styles/page.css).
export function AppShell({ children }: { children: ReactNode }) {
  const [folded, setFolded] = useState(readFolded)
  const foldTooltip = useTooltip('Show or hide the labels')
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useQuery(sessionQuery(api))
  const narrow = useNarrowLayout()

  function toggle() {
    saveFolded(!folded)
    setFolded(!folded)
  }

  return (
    <div className="app-shell" data-folded={folded}>
      <header className="app-top">
        <span className="app-wide-only">
          <Button
            variant="ghost"
            icon
            aria-label="Sidebar labels"
            aria-expanded={!folded}
            aria-controls="app-nav"
            onClick={toggle}
            {...foldTooltip}
          >
            <Icon name="menu" />
          </Button>
        </span>
        <Wordmark />
        <UserMenu />
      </header>
      <nav className="app-nav" id="app-nav" aria-label="Main">
        <NavLink to="/" icon="house" label="Home" folded={folded} />
        {account && can(account, Permission.matchesView) && (
          <NavLink to="/matches" icon="table" label="Matches" folded={folded} />
        )}
        {account && can(account, Permission.playersView) && (
          <NavLink to="/players" icon="user" label="Players" folded={folded} />
        )}
        {narrow && account && can(account, Permission.matchesCreate) && (
          <NavLink to="/matches/new" icon="plus" label="New match" folded={folded} />
        )}
      </nav>
      <main className="app-main">
        <div className="page">{children}</div>
      </main>
    </div>
  )
}

// A link of the sidebar, open only on its own page, so Matches isn't open on
// New match. Folded, its label shows as a tooltip.
function NavLink({
  to,
  icon,
  label,
  folded,
}: {
  to: '/' | '/matches' | '/players' | '/matches/new'
  icon: IconName
  label: string
  folded: boolean
}) {
  const tooltip = useTooltip(label)
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className="app-link"
      {...(folded ? tooltip : {})}
    >
      <Icon name={icon} />
      <span className="app-link__label">{label}</span>
    </Link>
  )
}
