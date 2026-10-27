import { screen, within } from '@testing-library/react'
import type { LoginGatePath } from '../../pages/loginGate/GateGallery'
import { renderRoute } from '../renderRoute'

export type FrameSize = 'Phone, 375px' | 'Desktop, 1280px'

// Page object for the login gate mockups. They make no request, so this
// doesn't wait for the session.
export class LoginGatePage {
  static async render(path: LoginGatePath): Promise<LoginGatePage> {
    await renderRoute(path, { waitForSession: false })
    return new LoginGatePage()
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  // The titles of the frames, in page order.
  get frameTitles(): string[] {
    return screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent ?? '')
  }

  // The frame titled `title`, at `size`.
  frame(title: string, size: FrameSize): HTMLElement {
    const section = screen.getByRole('region', { name: title })
    return within(section).getByRole('figure', { name: size })
  }

  // The buttons in the frame titled `title`, at `size`.
  buttons(title: string, size: FrameSize): HTMLElement[] {
    return within(this.frame(title, size)).getAllByRole('button')
  }
}
