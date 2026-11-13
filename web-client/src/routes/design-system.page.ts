import { screen, within } from '@testing-library/react'
import { renderRoute } from '../test/render-route.tsx'

// The design system page (src/routes/design-system.tsx): how to open it, and
// what a person sees on it.
export class DesignSystemPage {
  render() {
    return renderRoute('/design-system')
  }

  header() {
    return screen.findByRole('banner')
  }

  // The FortyMM wordmark, in the page's header.
  async wordmark() {
    return within(await this.header()).findByRole('img', { name: 'FortyMM' })
  }

  // The page's title, in its header.
  async heading() {
    return within(await this.header()).findByRole('heading', {
      level: 1,
      name: 'Design system',
    })
  }
}
