import { createMemoryHistory } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { App } from './App.tsx'
import { HomeScreenPage } from './components/HomeScreen.page.tsx'
import { NotFoundScreenPage } from './components/NotFoundScreen.page.tsx'
import { createAppRouter } from './router.ts'

// Page object for the whole app, rendered with an in-memory history so a test can start at any path.
export class AppPage {
  readonly home = new HomeScreenPage()
  readonly notFound = new NotFoundScreenPage()

  // Resolves once the router has loaded the route at `path`, so its screen is already on the page.
  static async render(path = '/') {
    const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })
    await router.load()
    render(<App router={router} />)
    return new AppPage()
  }
}
