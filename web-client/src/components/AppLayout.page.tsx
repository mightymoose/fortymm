import { screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { renderScreen } from '../test/render-screen.tsx'
import { AppLayout } from './AppLayout.tsx'
import { BottomBar } from './BottomBar.tsx'
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

  // The top bar, its toggle saying whether the sidebar (`sidebarId`) is
  // expanded, and calling `onToggleSidebar` when pressed, at `path` (`/`
  // unless given).
  renderTopBar(
    props: Parameters<typeof TopBar>[0],
    options?: { path?: string },
  ) {
    return renderScreen(<TopBar {...props} />, options)
  }

  // The sidebar, expanded unless given, with `path` the current page (`/`
  // unless given).
  renderSidebar(options?: { path?: string; expanded?: boolean }) {
    return renderScreen(
      <Sidebar id="sidebar" expanded={options?.expanded ?? true} />,
      options,
    )
  }

  // The bottom bar, at `path` (`/` unless given).
  renderBottomBar(options?: { path?: string }) {
    return renderScreen(<BottomBar />, options)
  }

  // The bottom bar's navigation (phones only in a browser; jsdom applies no
  // breakpoint, so both navs are there).
  bottomBar() {
    return screen.findByRole('navigation', { name: 'Bottom bar' })
  }

  // The links in the bottom bar, in order.
  async bottomBarLinks() {
    return within(await this.bottomBar()).findAllByRole('link')
  }

  // The top bar.
  banner() {
    return screen.findByRole('banner')
  }

  // The FortyMM brand in the top bar, a link to the dashboard, at /.
  async brand() {
    return within(await this.banner()).findByRole('link', { name: 'FortyMM' })
  }

  // This device's user's mark in the top bar, a link named with the
  // username (`agile-meerkat-4b8z`).
  async userMark(username: string) {
    return within(await this.banner()).findByRole('link', { name: username })
  }

  // Every link in the top bar, in order: the brand, then the user's mark
  // when there is one.
  async bannerLinks() {
    return within(await this.banner()).queryAllByRole('link')
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

  // The button that collapses and expands the sidebar, in the top bar. Found
  // in the whole page, not within banner(): jsdom takes a screen's own
  // <header> inside <main> for a second banner (the design system page's),
  // where a browser doesn't.
  sidebarToggle() {
    return screen.findByRole('button', { name: 'Sidebar' })
  }

  // The notice that a new version of the app is ready, over the screen.
  newVersionNotice() {
    return screen.findByText('A new version is ready.')
  }

  // Its Reload button.
  reload() {
    return screen.findByRole('button', { name: 'Reload' })
  }

  // Where the screen goes: the page's one <main>.
  main() {
    return screen.findByRole('main')
  }
}
