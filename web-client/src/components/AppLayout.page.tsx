import { screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { renderScreen } from '../test/render-screen.tsx'
import { AppLayout } from './AppLayout.tsx'
import { Sidebar } from './Sidebar.tsx'
import { TopBar } from './TopBar.tsx'

// The layout every screen shares (AppLayout.tsx) and its parts, the top bar
// (TopBar.tsx) and the sidebar (Sidebar.tsx): how to render each alone, and
// what a person sees on them. The finders work wherever the layout is
// mounted, through the root route (src/routes/__root.test.tsx) too.
export class AppLayoutPage {
  // The layout around `children`, at `path` (`/` unless given).
  render(children: ReactNode, options?: { path?: string }) {
    return renderScreen(<AppLayout>{children}</AppLayout>, options)
  }

  renderTopBar() {
    return renderScreen(<TopBar />)
  }

  // The sidebar, with `path` the current page (`/` unless given).
  renderSidebar(options?: { path?: string }) {
    return renderScreen(<Sidebar />, options)
  }

  // The top bar.
  banner() {
    return screen.findByRole('banner')
  }

  // The FortyMM brand in the top bar, a link to the start page.
  async brand() {
    return within(await this.banner()).findByRole('link', { name: 'FortyMM' })
  }

  // The sidebar's navigation.
  navigation() {
    return screen.findByRole('navigation', { name: 'Main' })
  }

  // The links in the sidebar's navigation, in order.
  async links() {
    return within(await this.navigation()).findAllByRole('link')
  }

  // A link in the sidebar's navigation, by its name ("Health").
  async link(name: string) {
    return within(await this.navigation()).findByRole('link', { name })
  }

  // The button that collapses and expands the sidebar.
  sidebarToggle() {
    return screen.findByRole('button', { name: 'Sidebar' })
  }

  // Where the screen goes: the page's one <main>.
  main() {
    return screen.findByRole('main')
  }
}
