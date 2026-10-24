import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderRoute } from '../renderRoute'

export type LoginPath = '/login1' | '/login2' | '/login3' | '/login4'

// Page object for the log in mockups. They make no request, so this doesn't
// wait for the health check.
export class LoginPage {
  static async render(path: LoginPath): Promise<LoginPage> {
    await renderRoute(path, { waitForHealth: false })
    return new LoginPage()
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  get email(): HTMLElement {
    return screen.getByRole('textbox', { name: 'Email' })
  }

  get emailError(): HTMLElement | null {
    return screen.queryByText(/Enter an email address/, { ignore: '[hidden] *' })
  }

  get code(): HTMLElement | null {
    return screen.queryByRole('group', { name: 'Code' })
  }

  async sendCode(email: string): Promise<void> {
    if (email) await userEvent.type(this.email, email)
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }))
  }

  async changeEmail(): Promise<void> {
    await userEvent.click(screen.getByRole('button', { name: 'Use a different email' }))
  }
}
