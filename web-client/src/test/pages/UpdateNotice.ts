import { screen, within } from '@testing-library/react'

export class UpdateNotice {
  private get region(): HTMLElement {
    return screen.getByRole('status', { name: 'Notifications' })
  }

  get message(): HTMLElement | null {
    return within(this.region).queryByText('FortyMM has been updated.')
  }

  get reloadButton(): HTMLElement {
    return within(this.region).getByRole('button', { name: /^Reload(ing…)?$/ })
  }

  get dismissButton(): HTMLElement | null {
    return within(this.region).queryByRole('button', { name: 'Dismiss' })
  }
}
