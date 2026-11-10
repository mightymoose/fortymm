import { screen } from '@testing-library/react'

// What a person sees on the not-found page (notFoundComponent in __root.tsx).
export class NotFoundPage {
  heading() {
    return screen.findByRole('heading', { name: 'Page not found' })
  }

  linkToStart() {
    return screen.findByRole('link', { name: 'Go to the start page' })
  }
}
