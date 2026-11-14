import { screen } from '@testing-library/react'
import type { Health } from '../api/health.ts'
import type { CoreCheck } from '../core/check.ts'
import { renderScreen } from '../test/render-screen.tsx'
import { HealthScreen } from './HealthScreen.tsx'

// The health screen (HealthScreen.tsx): how to render it alone, and what a
// person sees on it. render() takes the two answers as the route's loader
// hands them, promises; one the test hasn't settled yet is an answer still on
// its way. Each finder waits for its sentence, so a test can look for the
// answer while the screen still says "checking". The finders work wherever the
// screen is mounted, through its route (src/routes/health.test.tsx) too.
export class HealthScreenPage {
  render(answers: { health: Promise<Health>; core: Promise<CoreCheck> }) {
    return renderScreen(<HealthScreen {...answers} />)
  }

  heading() {
    return screen.findByRole('heading', { name: 'API health' })
  }

  checking() {
    return screen.findByRole('heading', { name: 'Checking the API’s health' })
  }

  healthy() {
    return screen.findByRole('heading', { name: 'The API is healthy' })
  }

  databaseUnavailable() {
    return screen.findByRole('heading', { name: 'The API’s database is unavailable' })
  }

  unknown() {
    return screen.findByRole('heading', { name: 'The API’s health is unknown' })
  }

  // The core's answer, a live region named by its title.
  coreLoaded() {
    return screen.findByRole('status', { name: 'The shared core loaded' })
  }

  coreNotLoaded() {
    return screen.findByRole('status', { name: 'The shared core did not load' })
  }
}
