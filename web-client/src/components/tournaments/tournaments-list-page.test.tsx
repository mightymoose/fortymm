import userEvent from '@testing-library/user-event'

import { buildTournament } from './data/seed.factory'
import { tournamentsListPagePage } from './tournaments-list-page.page'

describe('TournamentsListPage', () => {
  it('filters the grid by search query', async () => {
    tournamentsListPagePage.render()
    expect(tournamentsListPagePage.getCard('Bay Area Open 2026')).toBeInTheDocument()

    await userEvent.type(tournamentsListPagePage.getSearch(), 'Winter')

    expect(tournamentsListPagePage.queryCard('Bay Area Open 2026')).toBeNull()
    expect(tournamentsListPagePage.getCard('Winter Classic 2025')).toBeInTheDocument()
  })

  it('filters the grid by status tab', async () => {
    tournamentsListPagePage.render()
    await userEvent.click(tournamentsListPagePage.getStatusTab('Drafts'))

    expect(tournamentsListPagePage.queryCard('Bay Area Open 2026')).toBeNull()
    expect(tournamentsListPagePage.getCard('Summer Slam 2026')).toBeInTheDocument()
  })

  it('opens a tournament when its card is clicked', async () => {
    const onOpen = vi.fn()
    tournamentsListPagePage.render({
      tournaments: [buildTournament({ id: 'bay', name: 'Bay Area Open 2026' })],
      onOpen,
    })

    await userEvent.click(tournamentsListPagePage.getCard('Bay Area Open 2026'))
    expect(onOpen).toHaveBeenCalledWith('bay')
  })

  it('confirms then deletes from the card delete control', async () => {
    const onDelete = vi.fn()
    tournamentsListPagePage.render({
      tournaments: [buildTournament({ id: 'bay', name: 'Bay Area Open 2026' })],
      onDelete,
    })

    await userEvent.click(tournamentsListPagePage.getDeleteButton('Bay Area Open 2026'))
    await userEvent.click(tournamentsListPagePage.getConfirmDeleteButton())
    expect(onDelete).toHaveBeenCalledWith('bay')
  })
})
