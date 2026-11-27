import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { NotFoundScreen } from './NotFoundScreen.tsx'

// Page object for the not-found screen. Use `render()` to test it on its own (inside a bare router,
// since it renders a <Link>), or construct one after rendering the whole app (see App.page.tsx).
// Test where its links go through the whole app, not here.
export class NotFoundScreenPage {
  static async render() {
    const router = createRouter({
      routeTree: createRootRoute({ component: NotFoundScreen }),
      history: createMemoryHistory(),
    })
    await router.load()
    render(<RouterProvider router={router} />)
    return new NotFoundScreenPage()
  }

  get heading() {
    return screen.getByRole('heading', { level: 1, name: 'Page not found' })
  }

  get homeLink() {
    return screen.getByRole('link', { name: 'Go to the home page' })
  }
}
