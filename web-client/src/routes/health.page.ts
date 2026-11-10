import { screen } from '@testing-library/react'
import { renderRoute } from '../test/render-route.tsx'

// The health page (src/routes/health.tsx): how to open it, and what a person
// sees on it. Say how the api answers first (server.use with a handler from
// src/test/api/health.ts), then render(). Each finder waits for its sentence,
// so a test can look for the answer while the page still says "checking".
export class HealthPage {
  render() {
    return renderRoute('/health')
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
}
