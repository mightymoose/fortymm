import { fireEvent, within } from '@/test/utilities'

import {
  matchDetailRoute,
  scoringNewRoute,
} from '@/api/matches'
import type { NavigateFn } from '../match-list-status'

import { buildMatchListRowView } from './match-list-row.factory'
import { matchListRowPage } from './match-list-row.page'

describe('MatchListRow', () => {
  it('renders as a clickable role=link tr with the composed aria-label', async () => {
    // Wiring only: the label text is pre-projected onto the view.
    matchListRowPage.render({
      row: buildMatchListRowView({ ariaLabel: 'Open match: a & b vs No opponent' }),
    })

    const row = await matchListRowPage.findRow('Open match: a & b vs No opponent')
    expect(row.tagName).toBe('TR')
    expect(row).toHaveAttribute('role', 'link')
    expect(row).toHaveAttribute('tabindex', '0')
  })

  it('calls navigate with the detail route on click and on Enter/Space keydown', async () => {
    const navigate = vi.fn() as unknown as NavigateFn
    const detailRoute = matchDetailRoute('m-9')
    matchListRowPage.render({
      navigate,
      row: buildMatchListRowView({ id: 'm-9', detailRoute }),
    })

    const row = await matchListRowPage.findRow()
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })

    expect(navigate).toHaveBeenCalledTimes(3)
    expect(navigate).toHaveBeenNthCalledWith(1, detailRoute)
    expect(navigate).toHaveBeenNthCalledWith(2, detailRoute)
    expect(navigate).toHaveBeenNthCalledWith(3, detailRoute)
  })

  it('preloads the detail route on mouseEnter and focus', async () => {
    const detailRoute = matchDetailRoute('m-9')
    const { router } = matchListRowPage.render({
      row: buildMatchListRowView({ id: 'm-9', detailRoute }),
    })
    const preloadRoute = vi
      .spyOn(router, 'preloadRoute')
      .mockResolvedValue(undefined as never)

    const row = await matchListRowPage.findRow()
    fireEvent.mouseEnter(row)
    fireEvent.focus(row)

    expect(preloadRoute).toHaveBeenCalledTimes(2)
    expect(preloadRoute).toHaveBeenNthCalledWith(1, detailRoute)
    expect(preloadRoute).toHaveBeenNthCalledWith(2, detailRoute)
  })

  it('renders the id cell as the shortLabel', async () => {
    // Wiring only: shortLabel is pre-computed on the view.
    matchListRowPage.render({
      row: buildMatchListRowView({ shortLabel: 'M-ABC123' }),
    })

    await matchListRowPage.findRow()
    expect(matchListRowPage.getIdCell('M-ABC123')).toHaveClass('id-cell')
  })

  it('adds the is-live class when row.isLive', async () => {
    matchListRowPage.render({ row: buildMatchListRowView({ isLive: true }) })

    const row = await matchListRowPage.findRow()
    expect(row).toHaveClass('is-clickable', 'is-live')
  })

  it('omits the is-live class when the row is not live', async () => {
    matchListRowPage.render({ row: buildMatchListRowView({ isLive: false }) })

    const row = await matchListRowPage.findRow()
    expect(row).toHaveClass('is-clickable')
    expect(row).not.toHaveClass('is-live')
  })

  it('wires both player chips, the score cell, status badge and time cell', async () => {
    // Wiring only: each child's internals are pinned by its own tests; here we
    // assert the row composed them against the right views.
    matchListRowPage.render({
      row: buildMatchListRowView({
        side1: { name: 'rita.kovac', isEmpty: false, isWinner: true },
        side2: { name: 'nguyen.t', isEmpty: false, isWinner: false },
        score: { games: '2–1' },
        status: { label: 'Final', toneClass: 'status-tone-final', isLive: false },
        time: { when: '5d ago' },
      }),
    })

    const row = await matchListRowPage.findRow()
    const scoped = matchListRowPage.within(within(row))
    expect(scoped.getPlayerName('rita.kovac')).toHaveClass('is-winner')
    expect(scoped.getPlayerName('nguyen.t')).not.toHaveClass('is-winner')
    expect(scoped.getGamesScore()).toHaveTextContent('2–1')
    expect(scoped.getBadge('Final')).toHaveClass('status-tone-final')
    expect(scoped.getWhen('5d ago')).toHaveTextContent('5d ago')
  })

  it('renders the action Link to its route when action is non-null, stopping row-click propagation from that cell', async () => {
    const navigate = vi.fn() as unknown as NavigateFn
    const route = scoringNewRoute('m-9', 3)
    matchListRowPage.render({
      navigate,
      row: buildMatchListRowView({
        id: 'm-9',
        action: { label: 'Enter score', route, primary: true },
      }),
    })

    await matchListRowPage.findRow()
    const link = matchListRowPage.getActionLink('Enter score')
    expect(link).toHaveAttribute('href', '/matches/m-9/games/3/scores/new')

    // Clicking the trailing cell must not bubble up to the row's navigate.
    fireEvent.click(link)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('renders no action Link when action is null', async () => {
    matchListRowPage.render({
      row: buildMatchListRowView({ action: null }),
    })

    await matchListRowPage.findRow()
    expect(matchListRowPage.queryActionLink('Enter score')).toBeNull()
  })
})
