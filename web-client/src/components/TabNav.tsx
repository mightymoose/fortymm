import { Link, type LinkProps } from '@tanstack/react-router'
import './Tabs.css'

export type TabLink = {
  // Where the tab goes: a path of the app.
  to: LinkProps['to']
  label: string
}

// Tabs that are navigation: each tab is a link to a page of its own, so the
// selected one is the page you are on. They look like Tabs (the design
// system's .fm-tabs, Tabs.css), but they are not a tablist: a <nav> named by
// `label`, one router <Link> per page, each in the tab order, and the
// router marks the current page's aria-current="page", which draws it
// selected. A link opens in a new tab, goes in the history and can be
// bookmarked; Tabs' buttons switch panels on one page and move with the
// arrow keys.
export function TabNav({
  label,
  links,
  'data-testid': testId,
}: {
  label: string
  links: TabLink[]
  'data-testid'?: string
}) {
  return (
    <nav aria-label={label} data-testid={testId}>
      <div className="tabs">
        {links.map((link) => (
          <Link key={link.label} to={link.to} className="tabs__tab">
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
