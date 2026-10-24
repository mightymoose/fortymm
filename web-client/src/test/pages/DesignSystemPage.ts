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

  get fieldsSection(): HTMLElement {
    return screen.getByRole('region', { name: 'Fields and choices' })
  }

  // The Fields and choices section's example titled `title`, e.g. "Code
  // input".
  fieldsExample(title: string): HTMLElement {
    return within(this.fieldsSection).getByRole('article', { name: title })
  }

  // The opponent combobox's field.
  get opponentField(): HTMLElement {
    return within(this.fieldsSection).getByRole('combobox', { name: 'Opponent' })
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

  get overlaysSection(): HTMLElement {
    return screen.getByRole('region', { name: 'Overlays' })
  }

  // The Overlays section's button named `name`, e.g. "Open match drawer".
  overlaysButton(name: string): HTMLElement {
    return within(this.overlaysSection).getByRole('button', { name })
  }

  // The open dialog or sheet named `name`, e.g. "Patel vs Wójcik-Szymańska".
  dialog(name: string): HTMLElement {
    return screen.getByRole('dialog', { name })
  }

  // The open dialogs and sheets.
  get openDialogs(): HTMLElement[] {
    return screen.queryAllByRole('dialog')
  }

  // The page's tooltip, or null while none shows.
  get tooltip(): HTMLElement | null {
    return screen.queryByRole('tooltip')
  }

  // The command palette's search field, while it's open.
  get paletteSearch(): HTMLElement {
    return within(this.dialog('Command palette')).getByRole('combobox')
  }

  // The command palette's group named `name`, e.g. "Go to", while it's open.
  paletteGroup(name: string): HTMLElement {
    return within(this.dialog('Command palette')).getByRole('group', { name })
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
