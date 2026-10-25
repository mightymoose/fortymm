import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ErrorPage } from '../../test/pages/ErrorPage'
import { PlayersPage } from '../../test/pages/PlayersPage'
import { variantSlugs } from './variantSlugs'

describe('Players mockups', () => {
  it('links to each of the five mockups, under Players in the sidebar', async () => {
    const page = await PlayersPage.render('/players')

    expect(page.mockupLinks.map((link) => link.querySelector('b')?.textContent)).toEqual([
      'Ratings table',
      'Cards',
      'Searchable rows',
      'List and player',
      'League ladders',
    ])
    expect(page.sidebarLink).toHaveAttribute('aria-current', 'page')
  })

  it('shows the app’s not-found page for a mockup that doesn’t exist', async () => {
    const page = await ErrorPage.render('/players/nope')

    expect(page.title).toHaveTextContent('We can’t find that page')
  })

  describe.each(variantSlugs)('the %s mockup', (variant) => {
    it('lists the players once they load', async () => {
      const page = await PlayersPage.render(`/players/${variant}`)

      expect(await page.findPlayerLinks('Mara Okafor')).not.toHaveLength(0)
      expect(page.loading).not.toBeInTheDocument()
      expect(page.stateLink('Ready')).toHaveAttribute('aria-current', 'page')
    })

    it('shows a skeleton while the players load', async () => {
      const page = await PlayersPage.render(`/players/${variant}?state=loading`)

      expect(page.loading).toBeInTheDocument()
      expect(page.queryPlayerLinks('Mara Okafor')).toHaveLength(0)
      expect(page.stateLink('Loading')).toHaveAttribute('aria-current', 'page')
    })

    it('says when there are no players', async () => {
      const page = await PlayersPage.render(`/players/${variant}?state=empty`)

      expect(await page.findText('No players yet')).toBeInTheDocument()
    })

    it.each([
      ['error', /^We couldn’t load the/],
      ['unreachable', 'Can’t reach FortyMM'],
      ['rate-limited', 'Wait a minute, then try again'],
    ])('explains a %s answer and offers to try again', async (state, title) => {
      const page = await PlayersPage.render(`/players/${variant}?state=${state}`)

      expect(await page.findAlert()).toHaveTextContent(title)
      expect(page.button('Try again')).toBeInTheDocument()
    })

    it('shows a player’s page with their leagues and matches', async () => {
      const page = await PlayersPage.render(`/players/${variant}/mara-okafor`)

      expect(await page.findHeading('Mara Okafor')).toBeInTheDocument()
      expect(screen.getAllByText(/Riverside winter league/).length).toBeGreaterThan(0)
      expect(screen.getAllByText(/Priya Raman/).length).toBeGreaterThan(0)
    })

    it('shows a skeleton while the player loads', async () => {
      const page = await PlayersPage.render(`/players/${variant}/mara-okafor?state=loading`)

      expect(await page.findLoading('Loading player')).toBeInTheDocument()
    })

    it('shows the player 404 for a player who doesn’t exist', async () => {
      const page = await PlayersPage.render(`/players/${variant}/nobody`)

      expect(await page.findHeading('We can’t find that player')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'See all players' })).toHaveAttribute(
        'href',
        `/players/${variant}`,
      )
      expect(page.sidebarLink).toBeInTheDocument()
    })

    it('shows the player 404 in the not-found state', async () => {
      const page = await PlayersPage.render(`/players/${variant}/mara-okafor?state=not-found`)

      expect(await page.findHeading('We can’t find that player')).toBeInTheDocument()
    })

    it('explains a failed player and offers to try again', async () => {
      const page = await PlayersPage.render(`/players/${variant}/mara-okafor?state=error`)

      expect(await page.findAlert()).toHaveTextContent('We couldn’t load this player')
    })

    it('says a new player is in no league and has no matches', async () => {
      const page = await PlayersPage.render(`/players/${variant}/gentle-gecko-640`)

      expect(await page.findText('Not in a league yet')).toBeInTheDocument()
      if (variant !== 'cards' && variant !== 'ladder') {
        expect(screen.getByText('No matches yet')).toBeInTheDocument()
      }
    })
  })

  it('shows one league at a time in the table, and says when a league has no players', async () => {
    const page = await PlayersPage.render('/players/table')
    await page.findPlayerLinks('Mara Okafor')

    await userEvent.selectOptions(page.leagueSelect, 'Northgate Tuesday league')
    expect(page.queryPlayerLinks('Mara Okafor')).toHaveLength(0)
    expect(page.queryPlayerLinks('Jun Park')).not.toHaveLength(0)

    await userEvent.selectOptions(page.leagueSelect, 'Spring doubles league')
    expect(screen.getByText('No one plays in the Spring doubles league yet')).toBeInTheDocument()
  })

  it('searches the rows by league, and clears a search that matches no one', async () => {
    const page = await PlayersPage.render('/players/rows')
    await page.findPlayerLinks('Mara Okafor')

    await userEvent.type(page.searchBox, 'northgate')
    expect(page.queryPlayerLinks('Jun Park')).not.toHaveLength(0)
    expect(page.queryPlayerLinks('Mara Okafor')).toHaveLength(0)

    await userEvent.clear(page.searchBox)
    await userEvent.type(page.searchBox, 'zzz')
    expect(screen.getByText('No players match “zzz”')).toBeInTheDocument()

    await userEvent.click(page.button('Clear search'))
    expect(page.queryPlayerLinks('Mara Okafor')).not.toHaveLength(0)
  })

  it('keeps the list beside a player who fails to load', async () => {
    const page = await PlayersPage.render('/players/split/mara-okafor?state=error')

    expect(await page.findAlert()).toHaveTextContent('We couldn’t load this player')
    expect(await page.findPlayerLinks('Priya Raman')).not.toHaveLength(0)
  })

  it('gives each league its own ladder', async () => {
    const page = await PlayersPage.render('/players/ladder')
    await page.findPlayerLinks('Mara Okafor')

    await userEvent.click(page.tab('Northgate Tuesday league'))
    expect(screen.getByRole('list', { name: 'Northgate Tuesday league ladder' })).toHaveTextContent(
      'Jun Park',
    )
  })
})
