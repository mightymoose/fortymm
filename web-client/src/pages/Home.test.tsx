import { cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import { HomePage } from '../test/pages/HomePage'
import { http, HttpResponse } from 'msw'
import { API_BASE_URL, server, sessionResponse } from '../test/server'
import { signInPromptDesigns } from './signInPromptDesigns'

describe('Home', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('lists the parts of FortyMM in the order they ship, each with its stage', async () => {
    const homePage = await HomePage.render()

    expect(homePage.title).toHaveTextContent('What’s coming, and when.')
    expect(homePage.parts).toEqual([
      { name: 'Your account', stage: 'Building now' },
      { name: 'Leagues', stage: 'Next' },
      { name: 'Matches', stage: 'Later' },
      { name: 'Basic tournaments', stage: 'Later' },
    ])
  })

  it('shows Home as the open page in the sidebar, with no link to the design system', async () => {
    const homePage = await HomePage.render()

    expect(homePage.homeLink).toHaveAttribute('aria-current', 'page')
    expect(homePage.designSystemLink).not.toBeInTheDocument()
  })

  it("shows the visitor's player as an avatar of their initials", async () => {
    const homePage = await HomePage.render()

    const { display_name } = sessionResponse.data.account.player!
    expect(homePage.avatar(display_name)).toHaveTextContent(/^EE$/)
  })

  it('asks a guest to sign in, back to Home', async () => {
    const homePage = await HomePage.render()

    expect(homePage.signInLink).toHaveAttribute('href', '/api/v1/auth/login?return_to=/')
  })

  it.each(signInPromptDesigns)('asks a guest to sign in in the %s design', async (design) => {
    const homePage = await HomePage.renderWithPrompt(design)

    expect(homePage.signInLink).toHaveAttribute('href', '/api/v1/auth/login?return_to=/')
    expect(homePage.title).toHaveTextContent('What’s coming, and when.')
  })

  it('shows no avatar for an account with no player', async () => {
    const verified: components['schemas']['SessionResponse'] = {
      data: {
        account: {
          ...sessionResponse.data.account,
          kind: 'verified',
          email: 'ann@example.com',
          player: null,
        },
      },
    }
    server.use(http.post(`${API_BASE_URL}/v1/session`, () => HttpResponse.json(verified)))

    const homePage = await HomePage.render()

    expect(homePage.title).toBeInTheDocument()
    expect(homePage.avatar('excited egret 387')).not.toBeInTheDocument()
    expect(homePage.signInLink).not.toBeInTheDocument()
  })

  it('folds the sidebar to its icons and remembers it on the next visit', async () => {
    const homePage = await HomePage.render()
    expect(homePage.sidebarLabelsButton).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(homePage.sidebarLabelsButton)
    expect(homePage.sidebarLabelsButton).toHaveAttribute('aria-expanded', 'false')
    expect(homePage.homeLink).toBeInTheDocument()

    cleanup()
    const nextVisit = await HomePage.render()
    expect(nextVisit.sidebarLabelsButton).toHaveAttribute('aria-expanded', 'false')
  })
})
