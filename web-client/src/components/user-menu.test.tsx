import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
    expect(screen.getByRole('button', { name: /user menu/i })).toBeInTheDocument()
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

describe('UserMenu — change username', () => {
  function sessionWith(username: string): SessionResponse {
    return { data: { user: { username, permissions: [] } } }
  }

  it('opens the dialog and renames the user end-to-end', async () => {
    let current = 'rita.kovac'
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionWith(current))),
      http.patch('*/v1/me', async ({ request }) => {
        const body = (await request.json()) as { username: string }
        current = body.username
        return HttpResponse.json(sessionWith(current))
      }),
    )

    const user = userEvent.setup()
    renderWithClient(<UserMenu />)

    await screen.findByText('rita.kovac')
    await user.click(screen.getByRole('button', { name: /user menu/i }))

    const menuItem = await screen.findByRole('menuitem', {
      name: /change username/i,
    })
    await user.click(menuItem)

    const input = await screen.findByLabelText(/^username$/i)
    await user.clear(input)
    await user.type(input, 'new-name')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(await screen.findByText('new-name')).toBeInTheDocument()
  })

  it('shows a 409 conflict inline on the field', async () => {
    server.use(
      http.get('*/v1/session', () =>
        HttpResponse.json(sessionWith('rita.kovac')),
      ),
      http.patch('*/v1/me', () =>
        HttpResponse.json({ detail: 'Username already taken.' }, { status: 409 }),
      ),
    )

    const user = userEvent.setup()
    renderWithClient(<UserMenu />)

    await screen.findByText('rita.kovac')
    await user.click(screen.getByRole('button', { name: /user menu/i }))
    await user.click(
      await screen.findByRole('menuitem', { name: /change username/i }),
    )

    const input = await screen.findByLabelText(/^username$/i)
    await user.clear(input)
    await user.type(input, 'taken')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(
      await screen.findByText('Username already taken.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('blocks submission of client-invalid input without hitting the API', async () => {
    let patchCalls = 0
    server.use(
      http.get('*/v1/session', () =>
        HttpResponse.json(sessionWith('rita.kovac')),
      ),
      http.patch('*/v1/me', () => {
        patchCalls++
        return HttpResponse.json(sessionWith('whatever'))
      }),
    )

    const user = userEvent.setup()
    renderWithClient(<UserMenu />)

    await screen.findByText('rita.kovac')
    await user.click(screen.getByRole('button', { name: /user menu/i }))
    await user.click(
      await screen.findByRole('menuitem', { name: /change username/i }),
    )

    const input = await screen.findByLabelText(/^username$/i)
    await user.clear(input)
    await user.type(input, 'ab')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText(/at least 3 characters/i)).toBeInTheDocument()
    expect(patchCalls).toBe(0)
  })

  it("flags submitting the same name as already-yours", async () => {
    server.use(
      http.get('*/v1/session', () =>
        HttpResponse.json(sessionWith('rita.kovac')),
      ),
    )

    const user = userEvent.setup()
    renderWithClient(<UserMenu />)

    await screen.findByText('rita.kovac')
    await user.click(screen.getByRole('button', { name: /user menu/i }))
    await user.click(
      await screen.findByRole('menuitem', { name: /change username/i }),
    )

    await user.click(screen.getByRole('button', { name: /^save$/i }))
    expect(
      await screen.findByText(/already your username/i),
    ).toBeInTheDocument()
  })
})
