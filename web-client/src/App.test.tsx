import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import App from './App'

// App renders <Link>s, so it must be mounted inside a router context — the
// same way it runs in production as the `/` route.
function renderApp() {
  const router = createRouter({
    routeTree: createRootRoute({ component: App }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

describe('App', () => {
  it('renders the FortyMM hero', async () => {
    renderApp()
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: /play more\.\s*pay never\./i,
      }),
    ).toBeInTheDocument()
  })

  it('switches the active product feature when a tab is clicked', async () => {
    const user = userEvent.setup()
    renderApp()

    expect(
      await screen.findByRole('heading', { name: /scores in, history out\./i }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /run tournaments/i }))

    expect(
      screen.getByRole('heading', { name: /the schedule, solved\./i }),
    ).toBeInTheDocument()
  })
})
