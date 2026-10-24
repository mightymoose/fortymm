import { screen } from '@testing-library/react'
import { renderRoute } from '../renderRoute'

// Page object for the design system page in unit tests. Elements are looked
// up through `screen` on every access, so they always reflect the current
// render.
export class DesignSystemPage {
  // The page doesn't check the API's health, so this doesn't wait for it.
  static async render(): Promise<DesignSystemPage> {
    await renderRoute('/design-system', { waitForHealth: false })
    return new DesignSystemPage()
  }

  // The loading screen, or null while it isn't shown.
  get loadingScreen(): HTMLElement | null {
    return screen.queryByRole('status', { name: 'Loading FortyMM' })
  }

  get homeLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Home' })
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  // The paragraph right after the page's title.
  get intro(): HTMLElement {
    return screen.getAllByRole('paragraph')[0]
  }
}
