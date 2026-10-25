import { cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { HomePage } from '../test/pages/HomePage'

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
