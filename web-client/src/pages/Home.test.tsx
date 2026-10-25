import { cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { HomePage } from '../test/pages/HomePage'
import { sessionResponse } from '../test/server'

describe('Home', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('shows the FortyMM title', async () => {
    const homePage = await HomePage.render()

    expect(homePage.title).toHaveTextContent('FortyMM')
  })

  it('shows Home as the open page in the sidebar, with no link to the design system', async () => {
    const homePage = await HomePage.render()

    expect(homePage.homeLink).toHaveAttribute('aria-current', 'page')
    expect(homePage.designSystemLink).not.toBeInTheDocument()
  })

  it("shows the visitor's player as an avatar of their initials", async () => {
    const homePage = await HomePage.render()

    const { display_name } = sessionResponse.data.account.player
    expect(homePage.avatar(display_name)).toHaveTextContent(/^EE$/)
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
