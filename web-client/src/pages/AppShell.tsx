import { useQuery } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { can, Permission } from '../api/permissions'
import { sessionQuery } from '../api/queries'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Wordmark } from '../components/Wordmark'
import { useTooltip } from '../components/tooltipContext'
import { mobileApps } from '../mobileApps'
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
// end. An account with `admin.view` gets a link to the admin page. The
// sidebar's footer links to each mobile beta.
// The page goes in `.page` (styles/page.css).
export function AppShell({ children }: { children: ReactNode }) {
  const [folded, setFolded] = useState(readFolded)
  const foldTooltip = useTooltip('Show or hide the labels')
  const homeTooltip = useTooltip('Home')
  const adminTooltip = useTooltip('Admin')
  const { api } = useRouteContext({ from: '__root__' })
  // The `_authenticated` loader has loaded the session. Reading it without
  // suspending keeps the frame up while an admin write fetches it again.
  const { data: account } = useQuery(sessionQuery(api))
  const admin = account !== undefined && can(account, Permission.adminView)

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
        <Link
          to="/"
          activeOptions={{ exact: true }}
          className="app-link"
          {...(folded ? homeTooltip : {})}
        >
          <Icon name="house" />
          <span className="app-link__label">Home</span>
        </Link>
        {admin && (
          <Link to="/admin" className="app-link" {...(folded ? adminTooltip : {})}>
            <Icon name="user" />
            <span className="app-link__label">Admin</span>
          </Link>
        )}
        {mobileApps.map((app) => (
          <MobileAppLink key={app.href} app={app} folded={folded} />
        ))}
      </nav>
      <main className="app-main">
        <div className="page">{children}</div>
      </main>
    </div>
  )
}

function MobileAppLink({
  app,
  folded,
}: {
  app: (typeof mobileApps)[number]
  folded: boolean
}) {
  const tooltip = useTooltip(app.name)
  return (
    <a
      href={app.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={app.name}
      className="app-link app-link--app"
      {...(folded ? tooltip : {})}
    >
      <Icon name={app.icon} />
      <span className="app-link__label">{app.label}</span>
    </a>
  )
}
