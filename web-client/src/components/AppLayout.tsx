import { useId, useState, type ReactNode } from 'react'
import { Sidebar } from './Sidebar.tsx'
import { TopBar } from './TopBar.tsx'
import './AppLayout.css'

// The layout every screen shares (the root route renders each screen in it):
// the top bar across the top, the sidebar down the left at non-phone widths,
// and the screen in the page's one <main>, filling the rest. Screens don't
// render a <main> of their own.
//
// Whether the sidebar is expanded is kept here, since its toggle is in the
// top bar. It starts expanded, and lasts while the app is open (the layout
// stays mounted from page to page); it is kept nowhere.
//
// The whole page scrolls as one document. The top bar, and the toggle in it,
// scroll away with it; the sidebar runs the page's full height, and its links
// stay in view (Sidebar.css). On phones there is no sidebar and no toggle,
// and no other way to navigate by link yet.
export function AppLayout({ children }: { children: ReactNode }) {
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const sidebarId = useId()

  return (
    <div className="app-layout">
      <TopBar
        sidebarExpanded={sidebarExpanded}
        sidebarId={sidebarId}
        onToggleSidebar={() => setSidebarExpanded(!sidebarExpanded)}
      />
      <Sidebar id={sidebarId} expanded={sidebarExpanded} />
      <main className="app-layout__content">{children}</main>
    </div>
  )
}
