import { Link } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
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
// end. Below 600px, phone widths, the tab bar also links to each mobile beta.
// The page goes in `.page` (styles/page.css).
export function AppShell({ children }: { children: ReactNode }) {
  const [folded, setFolded] = useState(readFolded)
  const foldTooltip = useTooltip('Show or hide the labels')
  const homeTooltip = useTooltip('Home')

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
        {mobileApps.map((app) => (
          <MobileAppLink key={app.href} app={app} />
        ))}
      </nav>
      <main className="app-main">
        <div className="page">{children}</div>
      </main>
    </div>
  )
}

// Shown only in the tab bar below 600px, where the sidebar never folds, so
// it needs no tooltip.
function MobileAppLink({ app }: { app: (typeof mobileApps)[number] }) {
  return (
    <a
      href={app.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={app.name}
      className="app-link app-link--app"
    >
      <Icon name={app.icon} />
      <span className="app-link__label">{app.label}</span>
    </a>
  )
}
