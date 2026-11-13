import { screen } from '@testing-library/react'
import { renderRoute } from '../test/render-route.tsx'

// The start page (src/routes/index.tsx): how to open it, and what a person
// sees on it. It is blank: its one element is a heading for screen readers.
export class StartPage {
  render() {
    return renderRoute('/')
  }

  heading() {
    return screen.findByRole('heading', { level: 1, name: 'FortyMM' })
  }

  images() {
    return screen.queryAllByRole('img')
  }
}
