import { screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { renderScreen } from '../test/render-screen.tsx'
import { DesignSystemLayout } from './DesignSystemLayout.tsx'

// The design system page (DesignSystemLayout.tsx, and the tab it shows):
// how to render its layout or one of its tabs alone, and what a person sees
// on it. The finders work wherever the page is mounted, through its routes
// (src/routes/design-system.test.tsx) too.
export class DesignSystemPage {
  // The layout, with `children` where the current tab goes, at `path` (which
  // says which tab is current; `/` unless given).
  render({ path, children }: { path?: string; children?: ReactNode } = {}) {
    return renderScreen(<DesignSystemLayout>{children}</DesignSystemLayout>, {
      path,
    })
  }

  // One tab's component (<ColourTab />), alone.
  renderTab(tab: ReactNode) {
    return renderScreen(tab)
  }

  // The FortyMM wordmark, in the page's header. (The page's header is not a
  // banner landmark: in the app it sits in the layout's <main>, whose top
  // bar is the banner.)
  wordmark() {
    return screen.findByRole('img', { name: 'FortyMM' })
  }

  // The page's title, in its header.
  heading() {
    return screen.findByRole('heading', { level: 1, name: 'Design system' })
  }

  // The tabs: a navigation landmark.
  tabs() {
    return screen.findByRole('navigation', { name: 'Design system' })
  }

  // Each tab's link, in order.
  async tabLinks() {
    return within(await this.tabs()).findAllByRole('link')
  }

  // One tab's link, by its name ("Colour").
  async tab(name: string) {
    return within(await this.tabs()).findByRole('link', { name })
  }

  // A tab's board, by its title ("Colour", "Controls").
  board(name: string) {
    return screen.findByRole('region', { name })
  }

  // A section of a board, by its heading ("Ink", "Buttons").
  async boardSection(board: string, name: string) {
    return within(await this.board(board)).findByRole('heading', {
      level: 3,
      name,
    })
  }
}
