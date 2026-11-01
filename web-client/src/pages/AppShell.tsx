import { Link } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Wordmark } from '../components/Wordmark'
import { useTooltip } from '../components/tooltipContext'
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
      </nav>
      <main className="app-main">
        <div className="page">{children}</div>
      </main>
    </div>
  )
}
