import { screen, within } from '@testing-library/react'
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

  // The paragraph right after the page's header.
  get intro(): HTMLElement {
    return screen.getAllByRole('paragraph')[0]
  }

  get formsSection(): HTMLElement {
    return screen.getByRole('region', { name: 'Forms & Input' })
  }

  get formsSectionHeading(): HTMLElement {
    return within(this.formsSection).getByRole('heading', { level: 2 })
  }

  get formsSectionLead(): HTMLElement {
    return within(this.formsSection).getByRole('paragraph')
  }

  get buttonCard(): HTMLElement {
    return within(this.formsSection).getByRole('article', { name: 'Button' })
  }

  get buttonCardHeading(): HTMLElement {
    return within(this.buttonCard).getByRole('heading', { level: 3 })
  }

  button(name: string): HTMLElement {
    return within(this.buttonCard).getByRole('button', { name })
  }
}
