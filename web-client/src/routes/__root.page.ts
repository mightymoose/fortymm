import { screen } from '@testing-library/react'
import { renderRoute } from '../test/render-route.tsx'

// The not-found page (notFoundComponent in __root.tsx): how to open it, and
// what a person sees on it.
export class NotFoundPage {
  // Any URL that matches no route shows this page. The default is one such
  // URL; pass another to test a particular shape.
  render(path = '/no/such/page') {
    return renderRoute(path)
  }

  heading() {
    return screen.findByRole('heading', { name: 'Page not found' })
  }

  linkToStart() {
    return screen.findByRole('link', { name: 'Go to the start page' })
  }
}
