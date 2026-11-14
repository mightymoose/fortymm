import type { ReactNode } from 'react'
import { TabNav, type TabLink } from './TabNav.tsx'
import './DesignSystemLayout.css'

// The design system page's tabs, one per board of the design system's
// reference sheet (references/design-system/), in the sheet's order, each a
// page of its own. The sheet's Match, scoring and schedule board has none.
const designSystemTabs: TabLink[] = [
  { to: '/design-system/colour', label: 'Colour' },
  { to: '/design-system/type', label: 'Type' },
  { to: '/design-system/foundations', label: 'Foundations' },
  { to: '/design-system/controls', label: 'Controls' },
  { to: '/design-system/feedback', label: 'Feedback' },
]

// The design system page, at /design-system/<tab>: where each component of
// the FortyMM design system is shown as the app builds it, to check against
// the design system's reference sheet. Its header has the wordmark, in Bebas
// Neue, and the page's title, in Space Grotesk; under it, the tabs; then the
// current tab (`children`, the router's outlet). It renders in the app
// layout's <main> (AppLayout), so its <header> is the page's own, not a
// banner, and it has no <main> of its own.
export function DesignSystemLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header>
        <span
          role="img"
          aria-label="FortyMM"
          className="wordmark scoreboard-display"
        >
          FortyMM
        </span>
        <h1>Design system</h1>
        <p>
          Each component of the FortyMM design system, as this app builds it,
          to check against the design system.
        </p>
      </header>
      <div className="design-system__tabs">
        <TabNav
          label="Design system"
          links={designSystemTabs}
          data-testid="design-system-tabs"
        />
      </div>
      {children}
    </>
  )
}
