import { render, screen } from '@testing-library/react'
import App from '../../App'

// Page object for the home page in unit tests. Elements are looked up through
// `screen` on every access, so they always reflect the current render.
export class HomePage {
  static render(): HomePage {
    render(<App />)
    return new HomePage()
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }
}
