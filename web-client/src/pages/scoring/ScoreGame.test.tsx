import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ErrorPage } from '../../test/pages/ErrorPage'
import { ScoreGamePage } from '../../test/pages/ScoreGamePage'

const ME = 'excited egret 387'
const OPPONENT = 'brave badger 214'

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

  it('shows the match loading, then the pad', async () => {
    const page = await ScoreGamePage.render(undefined, { settle: false })

    expect(screen.getByLabelText('Loading the match')).toBeInTheDocument()

    await page.settle()

    expect(page.input(ME)).toBeInTheDocument()
  })

  it('says when the match cannot load, and loads it on Try again', async () => {
    const page = await ScoreGamePage.render('/matches/demo/scores/game/1/edit?network=offline')

    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('Can’t reach FortyMM')

    await page.reconnect()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await page.settle()

    expect(page.input(ME)).toBeInTheDocument()
  })

  it('shows a save in flight and keeps the inputs focused', async () => {
    const page = await ScoreGamePage.render()
    await page.enter({ [ME]: '11', [OPPONENT]: '3' })

    await userEvent.click(page.saveButton!)

    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true')
    expect(page.input(ME)).toHaveAttribute('readonly')
    await page.settle()
    expect(page.slotScore(1)).toBe('11–3')
  })

  it('keeps the score after a failed save, and saves it on Try again', async () => {
    const page = await ScoreGamePage.render()
    await page.switchNetwork('broken')
    await page.enter({ [ME]: '11', [OPPONENT]: '9' })

    await page.save()

    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t save game 1')
    expect(page.slotScore(1)).toBe('–')
    expect(page.input(ME)).toHaveValue('11')

    await page.reconnect()
    await page.click('Try again')

    expect(page.slotScore(1)).toBe('11–9')
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

    expect(page.toasts).toContain('Game 1 saved. 11–7.')
    expect(page.slotScore(1)).toBe('7–11')
    expect(page.slotWinner(1)).toBe('11')
    expect(page.tally).toBe('0–1')
    expect(page.href).toBe('/matches/demo/scores/game/2/edit')
    expect(page.heading).toHaveTextContent('Game 2')
    expect(page.input(ME)).toHaveValue('')

    await page.goToGame(1)
    expect(page.input(ME)).toHaveValue('7')
    expect(page.text).toContain(`Saved by ${ME}`)
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


  it('names the games entered after the decider in the review', async () => {
    const page = await ScoreGamePage.render()
    await saveGame(page, 1, '11', '1')
    await saveGame(page, 2, '11', '2')
    await saveGame(page, 3, '11', '3')
    await saveGame(page, 5, '4', '11')

    expect(page.text).toContain('Match decided after game 3')
    await page.click('Review result')

    expect(page.review).toHaveTextContent('The match was decided after game 3, but game 5 has a score.')
    expect(within(page.review).getByRole('link', { name: 'Go to game 5' })).toBeInTheDocument()
    expect(within(page.review).queryByRole('button', { name: 'Submit result' })).toBeNull()
  })

  it('says who has how many games while nobody has won', async () => {
    const page = await ScoreGamePage.render()
    await saveGame(page, 1, '11', '1')

    await page.click('Review result')

    expect(page.review).toHaveTextContent(
      `${ME} has 1 game and ${OPPONENT} has 0 games. Nobody has won 3 games yet.`,
    )
  })

  it('submits a decided result and freezes the board', async () => {
    const page = await ScoreGamePage.render()
    await saveGame(page, 1, '11', '5')
    await saveGame(page, 2, '8', '11')
    await saveGame(page, 4, '11', '9')
    await saveGame(page, 5, '13', '11')

    await page.click('Review result')
    expect(page.review).toHaveTextContent(`${ME} wins 3–1`)
    expect(page.review).toHaveTextContent('Empty games were left out')
    await page.click('Submit result')

    expect(page.result).toHaveTextContent(`Submitted by ${ME}. ${ME} wins 3–1.`)
    expect(page.result).toHaveTextContent(`Waiting for ${OPPONENT}`)
    expect(page.input(ME)).toBeDisabled()
    expect(page.saveButton).toBeNull()
    expect(page.button('Clear game')).toBeNull()
    expect(page.button('Review result')).toBeNull()

    await page.click('Edit scores')
    expect(page.input(ME)).toBeEnabled()
    expect(page.button('Clear game')).toBeInTheDocument()
  })

  it('lets a spectator edit but not submit', async () => {
    const page = await ScoreGamePage.render('/matches/demo-spectator/scores/game/1/edit')

    expect(page.sides).toEqual(['calm crane 552', 'gentle gecko 731'])
    expect(page.button('Review result')).toBeNull()
    expect(page.result).toHaveTextContent(
      'calm crane 552 or gentle gecko 731 submits the result when the match ends.',
    )

    await page.enter({ 'calm crane 552': '11', 'gentle gecko 731': '6' })
    await page.save()
    expect(page.slotScore(1)).toBe('11–6')
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
