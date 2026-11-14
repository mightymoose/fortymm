import { screen } from '@testing-library/react'
import { renderScreen } from '../test/render-screen.tsx'
import { DashboardScreen } from './DashboardScreen.tsx'

// The dashboard (DashboardScreen.tsx): how to render it alone, and what a
// person sees on it. The finders work wherever the screen is mounted,
// through its route (src/routes/index.test.tsx) too.
export class DashboardScreenPage {
  render() {
    return renderScreen(<DashboardScreen />)
  }

  heading() {
    return screen.findByRole('heading', { level: 1, name: 'Dashboard' })
  }
}
