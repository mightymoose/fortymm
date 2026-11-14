import { screen, within } from '@testing-library/react'
import { renderScreen } from '../test/render-screen.tsx'
import { DesignSystemScreen } from './DesignSystemScreen.tsx'

// The design system screen (DesignSystemScreen.tsx): how to render it alone,
// and what a person sees on it. The finders work wherever the screen is
// mounted, through its route (src/routes/design-system.test.tsx) too.
export class DesignSystemScreenPage {
  render() {
    return renderScreen(<DesignSystemScreen />)
  }

  header() {
    return screen.findByRole('banner')
  }

  // The FortyMM wordmark, in the page's header.
  async wordmark() {
    return within(await this.header()).findByRole('img', { name: 'FortyMM' })
  }

  // The section showing each control in each state.
  controls() {
    return screen.findByRole('region', { name: 'Controls' })
  }

  // A part of the controls section, by its heading ("Buttons", "Fields").
  async controlsPart(name: string) {
    return within(await this.controls()).findByRole('heading', {
      level: 3,
      name,
    })
  }

  // The page's title, in its header.
  async heading() {
    return within(await this.header()).findByRole('heading', {
      level: 1,
      name: 'Design system',
    })
  }
}
