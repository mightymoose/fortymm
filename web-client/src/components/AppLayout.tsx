import { Outlet } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { BottomBar } from './app-layout/BottomBar.tsx'
import { Sidebar } from './app-layout/Sidebar.tsx'
import { TopBar } from './app-layout/TopBar.tsx'
import './AppLayout.css'

// The layout the app's screens share (the _app route renders each in it; the design system boards
// and /health are outside it): the top bar across the top, the sidebar down the left at non-phone
// widths, and the screen in the page's one <main>, filling the rest. Screens inside it don't
// render a <main> of their own.
//
// Whether the sidebar is expanded is kept here, since its toggle is in the top bar. It starts
// expanded and lasts while the app is open (the layout stays mounted from page to page); it is
// kept nowhere.
//
// The whole page scrolls as one document. The top bar scrolls away with it; the sidebar runs the
// page's full height, and its links stay in view. On phones there is no sidebar and no toggle: the
// bottom bar, fixed to the bottom of the screen, is the navigation there, and the screen's end is
// kept clear of it.
export function AppLayout() {
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
      <main className="app-layout__content">
        <Outlet />
      </main>
      <BottomBar />
    </div>
  )
}
