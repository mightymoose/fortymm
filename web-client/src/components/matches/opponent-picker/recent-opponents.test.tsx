import { HttpResponse, delay } from 'msw'
import userEvent from '@testing-library/user-event'

import { buildPlayer } from '@/mocks/factories/players/player.factory'

import { recentOpponentsPage } from './recent-opponents.page'

describe('RecentOpponents', () => {
  it('shows the loading skeleton while recent opponents load, then the chips', async () => {
    recentOpponentsPage.mockRecent(async () => {
      await delay(40)
      return HttpResponse.json([buildPlayer({ username: 'ada.lovelace' })])
    })
    recentOpponentsPage.render()

    expect(recentOpponentsPage.queryLoading()).toBeInTheDocument()
    await recentOpponentsPage.findChip(/ada\.lovelace/)
    expect(recentOpponentsPage.queryLoading()).not.toBeInTheDocument()
  })

  it('names each chip by the player + role, without the decorative avatar (#99)', async () => {
    recentOpponentsPage.mockRecent(() =>
      HttpResponse.json([
        buildPlayer({ id: 'pl-1', username: 'grace.hopper', rating: 1500 }),
      ]),
    )
    recentOpponentsPage.render()

    // Recent chips always read as "registered player", and the "GR" initials
    // are not part of the accessible name.
    const chip = await recentOpponentsPage.findChip(
      'grace.hopper, REGISTERED PLAYER',
    )
    expect(chip).toHaveAccessibleName('grace.hopper, REGISTERED PLAYER')
  })

  it('renders a readable fallback name for a blank username (#101)', async () => {
    recentOpponentsPage.mockRecent(() =>
      HttpResponse.json([buildPlayer({ id: 'pl-1', username: '' })]),
    )
    recentOpponentsPage.render()

    expect(
      await recentOpponentsPage.findChip('Unnamed player, REGISTERED PLAYER'),
    ).toBeInTheDocument()
  })

  it('picks the player when a chip is clicked', async () => {
    const user = userEvent.setup()
    let picked: string | null = null
    recentOpponentsPage.mockRecent(() =>
      HttpResponse.json([buildPlayer({ id: 'pl-1', username: 'ada.lovelace' })]),
    )
    recentOpponentsPage.render({ onPick: (p) => (picked = p.username) })

    await user.click(await recentOpponentsPage.findChip(/ada\.lovelace/))
    expect(picked).toBe('ada.lovelace')
  })

  it('switches to search when "Search all players" is clicked', async () => {
    const user = userEvent.setup()
    let searched = false
    recentOpponentsPage.mockRecent(() =>
      HttpResponse.json([buildPlayer({ id: 'pl-1', username: 'ada.lovelace' })]),
    )
    recentOpponentsPage.render({ onSearchAll: () => (searched = true) })

    await recentOpponentsPage.findChip(/ada\.lovelace/)
    await user.click(recentOpponentsPage.querySearchAll()!)
    expect(searched).toBe(true)
  })

  it('shows an empty state and hides search when nobody else exists', async () => {
    recentOpponentsPage.mockRecent(() => HttpResponse.json([]))
    recentOpponentsPage.render()

    await recentOpponentsPage.findEmpty()
    expect(recentOpponentsPage.querySearchAll()).not.toBeInTheDocument()
  })
})
