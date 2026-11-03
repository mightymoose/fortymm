import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { serverKey, setDemoNetwork } from '../../scoring/demoServer'
import { markSent, pendingChanges, readBoard, saveGame as saveOnDevice, storageKey, writeBoard } from '../../scoring/scratchpad'
import { saveAccount } from '../../api/savedSession'
import { ErrorPage } from '../../test/pages/ErrorPage'
import { ScoreGamePage } from '../../test/pages/ScoreGamePage'
import { holdSession, sessionResponse } from '../../test/server'

// The pad names the players to a player as You and Your opponent.
const ME = 'You'
const OPPONENT = 'Your opponent'

async function saveGame(page: ScoreGamePage, game: number, me: string, opponent: string) {
  if (!page.href.endsWith(`/game/${game}/edit`)) await page.goToGame(game)
  await page.enter({ [ME]: me, [OPPONENT]: opponent })
  await page.save()
}

describe('ScoreGame', () => {
  it('shows the match with the viewer on the left', async () => {
    const page = await ScoreGamePage.render()

    expect(page.wordmark).toBeInTheDocument()
    expect(page.homeLink).toHaveAttribute('href', '/')
    expect(page.heading).toHaveTextContent('Game 1')
    expect(page.sides).toEqual([ME, OPPONENT])
    expect(page.tally).toBe('0–0')
    expect(page.slot(1)).toHaveAttribute('aria-current', 'page')
  })

  it('scores as the session’s player when it differs from the saved account', async () => {
    const account = sessionResponse.data.account
    saveAccount({
      ...account,
      player: { id: 'c5a1f0e2-0000-4000-8000-0000000000aa', display_name: 'old otter 111' },
    })
    const session = holdSession()

    const page = await ScoreGamePage.render()
    expect(page.sides).toEqual([ME, OPPONENT])

    await session.respond(Response.json(sessionResponse))
    await act(async () => {})
    await page.enter({ [ME]: '11', [OPPONENT]: '5' })
    await page.save()
    expect(readBoard(storageKey('demo')).games[1].savedBy.playerId).toBe(account.player.id)
  })

  it('focuses the left score when a game opens', async () => {
    const page = await ScoreGamePage.render()

    expect(page.input(ME)).toHaveFocus()
  })

  it('moves to the other score on Enter while it is empty', async () => {
    const page = await ScoreGamePage.render()

    await userEvent.type(page.input(ME), '11{Enter}')

    expect(page.input(OPPONENT)).toHaveFocus()
    expect(page.slotScore(1)).toBe('–')

    await userEvent.type(page.input(OPPONENT), '4{Enter}')
    await page.settle()

    expect(page.slotScore(1)).toBe('11–4')
    expect(page.heading).toHaveTextContent('Game 2')
    expect(page.input(ME)).toHaveFocus()
  })

  it('moves on as soon as a game is saved, and syncs it in the background', async () => {
    const page = await ScoreGamePage.render()
    await page.enter({ [ME]: '11', [OPPONENT]: '3' })

    await userEvent.click(page.saveButton!)

    expect(page.href).toBe('/matches/demo/scores/game/2/edit')
    expect(page.slotSync(1)).toBe('Syncing')
    expect(page.serverScore(1)).toBeNull()

    await page.settle()

    expect(page.slotSync(1)).toBe('Synced')
    expect(page.serverScore(1)).toEqual([11, 3])
  })

  it('keeps scores on the device while offline, and syncs them once back online', async () => {
    const page = await ScoreGamePage.render()
    await page.switchNetwork('offline')

    await page.enter({ [ME]: '11', [OPPONENT]: '9' })
    await page.save()

    expect(page.slotScore(1)).toBe('11–9')
    expect(page.slotSync(1)).toBe('Not synced')
    expect(screen.getByText('Offline. Saved on this device.')).toBeInTheDocument()
    expect(page.serverScore(1)).toBeNull()

    await page.reconnect()

    expect(page.serverScore(1)).toEqual([11, 9])
    expect(page.slotSync(1)).toBe('Synced')
  })

  it('marks a stuck game, and shows it sending as well when it tries again', async () => {
    const page = await ScoreGamePage.render()
    await page.switchNetwork('broken')
    await page.enter({ [ME]: '11', [OPPONENT]: '8' })
    await page.save()

    expect(page.slotSyncMarks(1)).toEqual({ sending: false, stuck: true })

    act(() => setDemoNetwork('normal'))

    await waitFor(() => expect(page.slotSyncMarks(1)).toEqual({ sending: true, stuck: true }))
    await waitFor(() => expect(page.serverScore(1)).toEqual([11, 8]))
    await waitFor(() => expect(page.slotSyncMarks(1)).toEqual({ sending: false, stuck: false }))
  })

  it('sends a stuck score and the edit made after it in order, so the edit wins', async () => {
    const page = await ScoreGamePage.render()
    await page.switchNetwork('broken')
    await page.enter({ [ME]: '11', [OPPONENT]: '8' })
    await page.save()
    await page.goToGame(1)
    await page.enter({ [ME]: '11', [OPPONENT]: '9' })
    await page.save()

    expect(pendingChanges('demo').map(({ edit }) => edit.kind === 'save' && edit.points)).toEqual([
      [11, 8],
      [11, 9],
    ])
    expect(page.slotScore(1)).toBe('11–9')

    const shown = new Set<string>()
    const watch = setInterval(() => shown.add(page.slotScore(1)), 20)
    act(() => setDemoNetwork('normal'))
    await waitFor(() => expect(pendingChanges('demo')).toEqual([]))
    await page.settle()
    clearInterval(watch)

    expect(page.serverScore(1)).toEqual([11, 9])
    expect([...shown]).toEqual(['11–9'])
  })

  it('sends nothing while the browser knows it is offline, and syncs when it comes back', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const page = await ScoreGamePage.render()
    await page.enter({ [ME]: '11', [OPPONENT]: '7' })
    await page.save()
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(page.slotSync(1)).toBe('Not synced')
    expect(page.serverScore(1)).toBeNull()

    onLine.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))

    await waitFor(() => expect(page.serverScore(1)).toEqual([11, 7]))
    onLine.mockRestore()
  })

  it('syncs a score saved offline after the scoring page has closed', async () => {
    const page = await ScoreGamePage.render()
    await page.switchNetwork('offline')
    await page.enter({ [ME]: '11', [OPPONENT]: '5' })
    await page.save()
    expect(page.serverScore(1)).toBeNull()

    await page.router.navigate({ to: '/' })
    act(() => setDemoNetwork('normal'))

    await waitFor(() => expect(readBoard(serverKey('demo')).games[1]?.points).toEqual([11, 5]))
    expect(pendingChanges('demo')).toEqual([])
  })

  it('switches the demo network from the testing panel, and keeps it after a reload', async () => {
    const page = await ScoreGamePage.render()

    await userEvent.click(page.network('Offline'))
    await page.enter({ [ME]: '11', [OPPONENT]: '4' })
    await page.save()

    expect(page.network('Offline')).toHaveAttribute('aria-checked', 'true')
    expect(page.slotSync(1)).toBe('Not synced')

    page.close()
    const reloaded = await ScoreGamePage.render()

    expect(reloaded.network('Offline')).toHaveAttribute('aria-checked', 'true')
    expect(reloaded.serverScore(1)).toBeNull()

    await userEvent.click(reloaded.network('Normal'))
    await reloaded.settle()

    expect(reloaded.serverScore(1)).toEqual([11, 4])
  })

  it('resets the match on the device and the server', async () => {
    const page = await ScoreGamePage.render()
    await saveGame(page, 1, '11', '2')
    await saveGame(page, 2, '11', '3')

    await page.click('Reset match')

    expect(page.href).toBe('/matches/demo/scores/game/1/edit')
    expect([1, 2].map((game) => page.slotScore(game))).toEqual(['–', '–'])
    expect(page.serverScore(1)).toBeNull()
  })

  it('clears every demo match and saved copy', async () => {
    const page = await ScoreGamePage.render()
    await saveGame(page, 1, '11', '2')

    await page.switchNetwork('offline')

    await page.click('Clear everything')

    expect(Object.keys(localStorage).filter((key) => key.startsWith('fortymm-'))).toEqual([])
    expect(page.slotScore(1)).toBe('–')
    expect(page.network('Normal')).toHaveAttribute('aria-checked', 'true')
  })

  it('shows the scores another device synced', async () => {
    writeBoard(serverKey('demo'), {
      games: { 2: { points: [4, 11], savedBy: { playerId: 'someone', name: 'calm crane 552' } } },
      submission: { phase: 'open' },
    })

    const page = await ScoreGamePage.render()

    expect(page.slotScore(2)).toBe('4–11')
  })

  it('keeps the board on this device when the server fails', async () => {
    saveOnDevice('demo', 1, [11, 5], { playerId: 'someone', name: 'calm crane 552' })
    for (const change of pendingChanges('demo')) markSent('demo', change.id)

    setDemoNetwork('broken')
    const page = await ScoreGamePage.render()
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(page.slotScore(1)).toBe('11–5')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('opens an empty board with no connection and nothing saved', async () => {
    setDemoNetwork('offline')
    const page = await ScoreGamePage.render()

    expect(page.input(ME)).toHaveFocus()
    expect([1, 2, 3, 4, 5].map((game) => page.slotScore(game))).toEqual(['–', '–', '–', '–', '–'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('saves a legal game when Enter is pressed in a score', async () => {
    const page = await ScoreGamePage.render()

    await page.enter({ [ME]: '11', [OPPONENT]: '6' })
    await userEvent.type(page.input(OPPONENT), '{Enter}')
    await page.settle()

    expect(page.slotScore(1)).toBe('11–6')
    expect(page.href).toBe('/matches/demo/scores/game/2/edit')
  })

  it('saves nothing when Enter is pressed on an illegal score', async () => {
    const page = await ScoreGamePage.render()

    await page.enter({ [ME]: '11', [OPPONENT]: '10' })
    await userEvent.type(page.input(OPPONENT), '{Enter}')
    await page.settle()

    expect(page.slotScore(1)).toBe('–')
    expect(page.href).toBe('/matches/demo/scores/game/1/edit')
  })

  it('saves a legal game, shows it in the strip and moves to the next game', async () => {
    const page = await ScoreGamePage.render()

    await page.enter({ [ME]: '7', [OPPONENT]: '11' })
    await page.save()

    expect(page.slotScore(1)).toBe('7–11')
    expect(page.slotWinner(1)).toBe('11')
    expect(page.tally).toBe('0–1')
    expect(page.href).toBe('/matches/demo/scores/game/2/edit')
    expect(page.heading).toHaveTextContent('Game 2')
    expect(page.input(ME)).toHaveValue('')

    await page.goToGame(1)
    expect(page.input(ME)).toHaveValue('7')
    expect(page.text).toContain('Saved by you')
  })

  it('shows why an illegal score can’t be saved', async () => {
    const page = await ScoreGamePage.render()

    await page.enter({ [ME]: '11', [OPPONENT]: '10' })

    expect(page.feedback).toBe(
      'At 10–10 the game goes to deuce, so the winner needs a 2-point lead. 11–10 can’t be a final score.',
    )
    expect(page.input(ME)).toHaveAttribute('aria-invalid', 'true')
    expect(page.saveButton).toBeDisabled()

    await page.enter({ [ME]: '12' })
    expect(page.feedback).toBeNull()
    expect(page.saveButton).toBeEnabled()
  })

  it('takes games in any order', async () => {
    const page = await ScoreGamePage.render('/matches/demo/scores/game/4/edit')

    await saveGame(page, 4, '11', '3')
    expect(page.href).toBe('/matches/demo/scores/game/5/edit')
    await saveGame(page, 2, '11', '9')
    expect(page.href).toBe('/matches/demo/scores/game/3/edit')

    expect([1, 2, 3, 4, 5].map((game) => page.slotScore(game))).toEqual(['–', '11–9', '–', '11–3', '–'])
    expect(page.tally).toBe('2–0')
  })

  it('turns Save into Submit result when the score decides the match', async () => {
    const page = await ScoreGamePage.render()
    await saveGame(page, 1, '11', '5')
    await saveGame(page, 2, '8', '11')
    await saveGame(page, 4, '11', '9')
    await page.goToGame(5)

    await page.enter({ [ME]: '9', [OPPONENT]: '11' })
    expect(page.saveButton).toHaveTextContent('Save game 5')

    await page.enter({ [ME]: '13', [OPPONENT]: '11' })
    expect(page.button('Submit result')).toBeInTheDocument()
    expect(page.feedback ?? page.text).toContain('You win 3–1, with the empty games left out')

    await page.click('Submit result')

    expect(page.href).toBe('/matches/demo/scores/submission')
    await page.router.navigate({ to: '/matches/$matchId/scores/game/$gameNumber/edit', params: { matchId: 'demo', gameNumber: '5' } })
    await page.settle()
    expect(page.slotScore(5)).toBe('13–11')
    expect(page.result).toHaveTextContent('Submitted by you. You win 3–1.')
    expect(page.result).toHaveTextContent('Waiting for your opponent')
    expect(page.input(ME)).toBeDisabled()
    expect(page.button('Submit result')).toBeNull()
    expect(page.button('Clear game')).toBeNull()

    await page.click('Edit scores')
    expect(page.input(ME)).toBeEnabled()
    expect(page.button('Clear game')).toBeInTheDocument()
  })

  it('submits a reopened board from a game with nothing new to save', async () => {
    const page = await ScoreGamePage.render()
    await saveGame(page, 1, '11', '1')
    await saveGame(page, 2, '11', '2')
    await page.enter({ [ME]: '11', [OPPONENT]: '3' })
    await page.click('Submit result')
    await page.router.navigate({ to: '/matches/$matchId/scores/game/$gameNumber/edit', params: { matchId: 'demo', gameNumber: '1' } })
    await page.settle()
    await page.click('Edit scores')

    expect(page.saveButton).toBeNull()
    await page.click('Submit result')

    expect(page.href).toBe('/matches/demo/scores/submission')
    expect(readBoard(storageKey('demo')).submission).toMatchObject({
      phase: 'submitted',
      games: [
        [11, 1],
        [11, 2],
        [11, 3],
      ],
    })
  })

  it('says which game to clear when one was played after the decider', async () => {
    const page = await ScoreGamePage.render()
    await saveGame(page, 1, '11', '1')
    await saveGame(page, 2, '11', '2')
    await saveGame(page, 5, '4', '11')
    await saveGame(page, 3, '11', '3')

    expect(page.text).toContain('Match decided after game 3. Clear game 5 to submit.')
    expect(page.button('Submit result')).toBeNull()
  })

  it('lets a spectator edit but not submit', async () => {
    const page = await ScoreGamePage.render('/matches/demo-spectator/scores/game/1/edit')

    expect(page.sides).toEqual(['calm crane 552', 'gentle gecko 731'])
    expect(page.result).toHaveTextContent(
      'calm crane 552 or gentle gecko 731 submits the result when the match ends.',
    )

    for (const game of [1, 2, 3]) {
      if (game > 1) await page.goToGame(game)
      await page.enter({ 'calm crane 552': '11', 'gentle gecko 731': '6' })
      await page.save()
    }
    expect(page.slotScore(3)).toBe('11–6')
    expect(page.button('Submit result')).toBeNull()
  })

  it('shows the not-found page for an unknown match', async () => {
    const page = await ErrorPage.render('/matches/nope/scores/game/1/edit')

    expect(page.title).toHaveTextContent('We can’t find that page')
  })

  it.each(['0', '6', 'two', '1.5'])('sends game %s to game 1', async (game) => {
    const page = await ScoreGamePage.render(`/matches/demo/scores/game/${game}/edit`)

    expect(page.href).toBe('/matches/demo/scores/game/1/edit')
    expect(page.heading).toHaveTextContent('Game 1')
  })
})
