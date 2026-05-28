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
  // jsdom lacks scrollIntoView; TanStack Router calls it for hash restoration.
  Element.prototype.scrollIntoView = () => {}
  // Reset the shared session between tests so honeypot/email checks start fresh.
  mockSession.data.user.email = null
  mockSession.data.user.confirmed_at = null
  mockSession.data.user.pending_email = null
  mockSession.data.user.username = 'rita.kovac'
})

async function renderSettings(initialEntry = '/settings') {
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
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
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

  it('focuses the email input when a guest is deep-linked via #sec-email', async () => {
    await renderSettings('/settings#sec-email')
    const emailInput = await screen.findByLabelText(/^email$/i)
    await waitFor(() => expect(emailInput).toHaveFocus())
  })

  it("doesn't focus the email input on a plain /settings load", async () => {
    await renderSettings()
    const emailInput = await screen.findByLabelText(/^email$/i)
    expect(emailInput).not.toHaveFocus()
  })

  it("doesn't focus the email input for a verified user landing on #sec-email", async () => {
    mockSession.data.user.email = 'rita@example.com'
    mockSession.data.user.confirmed_at = '2026-01-01T00:00:00Z'
    await renderSettings('/settings#sec-email')
    const emailInput = await screen.findByLabelText(/^email$/i)
    expect(emailInput).not.toHaveFocus()
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

describe('SettingsPage username section', () => {
  it('preserves what the user typed without silently lowercasing or stripping spaces', async () => {
    const user = userEvent.setup()
    await renderSettings()

    const input = (await screen.findByLabelText(/^username$/i)) as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'Foo bar')

    expect(input.value).toBe('Foo bar')
    // Counter reflects the actual typed length, not a post-strip length.
    const section = input.closest('section') as HTMLElement
    expect(within(section).getByText('7/40')).toBeInTheDocument()
  })

  it('shows a clear inline error when uppercase is typed', async () => {
    const user = userEvent.setup()
    await renderSettings()

    const input = await screen.findByLabelText(/^username$/i)
    await user.clear(input)
    await user.type(input, 'Foo')

    const section = input.closest('section') as HTMLElement
    expect(
      within(section).getByText(/lowercase letters only/i),
    ).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(
      within(section).getByRole('button', { name: /save changes/i }),
    ).toBeDisabled()
  })

  it('shows a clear inline error when whitespace is typed', async () => {
    const user = userEvent.setup()
    await renderSettings()

    const input = await screen.findByLabelText(/^username$/i)
    await user.clear(input)
    await user.type(input, 'foo bar')

    const section = input.closest('section') as HTMLElement
    expect(within(section).getByText(/no spaces/i)).toBeInTheDocument()
  })
})
