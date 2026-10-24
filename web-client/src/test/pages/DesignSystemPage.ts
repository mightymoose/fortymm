import { screen, within } from '@testing-library/react'
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

  get buttonsSection(): HTMLElement {
    return screen.getByRole('region', { name: 'Buttons' })
  }

  // The Buttons section's button named `name`, e.g. "Save result".
  button(name: string): HTMLElement {
    return within(this.buttonsSection).getByRole('button', { name })
  }

  get feedbackSection(): HTMLElement {
    return screen.getByRole('region', { name: 'Feedback' })
  }

  // The Feedback section's button named `name`, e.g. "Mark Table 4 free".
  feedbackButton(name: string): HTMLElement {
    return within(this.feedbackSection).getByRole('button', { name })
  }

  // The Feedback section's example titled `title`, e.g. "Warning and error".
  feedbackExample(title: string): HTMLElement {
    return within(this.feedbackSection).getByRole('article', { name: title })
  }

  // Where the app's toasts show, bottom centre.
  get toastRegion(): HTMLElement {
    return screen.getByRole('status', { name: 'Notifications' })
  }

  // The button named `name` on the shown toast, e.g. "Undo".
  toastButton(name: string): HTMLElement {
    return within(this.toastRegion).getByRole('button', { name })
  }
}
