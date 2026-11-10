import { screen } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'

// What a person does and sees on the start page (src/routes/index.tsx).
export class StartPage {
  private readonly user: UserEvent

  constructor(user: UserEvent) {
    this.user = user
  }

  heading() {
    return screen.findByRole('heading', { name: 'Get started' })
  }

  counter() {
    return screen.findByRole('button', { name: /^Count is \d+$/ })
  }

  async clickCounter() {
    await this.user.click(await this.counter())
  }
}
