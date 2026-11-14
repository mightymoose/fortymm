import { screen } from '@testing-library/react'
import { renderScreen } from '../test/render-screen.tsx'
import { NotFoundScreen } from './NotFoundScreen.tsx'

// The not-found screen (NotFoundScreen.tsx): how to render it alone, and what
// a person sees on it. The finders work wherever the screen is mounted,
// through the root route (src/routes/__root.test.tsx) too.
export class NotFoundScreenPage {
  render() {
    return renderScreen(<NotFoundScreen />)
  }

  heading() {
    return screen.findByRole('heading', { name: 'Page not found' })
  }

  linkToStart() {
    return screen.findByRole('link', { name: 'Go to the start page' })
  }
}
