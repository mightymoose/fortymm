import { render, screen } from '@testing-library/react'
import { HomeScreen } from './HomeScreen.tsx'

// Page object for the home screen. Use `render()` to test it on its own, or construct one after
// rendering the whole app (see App.page.tsx) to query the screen the router shows.
export class HomeScreenPage {
  static render() {
    render(<HomeScreen />)
    return new HomeScreenPage()
  }

  get heading() {
    return screen.getByRole('heading', { level: 1, name: 'FortyMM' })
  }

  // Waits for the screen to appear, e.g. once the router has loaded a lazy route.
  findHeading() {
    return screen.findByRole('heading', { level: 1, name: 'FortyMM' })
  }
}
