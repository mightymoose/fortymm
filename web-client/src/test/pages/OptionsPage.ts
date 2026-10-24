import { screen } from '@testing-library/react'
import { renderRoute } from '../renderRoute'

// Page object for /options and the option previews under it, in unit
// tests. The pages don't check the API's health, so this doesn't wait for
// it.
export class OptionsPage {
  static async render(path = '/options'): Promise<OptionsPage> {
    await renderRoute(path, { waitForHealth: false })
    return new OptionsPage()
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  // The option's name, last in the breadcrumb.
  get optionName(): HTMLElement {
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    return crumbs.querySelector('[aria-current="page"]') as HTMLElement
  }

  link(name: string): HTMLElement {
    return screen.getByRole('link', { name })
  }
}
