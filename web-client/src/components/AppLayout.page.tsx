import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { BottomBar } from './app-layout/BottomBar.tsx'
import { Sidebar } from './app-layout/Sidebar.tsx'
import { TopBar } from './app-layout/TopBar.tsx'
import { createTestQueryClient } from '../testQueryClient.ts'

// Page object for the layout the app's screens share (AppLayout.tsx) and its parts: the top bar,
// the sidebar and the bottom bar. The static render* methods mount one part alone, in a bare
// router at `path` (`/` unless given) so its <Link>s can mark the current page, and with a fresh
// query client for the top bar's avatar; test where links go through the whole app. The finders
// work wherever the layout is mounted, the whole app too (App.page.tsx). jsdom applies no breakpoint, so the sidebar and the bottom bar are both there.
export class AppLayoutPage {
  static renderTopBar(props: Parameters<typeof TopBar>[0], options?: { path?: string }) {
    return AppLayoutPage.renderAt(<TopBar {...props} />, options?.path)
  }

  // The sidebar, expanded unless `expanded` is false.
  static renderSidebar(options?: { path?: string; expanded?: boolean }) {
    return AppLayoutPage.renderAt(
      <Sidebar id="sidebar" expanded={options?.expanded ?? true} />,
      options?.path,
    )
  }

  static renderBottomBar(options?: { path?: string }) {
    return AppLayoutPage.renderAt(<BottomBar />, options?.path)
  }

  private static async renderAt(part: ReactNode, path = '/') {
    const router = createRouter({
      routeTree: createRootRoute({ component: () => part, notFoundComponent: () => null }),
      history: createMemoryHistory({ initialEntries: [path] }),
    })
    await router.load()
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    return new AppLayoutPage()
  }

  // The top bar.
  findBanner() {
    return screen.findByRole('banner')
  }

  // The FortyMM brand in the top bar, a link to the dashboard.
  async findBrand() {
    return within(await this.findBanner()).findByRole('link', { name: 'FortyMM' })
  }

  // The device's avatar in the top bar, named by its username.
  async findAvatar() {
    return within(await this.findBanner()).findByRole('img')
  }

  // The username shown beside the device's avatar (hidden from assistive technology, which hears
  // it as the avatar's name).
  async findShownUsername(username: string) {
    return within(await this.findBanner()).findByText(username)
  }

  // The device's avatar, or null if none is shown now.
  queryAvatar() {
    return within(screen.getByRole('banner')).queryByRole('img')
  }

  // The button in the top bar that collapses and expands the sidebar.
  findSidebarToggle() {
    return screen.findByRole('button', { name: 'Sidebar' })
  }

  // The sidebar's navigation.
  findSidebar() {
    return screen.findByRole('navigation', { name: 'Main' })
  }

  // The links in the sidebar, in order.
  async findSidebarLinks() {
    return within(await this.findSidebar()).findAllByRole('link')
  }

  // A link in the sidebar, by its name ("Users").
  async findSidebarLink(name: string) {
    return within(await this.findSidebar()).findByRole('link', { name })
  }

  // The bottom bar's navigation.
  findBottomBar() {
    return screen.findByRole('navigation', { name: 'Bottom bar' })
  }

  // The links in the bottom bar, in order.
  async findBottomBarLinks() {
    return within(await this.findBottomBar()).findAllByRole('link')
  }

  // A link in the bottom bar, by its name ("New match").
  async findBottomBarLink(name: string) {
    return within(await this.findBottomBar()).findByRole('link', { name })
  }

  // The names of the links in `links` marked as the current page.
  static current(links: HTMLElement[]) {
    return links
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent)
  }

  // The tooltip shown, if one is (a collapsed sidebar's link's name).
  tooltip() {
    return screen.queryByRole('tooltip')
  }

  // Where the screen goes: the page's one <main>.
  findMain() {
    return screen.findByRole('main')
  }

  // The layout's navigation, if it is on the page (it isn't on the design system boards).
  sidebar() {
    return screen.queryByRole('navigation', { name: 'Main' })
  }
}
