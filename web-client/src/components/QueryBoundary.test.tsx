import { QueryClient, QueryClientProvider, useSuspenseQuery } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, ApiUnreachable } from '../api/errors'
import { QueryBoundary } from './QueryBoundary'

function Greeting({ load }: { load: () => Promise<string> }) {
  const { data } = useSuspenseQuery({ queryKey: ['greeting'], queryFn: load })
  return <p>{data}</p>
}

function renderBoundary(load: () => Promise<string>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <QueryBoundary
        skeleton={<p>Loading the greeting</p>}
        actions={<a href="/">Go to Home</a>}
      >
        <Greeting load={load} />
      </QueryBoundary>
    </QueryClientProvider>,
  )
}

function failure(status: number): ApiError {
  return new ApiError('GET /greeting', new Response(null, { status }))
}

describe('QueryBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the skeleton while the data loads, then the component', async () => {
    let respond = (_greeting: string) => {}
    renderBoundary(() => new Promise((resolve) => (respond = resolve)))

    expect(await screen.findByText('Loading the greeting')).toBeVisible()

    await act(async () => respond('Hello'))

    expect(await screen.findByText('Hello')).toBeVisible()
    expect(screen.queryByText('Loading the greeting')).toBeNull()
  })

  it.each([
    ['a 500', failure(500), 'Something went wrong'],
    ['a 503', failure(503), 'Can’t reach FortyMM'],
    ['no response', new ApiUnreachable('GET /greeting', {}), 'Can’t reach FortyMM'],
    ['a 429', failure(429), 'Wait a minute, then try again'],
  ])('says what went wrong after %s, with the extra actions', async (_case, error, title) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderBoundary(() => Promise.reject(error))

    const alert = await screen.findByRole('alert', { name: title })
    expect(alert).toContainElement(screen.getByRole('button', { name: 'Try again' }))
    expect(alert).toContainElement(screen.getByRole('link', { name: 'Go to Home' }))
  })

  it('says when to try again after a 429 with Retry-After', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 25, 19, 42, 10).getTime())
    const error = new ApiError(
      'GET /greeting',
      new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
    )
    renderBoundary(() => Promise.reject(error))

    const alert = await screen.findByRole('alert', { name: 'Wait a minute, then try again' })
    const at = new Date(2026, 9, 25, 19, 43, 10).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
    expect(alert).toHaveTextContent(`Try again at ${at}`)
  })

  it('loads again on Try again, and shows the component when that works', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure(500))
      .mockResolvedValueOnce('Hello')
    renderBoundary(load)
    await screen.findByRole('alert', { name: 'Something went wrong' })

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Hello')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(load).toHaveBeenCalledTimes(2)
  })
})
