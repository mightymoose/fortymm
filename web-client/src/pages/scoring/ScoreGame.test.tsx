import { act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/errors'
import { saveAccount } from '../../api/savedSession'
import type { GamePoints } from '../../scoring/board'
import { demoMatch } from '../../scoring/demoMatches'
import { putBoard } from '../../scoring/demoServer'
import { draftHash, nowSeconds, resultOf } from '../../scoring/fragment'
import { apiMatch } from '../../scoring/matches'
import { hex } from '../../signing/bytes'
import { takeKey } from '../../signing/deviceKey'
import { appendSignature, decodeEnvelope, signResult, type Signer } from '../../signing/envelope'
import { decodePayload, encodePayload, resultHash, type MatchResult } from '../../signing/result'
import { base64url, fromBase64url } from '../../signing/text'
import { ErrorPage } from '../../test/pages/ErrorPage'
import { ScoreGamePage } from '../../test/pages/ScoreGamePage'
import { holdSession, sessionResponse } from '../../test/server'

// A send can fail the way the API's can, while the board still lands on the
// demo server by default.
vi.mock('../../scoring/demoServer', async (importOriginal) => {
  const server = await importOriginal<typeof import('../../scoring/demoServer')>()
  return { ...server, putBoard: vi.fn(server.putBoard) }
})

// The pad names the players to a player as You and Your opponent.
const ME = 'You'
const OPPONENT = 'Your opponent'
const player = sessionResponse.data.account.player
const match = demoMatch('demo', { id: player.id, name: player.display_name })
const EDIT = '/matches/demo/scores/game'
const DISCARDED = 'This link’s scores couldn’t be read, so the scores start empty.'

async function saveGame(page: ScoreGamePage, game: number, me: string, opponent: string) {
  if (!page.pathname.endsWith(`/game/${game}/edit`)) await page.goToGame(game)
  await page.enter({ [ME]: me, [OPPONENT]: opponent })
  await page.save()
}

// The result the fragment holds, whether a draft or signed.
function resultIn(hash: string): MatchResult {
  const bytes = fromBase64url(hash)
  try {
    return decodePayload(decodeEnvelope(bytes).payload).result
  } catch {
    return decodePayload(bytes).result
  }
}

// Another device's board, saved `ago` seconds before now.
function boardFrom(games: GamePoints[], ago: number): string {
  return draftHash(match, games, null, nowSeconds() - ago)
}

function draft(games: GamePoints[], replaces: Uint8Array<ArrayBuffer> | null = null): string {
  return draftHash(match, games, replaces, 1_793_700_000)
}

async function otherDevice(): Promise<Signer> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return {
    kid: crypto.getRandomValues(new Uint8Array(32)),
    sign: async (bytes) =>
      new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)),
  }
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
    expect(page.notices).toEqual([])
  })

  it('scores as the session’s player when it differs from the saved account', async () => {
    saveAccount({
      ...sessionResponse.data.account,
      player: { id: 'c5a1f0e2-0000-4000-8000-0000000000aa', display_name: 'old otter 111' },
    })
    const session = holdSession()

    const page = await ScoreGamePage.render()
    expect(page.sides).toEqual([ME, OPPONENT])

    await session.respond(Response.json(sessionResponse))
    await act(async () => {})
    await page.enter({ [ME]: '11', [OPPONENT]: '5' })
    await page.save()
    expect(resultIn(page.hash).players[0]).toBe(player.id)
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

  it('saves nothing when Enter is pressed on an illegal score', async () => {
    const page = await ScoreGamePage.render()

    await page.enter({ [ME]: '11', [OPPONENT]: '10' })
    await userEvent.type(page.input(OPPONENT), '{Enter}')
    await page.settle()

    expect(page.slotScore(1)).toBe('–')
    expect(page.href).toBe(`${EDIT}/1/edit`)
  })

  it('puts the games in the URL, so a reload shows them', async () => {
    const page = await ScoreGamePage.render()
    await saveGame(page, 1, '7', '11')
    await saveGame(page, 2, '11', '9')

    expect(page.pathname).toBe(`${EDIT}/3/edit`)
    expect(resultIn(page.hash)).toMatchObject({
      match: match.uuid,
      players: [player.id, match.players[1].id],
      games: [[7, 11], [11, 9]],
      replaces: null,
    })
    const href = page.href
    page.close()
    const reloaded = await ScoreGamePage.render(href)

    expect(reloaded.heading).toHaveTextContent('Game 3')
    expect([1, 2, 3].map((game) => reloaded.slotScore(game))).toEqual(['7–11', '11–9', '–'])
    expect(reloaded.slotWinner(1)).toBe('11')
    expect(reloaded.tally).toBe('1–1')
  })

  it('opens a saved game with its score, and keeps the games on the strip’s links', async () => {
    const page = await ScoreGamePage.render()
    await saveGame(page, 1, '7', '11')
    const hash = page.hash

    await page.goToGame(1)

    expect(page.hash).toBe(hash)
    expect(page.input(ME)).toHaveValue('7')
    expect(page.text).not.toContain('Saved by')
  })

  it('changes an earlier game in place', async () => {
    const page = await ScoreGamePage.render(`${EDIT}/1/edit#${draft([[11, 3], [3, 11]])}`)

    await page.enter({ [ME]: '11', [OPPONENT]: '5' })
    await page.save()

    expect(page.pathname).toBe(`${EDIT}/3/edit`)
    expect(resultIn(page.hash).games).toEqual([[11, 5], [3, 11]])
  })

  it('links only to the games that can open', async () => {
    const page = await ScoreGamePage.render(`${EDIT}/1/edit#${draft([[11, 3]])}`)

    expect([1, 2, 3, 4, 5].map((game) => page.slotLink(game) !== null)).toEqual([true, true, false, false, false])
  })

  it('sends a game after the next empty one to the next empty one, keeping the games', async () => {
    const hash = draft([[11, 3], [3, 11]])
    const page = await ScoreGamePage.render(`${EDIT}/5/edit#${hash}`)

    expect(page.pathname).toBe(`${EDIT}/3/edit`)
    expect(page.hash).toBe(hash)
    expect(page.heading).toHaveTextContent('Game 3')
  })

  it.each(['0', '6', 'two', '1.5'])('sends game %s of an empty board to game 1', async (game) => {
    const page = await ScoreGamePage.render(`${EDIT}/${game}/edit`)

    expect(page.pathname).toBe(`${EDIT}/1/edit`)
    expect(page.heading).toHaveTextContent('Game 1')
  })

  it('reads a fragment typed into the URL by hand', async () => {
    const page = await ScoreGamePage.render()

    await act(() => page.router.history.push(`${EDIT}/1/edit#${draft([[11, 3]])}`))
    await page.settle()

    expect(page.slotScore(1)).toBe('11–3')
    expect(page.input(ME)).toHaveValue('11')
  })

  it('clears only the last game', async () => {
    const page = await ScoreGamePage.render(`${EDIT}/1/edit#${draft([[11, 3], [3, 11]])}`)
    expect(page.button('Clear game')).toBeNull()

    await page.goToGame(2)
    await page.click('Clear game')

    expect(page.pathname).toBe(`${EDIT}/2/edit`)
    expect(page.slotScore(2)).toBe('–')
    expect(page.input(ME)).toHaveValue('')
    expect(resultIn(page.hash).games).toEqual([[11, 3]])

    await page.goToGame(1)
    await page.click('Clear game')
    expect(page.hash).toBe('')
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

  it('submits the games as a result this device approved for the viewer’s side', async () => {
    const page = await ScoreGamePage.render(`${EDIT}/4/edit#${draft([[11, 5], [8, 11], [11, 9]])}`)
    await page.waitForKey()

    await page.enter({ [ME]: '9', [OPPONENT]: '11' })
    expect(page.saveButton).toHaveTextContent('Save game 4')

    await page.enter({ [ME]: '13', [OPPONENT]: '11' })
    expect(page.button('Submit result')).toBeInTheDocument()
    expect(page.text).toContain('You win 3–1')

    await page.click('Submit result')
    await page.waitForPath('/matches/demo/scores/submission')

    const { payload, signatures } = decodeEnvelope(fromBase64url(page.hash))
    expect(signatures.map(({ side }) => side)).toEqual([0])
    expect(decodePayload(payload).result).toMatchObject({
      players: [player.id, match.players[1].id],
      games: [[11, 5], [8, 11], [11, 9], [13, 11]],
      ending: 'completed',
      replaces: null,
    })
  })

  it('says so when this browser has no signing key', async () => {
    const page = await ScoreGamePage.render(`${EDIT}/3/edit#${draft([[11, 1], [11, 2], [11, 3]])}`)
    // A sign-out in progress keeps the session's registration from making one.
    await takeKey()

    await page.click('Submit result')

    expect(await page.findAlert()).toHaveTextContent('This browser can’t sign the result yet')
    expect(page.pathname).toBe(`${EDIT}/3/edit`)
  })

  it('keeps the deciding score in the URL when the result can’t be signed', async () => {
    const page = await ScoreGamePage.render(`${EDIT}/3/edit#${draft([[11, 1], [11, 2]])}`)
    await takeKey()

    await page.enter({ [ME]: '11', [OPPONENT]: '3' })
    await page.click('Submit result')

    expect(await page.findAlert()).toHaveTextContent('This browser can’t sign the result yet')
    const href = page.href
    page.close()
    const reloaded = await ScoreGamePage.render(href)
    expect([1, 2, 3].map((game) => reloaded.slotScore(game))).toEqual(['11–1', '11–2', '11–3'])
  })

  it('says which game to clear when one was played after the decider', async () => {
    const page = await ScoreGamePage.render(`${EDIT}/2/edit#${draft([[11, 1], [1, 11], [11, 2], [11, 3]])}`)

    await page.enter({ [ME]: '11', [OPPONENT]: '4' })
    await page.save()

    expect(page.text).toContain('Match decided after game 3. Clear game 4 to submit.')
    expect(page.button('Submit result')).toBeNull()
  })

  it('lets a spectator edit but not submit', async () => {
    const page = await ScoreGamePage.render('/matches/demo-spectator/scores/game/1/edit')

    expect(page.sides).toEqual(['calm crane 552', 'gentle gecko 731'])
    expect(page.result).toHaveTextContent(
      'calm crane 552 or gentle gecko 731 submits the result when the match ends.',
    )

    for (const game of [1, 2, 3]) {
      expect(page.heading).toHaveTextContent(`Game ${game}`)
      await page.enter({ 'calm crane 552': '11', 'gentle gecko 731': '6' })
      await page.save()
      if (game < 3) expect(page.saveButton).toHaveTextContent(`Save game ${game + 1}`)
    }
    expect(page.slotScore(3)).toBe('11–6')
    expect(page.button('Submit result')).toBeNull()
  })

  it('opens a result the opponent reported, and corrects it from the first save', async () => {
    const reported = resultOf(match, [[5, 11], [11, 7], [11, 9], [11, 4]], null)
    const envelope = await signResult(await otherDevice(), 1_793_700_000, reported, 1)
    const page = await ScoreGamePage.render(`${EDIT}/1/edit#${base64url(envelope)}`)
    await page.waitForKey()

    expect([1, 2, 3, 4].map((game) => page.slotScore(game))).toEqual(['5–11', '11–7', '11–9', '11–4'])
    expect(page.notices).toEqual(['Reported by your opponent. A change makes a new result that corrects it.'])
    expect(page.text).not.toMatch(/sign/i)

    await page.goToGame(4)
    await page.enter({ [ME]: '4', [OPPONENT]: '11' })
    await page.save()

    const replaced = hex(await resultHash(decodeEnvelope(envelope).payload))
    const corrected = resultIn(page.hash)
    expect(page.pathname).toBe(`${EDIT}/5/edit`)
    expect(corrected.games).toEqual([[5, 11], [11, 7], [11, 9], [4, 11]])
    expect(hex(corrected.replaces!)).toBe(replaced)
    expect(page.notices).toEqual(['This corrects an earlier result.'])

    await page.enter({ [ME]: '11', [OPPONENT]: '3' })
    await page.click('Submit result')
    await page.waitForPath('/matches/demo/scores/submission')

    const submitted = decodePayload(decodeEnvelope(fromBase64url(page.hash)).payload).result
    expect(submitted.games).toEqual([[5, 11], [11, 7], [11, 9], [4, 11], [11, 3]])
    expect(hex(submitted.replaces!)).toBe(replaced)
  })

  it('says when both players approved the result on screen', async () => {
    const reported = resultOf(match, [[11, 5], [11, 7], [11, 9]], null)
    const once = await signResult(await otherDevice(), 1_793_700_000, reported, 0)
    const twice = await appendSignature(await otherDevice(), once, 1)
    const page = await ScoreGamePage.render(`${EDIT}/1/edit#${base64url(twice)}`)

    expect(page.notices).toEqual(['Approved by both players. A change makes a new result that corrects it.'])
  })

  it.each([
    ['damaged', '#not-a-result'],
    ['for another match', `#${base64url(encodePayload(1, { ...resultOf(match, [[11, 3]], null), match: demoMatch('demo-spectator', { id: player.id, name: '' }).uuid }))}`],
    ['with an illegal game', `#${base64url(encodePayload(1, resultOf(match, [[11, 10]], null)))}`],
  ])('drops scores that are %s, and says so', async (_, fragment) => {
    const page = await ScoreGamePage.render(`${EDIT}/3/edit${fragment}`)

    expect(page.pathname).toBe(`${EDIT}/1/edit`)
    expect(page.hash).toBe('')
    expect(page.slotScore(1)).toBe('–')
    expect(page.notices).toEqual([DISCARDED])
  })

  it('shows the not-found page for an unknown match', async () => {
    const page = await ErrorPage.render('/matches/nope/scores/game/1/edit')

    expect(page.title).toHaveTextContent('We can’t find that page')
  })

  describe('a match the API made, opened from its fragment', () => {
    const id = '01970000-0000-7000-8000-0000000000b4'
    const crane = '0c9e7b21-3d4a-4f68-a1b5-7e2f9c8d6a40'
    const gecko = 'a4d8f0e6-1b2c-4e3d-8f5a-9c7b6e1d2f08'
    const spectated = apiMatch(id, 7, false, [crane, gecko])
    const path = (match = spectated, games: GamePoints[] = []) =>
      `/matches/${id}/scores/game/1/edit#${draftHash(match, games, null, 1_793_700_000)}`

    it('shows the match with no request, naming the players by side', async () => {
      const page = await ScoreGamePage.render(path())

      expect(page.heading).toHaveTextContent('Game 1')
      expect(page.gameCount).toBe(7)
      expect(page.sides).toEqual(['Player 1', 'Player 2'])
    })

    it('shows the not-found page for a fragment for another match', async () => {
      const other = apiMatch('01970000-0000-7000-8000-0000000000b6', 3, false, [crane, gecko])
      const page = await ErrorPage.render(path(other, [[11, 3]]))

      expect(page.title).toHaveTextContent('We can’t find that page')
    })

    it.each([
      ['no fragment', ''],
      ['a fragment it can’t read', '#not-a-result'],
    ])('shows the not-found page with %s', async (_, hash) => {
      const page = await ErrorPage.render(`/matches/${id}/scores/game/1/edit${hash}`)

      expect(page.title).toHaveTextContent('We can’t find that page')
    })
  })

  describe('background sync', () => {
    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
      vi.mocked(putBoard).mockReset()
    })

    it('syncs a save to the server', async () => {
      const page = await ScoreGamePage.render()

      await saveGame(page, 1, '11', '3')

      expect(ScoreGamePage.serverBoard).toBe(page.hash)
      expect(page.slotSync(1)).toBe('Synced')
    })

    it('saves at once while offline, and syncs once back online', async () => {
      const page = await ScoreGamePage.render()
      page.goOffline()

      await saveGame(page, 1, '11', '9')

      expect(page.heading).toHaveTextContent('Game 2')
      expect(page.slotScore(1)).toBe('11–9')
      expect(page.slotSync(1)).toBe('Not synced')
      expect(page.stripNote).toBe('Offline. Saved on this device.')
      expect(ScoreGamePage.serverBoard).toBeNull()

      await page.goOnline()

      expect(ScoreGamePage.serverBoard).toBe(page.hash)
      expect(page.slotSync(1)).toBe('Synced')
    })

    it('tries a failed send again after a backoff', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const page = await ScoreGamePage.render()
      vi.mocked(putBoard).mockRejectedValueOnce(new ApiError('PUT /v1/matches/demo/board', new Response(null, { status: 503 })))

      await saveGame(page, 1, '11', '4')

      expect(page.slotSync(1)).toBe('Not synced')
      expect(ScoreGamePage.serverBoard).toBeNull()

      await act(() => vi.advanceTimersByTimeAsync(2000))
      await page.settle()

      expect(ScoreGamePage.serverBoard).toBe(page.hash)
    })

    it('never changes its pad for another device’s board', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const page = await ScoreGamePage.render()
      await saveGame(page, 1, '11', '3')
      const mine = page.hash
      ScoreGamePage.otherDeviceSyncs(draftHash(match, [[2, 11], [11, 9]], null, nowSeconds() + 60))

      await act(() => vi.advanceTimersByTimeAsync(30_000))
      await page.goOnline()

      expect(page.hash).toBe(mine)
      expect(page.slotScore(1)).toBe('11–3')
      expect(page.slotScore(2)).toBe('–')
    })

    it('keeps an empty pad while the server holds a board', async () => {
      ScoreGamePage.otherDeviceSyncs(boardFrom([[11, 3], [5, 11]], 30))

      const page = await ScoreGamePage.render()
      await page.goOnline()

      expect(page.hash).toBe('')
      expect(page.slotScore(1)).toBe('–')
    })

    it('syncs a board saved offline after the scoring page has closed', async () => {
      const page = await ScoreGamePage.render()
      page.goOffline()
      await saveGame(page, 1, '11', '5')
      const saved = page.hash

      await act(() => page.router.navigate({ to: '/' }))
      await page.goOnline()

      await waitFor(() => expect(ScoreGamePage.serverBoard).toBe(saved))
    })

    it('syncs the submitted result for whoever watches', async () => {
      const page = await ScoreGamePage.render(`${EDIT}/3/edit#${draft([[11, 5], [11, 9]])}`)
      await page.waitForKey()
      await page.enter({ [ME]: '11', [OPPONENT]: '2' })

      await page.click('Submit result')
      await page.waitForPath('/matches/demo/scores/submission')

      await waitFor(() => expect(ScoreGamePage.serverBoard).toBe(page.hash))
      expect(decodeEnvelope(fromBase64url(page.hash)).signatures).toHaveLength(1)
    })
  })
})
