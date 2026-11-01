import { act, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { components } from './schema'
import { OFFLINE_AFTER_MS } from './queries'
import { saveAccount, savedAccount } from './savedSession'
import { ErrorPage } from '../test/pages/ErrorPage'
import { HomePage } from '../test/pages/HomePage'
import { API_BASE_URL, failSession, holdSession, server, sessionResponse } from '../test/server'

vi.mock('../leavePage', () => ({ leavePage: vi.fn() }))

type SessionResponse = components['schemas']['SessionResponse']

const account = sessionResponse.data.account

function withPlayer(displayName: string): SessionResponse {
  return {
    data: { account: { ...account, player: { ...account.player, display_name: displayName } } },
  }
}

function answerSession(response: SessionResponse) {
  server.use(http.post(`${API_BASE_URL}/v1/session`, () => HttpResponse.json(response)))
}

// A page load that reaches the API, which saves its account.
async function loadOnline(): Promise<void> {
  await HomePage.render()
  cleanup()
}

// React and the router log the error an error page shows.
function silenceErrors() {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
}

describe('the saved session', () => {
  // The router shows a page only once its chunks have loaded, and the fake
  // clock below would stop that load. So load them once first.
  beforeAll(loadOnline)

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows Home with the earlier account when the session gets no response', async () => {
    await loadOnline()
    failSession()

    const homePage = await HomePage.render()

    expect(homePage.title).toHaveTextContent('What’s coming, and when.')
    expect(homePage.accountButton).toHaveTextContent('excited egret 387')
  })

  it('shows the error page when nothing is saved and the session gets no response', async () => {
    silenceErrors()
    failSession()

    const errorPage = await ErrorPage.render('/')

    expect(errorPage.title).toHaveTextContent('Can’t reach FortyMM')
  })

  it('shows the error page, not the saved account, when the API answers with an error', async () => {
    silenceErrors()
    await loadOnline()
    server.use(
      http.post(`${API_BASE_URL}/v1/session`, () =>
        HttpResponse.json({ errors: [{ status: '500', title: 'Failed' }] }, { status: 500 }),
      ),
    )

    const errorPage = await ErrorPage.render('/')

    expect(errorPage.title).toHaveTextContent('Something went wrong')
  })

  it('shows the saved account after a slow session, then the API’s answer when it comes', async () => {
    await loadOnline()
    const session = holdSession()
    // Only the timers and the clock the router and the session race use.
    // React and MSW keep real ones.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    const homePage = await HomePage.render({ waitForLoad: false })
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })

    await advance(OFFLINE_AFTER_MS - 1)
    expect(homePage.queryTitle).not.toBeInTheDocument()

    await advance(1)
    await advance(0)
    expect(homePage.title).toHaveTextContent('What’s coming, and when.')
    expect(homePage.accountButton).toHaveTextContent('excited egret 387')

    vi.useRealTimers()
    await session.respond(HttpResponse.json(withPlayer('brave badger 214')))
    await vi.waitFor(() =>
      expect(homePage.accountButton).toHaveTextContent('brave badger 214'),
    )
  })

  it('starts the session again when the browser comes back online', async () => {
    await loadOnline()
    failSession()
    const homePage = await HomePage.render()
    expect(homePage.accountButton).toHaveTextContent('excited egret 387')

    answerSession(withPlayer('brave badger 214'))
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })

    await vi.waitFor(() =>
      expect(homePage.accountButton).toHaveTextContent('brave badger 214'),
    )
  })

  it('forgets the saved account on sign-out', async () => {
    silenceErrors()
    answerSession({ data: { account: { ...account, kind: 'verified', email: 'ann@example.com' } } })
    const homePage = await HomePage.render()
    await userEvent.click(homePage.accountButton!)
    await userEvent.click(
      within(homePage.accountMenu).getByRole('menuitem', { name: 'Sign out' }),
    )
    await vi.waitFor(() => expect(savedAccount()).toBeNull())
    cleanup()
    failSession()

    const errorPage = await ErrorPage.render('/')

    expect(errorPage.title).toHaveTextContent('Can’t reach FortyMM')
  })
})

describe('savedAccount', () => {
  it('returns the account it saved', () => {
    saveAccount(account)

    expect(savedAccount()).toEqual(account)
  })

  it.each([
    ['nothing saved', null],
    ['JSON that does not parse', '{"id":'],
    ['a value that is not an object', '"excited egret 387"'],
    ['an unknown kind', JSON.stringify({ ...account, kind: 'admin' })],
    ['a player without a name', JSON.stringify({ ...account, player: { id: account.player.id } })],
    ['no permissions', JSON.stringify({ ...account, permissions: undefined })],
  ])('returns null for %s', (_, saved) => {
    if (saved !== null) localStorage.setItem('fortymm.session', saved)

    expect(savedAccount()).toBeNull()
  })
})
