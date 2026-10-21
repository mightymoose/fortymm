import { screen } from '@testing-library/react'
import { renderRoute } from '../renderRoute'

// Page object for the design system page in unit tests. Elements are looked
// up through `screen` on every access, so they always reflect the current
// render.
export class DesignSystemPage {
  static async render(): Promise<DesignSystemPage> {
    await renderRoute('/design-system')
    return new DesignSystemPage()
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }
}
