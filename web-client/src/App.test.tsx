import { render, screen, within } from '@testing-library/react'
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

  it('exposes the section links behind a mobile hamburger toggle', async () => {
    // Regression for #375: at narrow widths the desktop `.nav-links` are
    // hidden, so the only way to reach Product/Tournaments/Manifesto/FAQ is
    // through a hamburger toggle + collapsible menu. Before the fix neither
    // existed, leaving the nav unreachable on mobile.
    const user = userEvent.setup()
    renderApp()

    // The toggle is `display:none` on desktop (jsdom applies the stylesheet),
    // so it's hidden from the a11y tree until the mobile breakpoint — query it
    // by its label, which ignores visibility.
    const toggle = await screen.findByLabelText('Open menu')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      document.querySelector('.fortymm-landing .nav-mobile-menu'),
    ).toBeNull()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const menu = document.querySelector('.fortymm-landing .nav-mobile-menu')
    expect(menu).not.toBeNull()
    // The collapsible menu is also stylesheet-hidden in jsdom (no media query),
    // so include hidden elements when asserting its links are present.
    const labels = ['Product', 'Tournaments', 'Manifesto', 'FAQ', 'Sign in']
    for (const label of labels) {
      expect(
        within(menu as HTMLElement).getByRole('link', { name: label, hidden: true }),
      ).toBeInTheDocument()
    }
    expect(
      within(menu as HTMLElement).getByRole('link', {
        name: /start playing/i,
        hidden: true,
      }),
    ).toBeInTheDocument()

    // Tapping a section link collapses the menu again.
    await user.click(
      within(menu as HTMLElement).getByRole('link', {
        name: 'Tournaments',
        hidden: true,
      }),
    )
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      document.querySelector('.fortymm-landing .nav-mobile-menu'),
    ).toBeNull()
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
