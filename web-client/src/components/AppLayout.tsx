import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar.tsx'
import { TopBar } from './TopBar.tsx'
import './AppLayout.css'

// The layout every screen shares (the root route renders each screen in it):
// the top bar across the top, the sidebar down the left at non-phone widths,
// and the screen in the page's one <main>, filling the rest. Screens don't
// render a <main> of their own.
//
// The whole page scrolls as one document. The top bar scrolls away with it;
// the sidebar runs the page's full height, and its toggle and links stay in
// view (Sidebar.css). On phones there is no sidebar, and no other way to
// navigate by link yet.
export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app-layout">
      <TopBar />
      <Sidebar />
      <main className="app-layout__content">{children}</main>
    </div>
  )
}
