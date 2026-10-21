import { screen } from '@testing-library/react'
import { renderRoute } from '../renderRoute'

// Page object for the home page in unit tests. Elements are looked up through
// `screen` on every access, so they always reflect the current render.
export class HomePage {
  static async render(): Promise<HomePage> {
    await renderRoute('/')
    return new HomePage()
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  get designSystemLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Design System' })
  }
}
