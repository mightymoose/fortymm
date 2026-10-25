import { act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'
import { leavePage } from '../leavePage'
import { HomePage } from '../test/pages/HomePage'
import { API_BASE_URL, logoutResponse, server, sessionResponse } from '../test/server'

vi.mock('../leavePage', () => ({ leavePage: vi.fn() }))

const ann: components['schemas']['SessionResponse'] = {
  data: {
    account: { ...sessionResponse.data.account, kind: 'verified', email: 'ann@example.com' },
  },
}

describe('AccountStrip', () => {
  afterEach(() => {
    vi.mocked(leavePage).mockReset()
  })

  describe('for a guest', () => {
    it('asks them to sign in, and brings them back to this page', async () => {
      const homePage = await HomePage.render()

      expect(homePage.signInStrip).toHaveTextContent(
        'Playing as a guest. Sign in to use this account on any device.',
      )
      expect(homePage.signInLink).toHaveAttribute('href', '/api/v1/auth/login?return_to=%2F')
      expect(homePage.accountStrip).not.toBeInTheDocument()
    })

    it("keeps the page's query in the way back", async () => {
      const homePage = await HomePage.render({ path: '/?tab=leagues' })

      expect(homePage.signInLink).toHaveAttribute(
        'href',
        '/api/v1/auth/login?return_to=%2F%3Ftab%3Dleagues',
      )
    })
  })

  describe('for a verified account', () => {
    beforeEach(() => {
      server.use(http.post(`${API_BASE_URL}/v1/session`, () => HttpResponse.json(ann)))
    })

    it('shows the email, with no sign-in link', async () => {
      const homePage = await HomePage.render()

      expect(homePage.accountStrip).toHaveTextContent('Signed in as ann@example.com.')
      expect(homePage.signInStrip).not.toBeInTheDocument()
    })

    it("signs out, then follows the identity provider's logout page", async () => {
      const homePage = await HomePage.render()

      await userEvent.click(homePage.signOutButton)

      expect(leavePage).toHaveBeenCalledExactlyOnceWith(logoutResponse.data.logout_url)
    })

    it('shows that it is signing out until the API answers', async () => {
      let answer!: (response: Response) => void
      server.use(
        http.post(
          `${API_BASE_URL}/v1/auth/logout`,
          () => new Promise<Response>((resolve) => (answer = resolve)),
        ),
      )
      const homePage = await HomePage.render()

      await userEvent.click(homePage.signOutButton)

      expect(homePage.signOutButton).toHaveTextContent('Signing out…')
      expect(homePage.signOutButton).toHaveAttribute('aria-busy', 'true')
      expect(homePage.signOutButton).toHaveAttribute('aria-disabled', 'true')
      await userEvent.click(homePage.signOutButton)
      await act(async () => answer(HttpResponse.json(logoutResponse)))
      expect(leavePage).toHaveBeenCalledExactlyOnceWith(logoutResponse.data.logout_url)
    })

    it('says so when signing out fails, and lets them try again', async () => {
      server.use(
        http.post(`${API_BASE_URL}/v1/auth/logout`, () => new HttpResponse(null, { status: 500 })),
      )
      const homePage = await HomePage.render()

      await userEvent.click(homePage.signOutButton)

      expect(await homePage.findSignOutError()).toHaveTextContent(
        'Couldn’t sign you out. Check your connection, then try again.',
      )
      expect(leavePage).not.toHaveBeenCalled()
      expect(homePage.signOutButton).toHaveTextContent(/^Sign out$/)
      expect(homePage.signOutButton).not.toHaveAttribute('aria-disabled')

      server.resetHandlers()
      server.use(http.post(`${API_BASE_URL}/v1/session`, () => HttpResponse.json(ann)))
      await userEvent.click(homePage.signOutButton)
      expect(leavePage).toHaveBeenCalledExactlyOnceWith(logoutResponse.data.logout_url)
    })
  })
})
