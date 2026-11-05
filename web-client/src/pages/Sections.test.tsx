import { cleanup, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomePage } from '../test/pages/HomePage'
import { SectionPage } from '../test/pages/SectionPage'
import { grantSession } from '../test/server'

function layout(narrow: boolean) {
  vi.stubGlobal('matchMedia', () => ({
    matches: narrow,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

describe('Matches and Players', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['/matches', 'Matches', 'matches.view'],
    ['/players', 'Players', 'players.view'],
  ] as const)('%s shows its title and is the open page', async (path, name, permission) => {
    grantSession(permission)
    const page = await SectionPage.render(path)

    expect(page.path).toBe(path)
    expect(page.title).toHaveTextContent(name)
    expect(page.link(name)).toHaveAttribute('aria-current', 'page')
  })

  it.each(['/matches', '/players'] as const)(
    '%s sends an account without its permission to Home',
    async (path) => {
      const page = await SectionPage.render(path)

      expect(page.path).toBe('/')
    },
  )

  it('lists each in the sidebar only for an account that may see it', async () => {
    const home = await HomePage.render()
    expect(home.matchesLink).toBeNull()
    expect(home.playersLink).toBeNull()
    cleanup()

    grantSession('matches.view', 'players.view')
    const admin = await HomePage.render()
    expect(admin.matchesLink).toHaveAttribute('href', '/matches')
    expect(admin.playersLink).toHaveAttribute('href', '/players')
  })
})

describe('New match below 900px', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('moves from Home to the tab bar', async () => {
    grantSession('matches.create')
    layout(true)
    const home = await HomePage.render()

    expect(within(home.nav).getByRole('link', { name: 'New match' })).toHaveAttribute(
      'href',
      '/matches/new',
    )
    expect(home.newMatchLink).toBe(within(home.nav).getByRole('link', { name: 'New match' }))
  })

  it('stays on Home, out of the sidebar, at 900px and over', async () => {
    grantSession('matches.create')
    layout(false)
    const home = await HomePage.render()

    expect(home.newMatchLink).toBeInTheDocument()
    expect(within(home.nav).queryByRole('link', { name: 'New match' })).toBeNull()
  })

  it('is not in the tab bar for an account without matches.create', async () => {
    layout(true)
    const home = await HomePage.render()

    expect(home.newMatchLink).toBeNull()
  })
})
