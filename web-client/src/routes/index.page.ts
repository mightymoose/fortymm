import { screen } from '@testing-library/react'
import { renderRoute } from '../test/render-route.tsx'

// The start page (src/routes/index.tsx): how to open it, and what a person
// sees on it. Interactions belong in the test, with user-event.
export class StartPage {
  render() {
    return renderRoute('/')
  }

  heading() {
    return screen.findByRole('heading', { name: 'Get started' })
  }

  counter() {
    return screen.findByRole('button', { name: /^Count is \d+$/ })
  }

  linkToHealth() {
    return screen.findByRole('link', { name: 'Check the API’s health' })
  }

  linkToSettings() {
    return screen.findByRole('link', { name: 'Account settings' })
  }
}
