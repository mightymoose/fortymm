import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomePage } from '../../test/pages/HomePage'
import { MatchesPage } from '../../test/pages/MatchesPage'
import { NewMatchPage } from '../../test/pages/NewMatchPage'
import { ScoreGamePage } from '../../test/pages/ScoreGamePage'
import { API_BASE_URL, grantSession, mockMatches, server, sessionResponse } from '../../test/server'

const self = sessionResponse.data.account.player
const badger = { id: '6f1d2c43-8b5e-4a0f-9c71-2e4b8d0a5f13', display_name: 'brave badger 214' }
const crane = { id: '0c9e7b21-3d4a-4f68-a1b5-7e2f9c8d6a40', display_name: 'calm crane 552' }
const gecko = { id: 'a4d8f0e6-1b2c-4e3d-8f5a-9c7b6e1d2f08', display_name: 'gentle gecko 731' }
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('NewMatch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the player and their recent opponents', async () => {
    mockMatches({ recent: [badger, crane] })
    const page = await NewMatchPage.render()

    expect(page.heading).toHaveTextContent('New match')
    expect(page.text).toContain(`You${self.display_name}`)
    expect(await page.findRecent()).toEqual([badger.display_name, crane.display_name])
  })

  it('shows a skeleton while the recent opponents load', async () => {
    const mock = mockMatches({ recent: [badger], holdRecent: true })
    const page = await NewMatchPage.render()

    expect(page.recentSkeleton).toBeInTheDocument()
    await mock.release()
    expect(await page.findRecent()).toEqual([badger.display_name])
    expect(page.recentSkeleton).toBeNull()
  })

  it('shows an error with Try again when the recent opponents fail, and the rest of the page still works', async () => {
    const mock = mockMatches({ recent: [badger] })
    mock.recentFails = true
    const page = await NewMatchPage.render()

    const alert = await page.findAlert('Something went wrong')
    await page.searchAll()
    expect(page.searchBox).toHaveFocus()
    await page.backToRecent()
    expect(await page.findAlert('Something went wrong')).toBeInTheDocument()

    mock.recentFails = false
    await screen.getByRole('button', { name: 'Try again' }).click()
    expect(await page.findRecent()).toEqual([badger.display_name])
    expect(alert).not.toBeInTheDocument()
  })

  it('points a player with no recent opponents at the search', async () => {
    mockMatches({ recent: [], everyone: [gecko] })
    const page = await NewMatchPage.render()

    expect(await screen.findByText('No opponents yet')).toBeInTheDocument()
    await page.searchAll()
    await page.search('gecko')
    expect(await page.findResults()).toEqual([gecko.display_name])
  })

  it('searches every player, and goes back to the recent opponents', async () => {
    const mock = mockMatches({ recent: [badger], everyone: [badger, crane, gecko] })
    const page = await NewMatchPage.render()
    await page.findRecent()

    await page.searchAll()
    expect(page.text).toContain('Type part of a player’s name.')
    await page.search('gen')
    expect(await page.findResults()).toEqual([gecko.display_name])
    await page.search('x')
    expect(await screen.findByText('No players match “genx”. Check the spelling.')).toBeInTheDocument()
    // The search waits for a pause in typing, so it never asks for "g".
    expect(mock.searches).toEqual(['gen', 'genx'])

    await page.backToRecent()
    expect(await page.findRecent()).toEqual([badger.display_name])
    expect(page.searchAllButton).toHaveFocus()
  })

  it('picks an opponent, and Change picks another', async () => {
    mockMatches({ recent: [badger, crane] })
    const page = await NewMatchPage.render()
    await page.findRecent()
    expect(page.summary[0]).toBe('Pick an opponent to start.')

    await page.pick(badger.display_name)
    expect(page.picked).toBe(badger.display_name)
    expect(page.changeButton).toHaveFocus()
    expect(page.summary).toEqual([
      `Ready: You vs ${badger.display_name}`,
      'Best of 5 · first to 3 · Unrated · games to 11, win by 2',
    ])

    await page.change()
    expect(page.picked).toBeNull()
    expect(page.searchAllButton).toHaveFocus()
    await page.pick(crane.display_name)
    expect(page.picked).toBe(crane.display_name)
  })

  it('picks a match length with the arrow keys, Home and End', async () => {
    mockMatches()
    const page = await NewMatchPage.render()
    expect(page.length).toBe('5 Std')
    expect(page.lengthHelp).toBe('First to 3 games.')

    page.lengthOption('5 Std').focus()
    await page.pressKey('{ArrowRight}')
    expect(page.length).toBe('7 Long')
    expect(page.lengthOption('7 Long')).toHaveFocus()
    await page.pressKey('{ArrowRight}')
    expect(page.length).toBe('1 Single')
    expect(page.lengthHelp).toBe('One game, winner takes all.')
    expect(page.summary[1]).toBe('Single game · Unrated · games to 11, win by 2')
    await page.pressKey('{End}')
    expect(page.length).toBe('7 Long')
    await page.pressKey('{Home}')
    expect(page.length).toBe('1 Single')
    await page.pressKey('{ArrowLeft}')
    expect(page.length).toBe('7 Long')
    expect(page.lengthOption('5 Std')).toHaveAttribute('tabindex', '-1')
    expect(page.lengthOption('7 Long')).toHaveAttribute('tabindex', '0')
  })

  it('makes a match rated only once an opponent is picked, and Change makes it unrated', async () => {
    mockMatches({ recent: [badger, crane] })
    const page = await NewMatchPage.render()
    await page.findRecent()
    expect(page.ratedSwitch).toBeDisabled()
    expect(page.ratedSwitch).toHaveAccessibleDescription('Pick an opponent to make this rated.')

    await page.pick(badger.display_name)
    expect(page.ratedSwitch).toBeEnabled()
    await page.toggleRated()
    expect(page.ratedSwitch).toBeChecked()
    expect(page.summary[1]).toBe('Best of 5 · first to 3 · Rated · games to 11, win by 2')

    await page.change()
    expect(page.ratedSwitch).not.toBeChecked()
    await page.pick(crane.display_name)
    expect(page.ratedSwitch).not.toBeChecked()
  })

  it('says to pick an opponent when Start match has none, and sends nothing', async () => {
    const mock = mockMatches({ recent: [badger] })
    const page = await NewMatchPage.render()
    await page.findRecent()

    await page.start()
    expect(page.alerts).toEqual(['Pick an opponent to start the match.'])
    expect(page.startButton).toHaveAccessibleDescription('Pick an opponent to start the match.')
    expect(mock.creates).toEqual([])

    await page.pick(badger.display_name)
    expect(page.alerts).toEqual([])
  })

  it('makes the match and opens its scores', async () => {
    const mock = mockMatches({ recent: [badger] })
    const page = await NewMatchPage.render()
    await page.findRecent()
    await page.pick(badger.display_name)
    page.lengthOption('3 Short').click()
    await page.toggleRated()

    await page.start()

    await waitFor(() => expect(page.pathname).toMatch(/\/scores\/game\/1\/edit$/))
    expect(mock.creates).toHaveLength(1)
    const [{ id, ...details }] = mock.creates
    expect(id).toMatch(UUIDV7)
    expect(details).toEqual({ best_of: 3, rated: true, players: [self.id, badger.id] })
    expect(page.pathname).toBe(`/matches/${id}/scores/game/1/edit`)
    const scores = new ScoreGamePage(page.router)
    expect(await screen.findByRole('heading', { level: 1, name: 'Game 1' })).toBeInTheDocument()
    expect(scores.sides).toEqual(['You', 'Your opponent'])
  })

  it('opens the match afresh with Back from game 1, not the read made before its board', async () => {
    mockMatches({ recent: [badger] })
    grantSession('matches.create', 'matches.view')
    const reads: string[] = []
    let hold = false
    let answer = () => {}
    server.use(
      http.get<{ matchId: string }>(`${API_BASE_URL}/v1/matches/:matchId`, async ({ params }) => {
        if (params.matchId === 'opponents') return undefined
        reads.push(params.matchId)
        if (hold) await new Promise<void>((resolve) => (answer = resolve))
        return HttpResponse.json({ errors: [{ status: '404', title: 'No match has this id' }] }, { status: 404 })
      }),
    )
    const page = await NewMatchPage.render()
    await page.findRecent()
    await page.pick(badger.display_name)
    await page.start()
    expect(await screen.findByRole('heading', { level: 1, name: 'Game 1' })).toBeInTheDocument()
    await waitFor(() => expect(reads).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))

    hold = true
    await act(async () => page.router.history.back())

    const match = new MatchesPage(page.router)
    await waitFor(() => expect(match.path).toBe(`/matches/${reads[0]}`))
    expect(match.loading).toBeInTheDocument()
    await act(async () => answer())
  })

  it('opens the scores of the match it made from the URL alone when a reload can’t reach the API', async () => {
    mockMatches({ recent: [badger] })
    const page = await NewMatchPage.render()
    await page.findRecent()
    await page.pick(badger.display_name)
    page.lengthOption('3 Short').click()
    await page.start()
    await waitFor(() => expect(page.pathname).toMatch(/\/scores\/game\/1\/edit$/))
    const scoresUrl = new ScoreGamePage(page.router).href
    cleanup()

    const scores = await ScoreGamePage.render(scoresUrl)

    expect(scores.heading).toHaveTextContent('Game 1')
    expect(scores.gameCount).toBe(3)
    expect(scores.sides).toEqual(['You', 'Your opponent'])
  })

  it('opens nothing when the person leaves before the match is made', async () => {
    mockMatches({ recent: [badger] })
    let answer = () => {}
    server.use(
      http.post(`${API_BASE_URL}/v1/matches`, async ({ request }) => {
        const { id } = (await request.json()) as { id: string }
        await new Promise<void>((resolve) => (answer = resolve))
        return HttpResponse.json({ data: { id } }, { status: 201 })
      }),
    )
    const page = await NewMatchPage.render()
    await page.findRecent()
    await page.pick(badger.display_name)
    await page.start()

    await page.router.navigate({ to: '/' })
    answer()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(page.pathname).toBe('/')
  })

  it('shows the API’s reason when it refuses the match', async () => {
    const mock = mockMatches({
      recent: [badger],
      create: { refused: 'A player of the match doesn’t exist' },
    })
    const page = await NewMatchPage.render()
    await page.findRecent()
    await page.pick(badger.display_name)

    await page.start()

    expect(await page.findAlert('A player of the match doesn’t exist')).toBeInTheDocument()
    expect(page.pathname).toBe('/matches/new')
    expect(page.startButton).toHaveTextContent('Start match')
    expect(mock.creates).toHaveLength(1)
  })

  it('sends the same match again after no response came back', async () => {
    const mock = mockMatches({ recent: [badger], create: 'unreachable' })
    const page = await NewMatchPage.render()
    await page.findRecent()
    await page.pick(badger.display_name)

    await page.start()
    expect(await page.findAlert('Making a match needs a connection.')).toBeInTheDocument()

    mock.create = 'created'
    await page.start()
    await waitFor(() => expect(page.pathname).toMatch(/\/scores\/game\/1\/edit$/))
    expect(mock.creates).toHaveLength(2)
    expect(mock.creates[1].id).toBe(mock.creates[0].id)
  })

  it('sends a new match id once the details change', async () => {
    const mock = mockMatches({ recent: [badger], create: 'unreachable' })
    const page = await NewMatchPage.render()
    await page.findRecent()
    await page.pick(badger.display_name)
    await page.start()
    await page.findAlert('Making a match needs a connection.')

    page.lengthOption('7 Long').click()
    await page.start()
    await waitFor(() => expect(mock.creates).toHaveLength(2))
    expect(mock.creates[1].id).not.toBe(mock.creates[0].id)
  })

  it('says a match needs a connection when the browser is offline, and sends nothing until it is back', async () => {
    const mock = mockMatches({ recent: [badger] })
    const page = await NewMatchPage.render()
    await page.findRecent()
    await page.pick(badger.display_name)
    page.lengthOption('3 Short').click()
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    await page.start()

    expect(page.alerts).toEqual(['Making a match needs a connection. Connect, then press Start match again.'])
    expect(mock.creates).toEqual([])
    expect(page.picked).toBe(badger.display_name)
    expect(page.length).toBe('3 Short')

    onLine.mockRestore()
    await page.start()
    await waitFor(() => expect(page.pathname).toMatch(/\/scores\/game\/1\/edit$/))
    expect(mock.creates).toHaveLength(1)
  })

  it('shows the failure message for an API that answers 500', async () => {
    const mock = mockMatches({ recent: [badger], create: { refused: 'broken', status: 500 } })
    const page = await NewMatchPage.render()
    await page.findRecent()
    await page.pick(badger.display_name)

    await page.start()

    expect(await page.findAlert('Something went wrong')).toBeInTheDocument()
    expect(mock.creates).toHaveLength(1)
  })

  it('goes back to Home with Cancel', async () => {
    mockMatches()
    const page = await NewMatchPage.render()

    expect(page.cancelLink).toHaveAttribute('href', '/')
  })

  it('is linked from Home', async () => {
    mockMatches()
    const home = await HomePage.render()

    expect(home.newMatchLink).toHaveAttribute('href', '/matches/new')
  })

  it('is only for an account with matches.create', async () => {
    const home = await HomePage.render()
    expect(home.newMatchLink).toBeNull()
    cleanup()

    const page = await NewMatchPage.render()

    await waitFor(() => expect(page.pathname).toBe('/'))
  })
})
