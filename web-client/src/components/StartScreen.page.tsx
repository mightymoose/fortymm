import { screen } from '@testing-library/react'
import { renderScreen } from '../test/render-screen.tsx'
import { StartScreen } from './StartScreen.tsx'

// The start screen (StartScreen.tsx): how to render it alone, and what a
// person sees on it. It is blank: its one element is a heading for screen
// readers. The finders work wherever the screen is mounted, through its route
// (src/routes/index.test.tsx) too.
export class StartScreenPage {
  render() {
    return renderScreen(<StartScreen />)
  }

  heading() {
    return screen.findByRole('heading', { level: 1, name: 'FortyMM' })
  }

  images() {
    return screen.queryAllByRole('img')
  }
}
