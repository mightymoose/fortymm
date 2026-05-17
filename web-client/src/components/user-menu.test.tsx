import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse, delay } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/mocks/server'
import { mockSession } from '@/mocks/handlers'
import type { components } from '@/api/schema'
import { UserMenu } from './user-menu'

type SessionResponse = components['schemas']['SessionResponse']

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('UserMenu', () => {
  it('shows a loading skeleton while the session is fetching', async () => {
    server.use(
      http.get('*/v1/session', async () => {
        await delay(50)
        return HttpResponse.json(mockSession)
      }),
    )

    renderWithClient(<UserMenu />)

    expect(screen.getByTestId('user-menu-skeleton')).toBeInTheDocument()
    expect(screen.getByLabelText('Loading user menu')).toHaveAttribute(
      'aria-busy',
      'true',
    )

    await waitFor(() => {
      expect(screen.queryByTestId('user-menu-skeleton')).not.toBeInTheDocument()
    })
  })

  it("displays the user's username once the session resolves", async () => {
    renderWithClient(<UserMenu />)

    expect(
      await screen.findByText(mockSession.data.user.username),
    ).toBeInTheDocument()
    expect(screen.getByTestId('user-menu')).toHaveAttribute(
      'aria-label',
      `Signed in as ${mockSession.data.user.username}`,
    )
  })

  it('renders avatar initials derived from the username', async () => {
    const typed: SessionResponse = {
      data: { user: { username: 'maria.rossi', permissions: [] } },
    }
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(typed)),
    )

    renderWithClient(<UserMenu />)

    expect(await screen.findByText('maria.rossi')).toBeInTheDocument()
    expect(screen.getByText('MR')).toBeInTheDocument()
  })

  it('truncates very long usernames via class and exposes full name as a tooltip', async () => {
    const longName = 'a-really-extraordinarily-long-username-that-should-truncate'
    const typed: SessionResponse = {
      data: { user: { username: longName, permissions: [] } },
    }
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(typed)),
    )

    renderWithClient(<UserMenu />)

    const nameEl = await screen.findByText(longName)
    expect(nameEl).toHaveClass('app-shell__user-name--truncate')
    expect(nameEl).toHaveAttribute('title', longName)
  })
})
