import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockSession } from '@/mocks/handlers'

// The real Turnstile widget loads a remote script that jsdom can't run.
// Replace it with a stub that hands back a token on click, so the form
// submit path is testable.
vi.mock('@/components/turnstile', () => ({
  Turnstile: ({ onToken }: { onToken: (t: string) => void }) => (
    <button
      type="button"
      data-testid="captcha-stub"
      onClick={() => onToken('stub-token')}
    >
      Complete captcha
    </button>
  ),
}))

// Stub IntersectionObserver — radix-ui components used inside AppShell
// instantiate it on mount and jsdom does not ship one.
beforeEach(() => {
  const g = globalThis as { IntersectionObserver?: unknown }
  if (!g.IntersectionObserver) {
    g.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    }
  }
  // Reset the shared session between tests so honeypot/email checks start fresh.
  mockSession.data.user.email = null
  mockSession.data.user.confirmed_at = null
  mockSession.data.user.pending_email = null
  mockSession.data.user.username = 'rita.kovac'
})

async function renderSettings() {
  const { Route } = await import('./settings')
  const SettingsPage = Route.options.component!

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  })
  const rootRoute = createRootRoute()
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: SettingsPage,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute]),
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('SettingsPage email section', () => {
  it('shows the guest claim banner until an email is set', async () => {
    await renderSettings()
    expect(await screen.findByText(/playing as a guest/i)).toBeInTheDocument()
  })

  it('persists a submitted email and re-renders as pending', async () => {
    const user = userEvent.setup()
    await renderSettings()

    const section = (await screen.findByLabelText(/^email$/i)).closest(
      'section',
    ) as HTMLElement
    const emailInput = within(section).getByLabelText(/^email$/i)
    await user.type(emailInput, 'me@example.com')
    await user.click(within(section).getByTestId('captcha-stub'))

    const submit = within(section).getByRole('button', { name: /add email/i })
    await waitFor(() => expect(submit).toBeEnabled())
    await user.click(submit)

    expect(
      await screen.findByText(/waiting for verification/i),
    ).toBeInTheDocument()
    expect(mockSession.data.user.pending_email).toBe('me@example.com')
    expect(mockSession.data.user.email).toBeNull()
  })

  it("doesn't persist when the honeypot is filled", async () => {
    const user = userEvent.setup()
    await renderSettings()

    const section = (await screen.findByLabelText(/^email$/i)).closest(
      'section',
    ) as HTMLElement
    const emailInput = within(section).getByLabelText(/^email$/i)
    await user.type(emailInput, 'me@example.com')
    // Spammer fills the honeypot. Humans never touch it.
    const honeypot = within(section).getByTestId('email-honeypot')
    await user.type(honeypot, 'spammer.example')
    await user.click(within(section).getByTestId('captcha-stub'))

    const submit = within(section).getByRole('button', { name: /add email/i })
    await waitFor(() => expect(submit).toBeEnabled())
    await user.click(submit)

    // The server responds as if it succeeded (status hidden from the bot)
    // but the session never picked up the pending change.
    await waitFor(() =>
      expect(mockSession.data.user.pending_email).toBeNull(),
    )
  })

  it('requires the captcha before the submit button enables', async () => {
    const user = userEvent.setup()
    await renderSettings()

    const section = (await screen.findByLabelText(/^email$/i)).closest(
      'section',
    ) as HTMLElement
    const emailInput = within(section).getByLabelText(/^email$/i)
    await user.type(emailInput, 'me@example.com')

    const submit = within(section).getByRole('button', { name: /add email/i })
    expect(submit).toBeDisabled()
  })
})
