import { act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest'
import type { components } from '../../api/schema'
import { saveAccount } from '../../api/savedSession'
import type { GamePoints } from '../../scoring/board'
import { demoMatch } from '../../scoring/demoMatches'
import { draftHash, nowSeconds, resultOf } from '../../scoring/fragment'
import { apiMatch } from '../../scoring/matches'
import { resultsOf } from '../../scoring/results'
import { hex } from '../../signing/bytes'
import { takeKey } from '../../signing/deviceKey'
import { appendSignature, decodeEnvelope, signResult, type Signer } from '../../signing/envelope'
import { decodePayload, encodePayload, resultHash, type MatchResult } from '../../signing/result'
import { base64url, fromBase64url } from '../../signing/text'
import { ErrorPage } from '../../test/pages/ErrorPage'
import { ScoreGamePage } from '../../test/pages/ScoreGamePage'
import {
  API_BASE_URL,
  grantSession,
  holdSession,
  mockApprovals,
  mockBoards,
  mockMatchReads,
  server,
  sessionResponse,
} from '../../test/server'

// The pad names the players to a player as You and Your opponent.
const ME = 'You'
const OPPONENT = 'Your opponent'
const player = sessionResponse.data.account.player
const match = demoMatch('demo', { id: player.id, name: player.display_name })
const EDIT = '/matches/demo/scores/game'
type MatchDetail = components['schemas']['MatchDetail']
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
    const fragment = (match = spectated, games: GamePoints[] = []) => `#${draftHash(match, games, null, 1_793_700_000)}`
    const path = (match = spectated, games: GamePoints[] = []) => `/matches/${id}/scores/game/1/edit${fragment(match, games)}`

    it('shows the match with no request, naming the players by side', async () => {
      const page = await ScoreGamePage.render(path())

      expect(page.heading).toHaveTextContent('Game 1')
      expect(page.gameCount).toBe(7)
      expect(page.sides).toEqual(['Player 1', 'Player 2'])
    })

    // The API's read of the match, live with `games` on its board.
    const served = (games: GamePoints[], state: MatchDetail['state'] = { kind: 'live' }): MatchDetail => ({
      id,
      best_of: 7,
      rated: false,
      started_at: '2026-11-05T19:00:00Z',
      sides: [
        { side: 0, players: [{ id: crane, display_name: 'calm crane 101' }] },
        { side: 1, players: [{ id: gecko, display_name: 'grey gecko 202' }] },
      ],
      viewer_side: null,
      games,
      retired_by: null,
      state,
      history: [],
      result_hash: null,
    })

    describe('with no scores for the match in the URL', () => {
      it.each([
        ['no fragment', ''],
        ['a fragment it can’t read', '#not-a-result'],
        ['a fragment for another match', fragment(apiMatch('01970000-0000-7000-8000-0000000000b6', 3, false, [crane, gecko]))],
        ['scores the match can’t hold', fragment(spectated, [[11, 10]])],
      ])('rebuilds the board from the API with %s', async (_, hash) => {
        mockMatchReads([served([[11, 3], [4, 2]])])
        const page = await ScoreGamePage.render(`/matches/${id}/scores/game/1/edit${hash}`)

        expect(page.heading).toHaveTextContent('Game 2')
        expect(page.slotScore(1)).toBe('11–3')
        expect(page.notices).toEqual([])
        expect(resultIn(page.hash).games).toEqual([[11, 3]])
      })

      it('opens the match’s page once its result is final', async () => {
        const final: MatchDetail['state'] = {
          kind: 'final',
          accepted_at: '2026-11-05T20:00:00Z',
          approved_by: [0],
          override_reason: null,
        }
        mockMatchReads([served([[11, 3]], final)])
        grantSession('matches.view')
        const page = await ScoreGamePage.render(`/matches/${id}/scores/game/1/edit`)

        expect(page.pathname).toBe(`/matches/${id}`)
      })

      it('opens the match’s page when its players were merged into one', async () => {
        const merged = served([[11, 3]])
        merged.sides[1].players[0].id = crane
        mockMatchReads([merged])
        grantSession('matches.view')
        const page = await ScoreGamePage.render(`/matches/${id}/scores/game/1/edit`)

        expect(page.pathname).toBe(`/matches/${id}`)
      })

      it('shows the not-found page when no match has the id', async () => {
        mockMatchReads([])
        const page = await ErrorPage.render(`/matches/${id}/scores/game/1/edit`)

        expect(page.title).toHaveTextContent('We can’t find that page')
      })

      it('shows the not-found page to an account that can’t view the match', async () => {
        server.use(
          http.get(`${API_BASE_URL}/v1/matches/:matchId`, () =>
            HttpResponse.json({ errors: [{ status: '403', title: 'Forbidden' }] }, { status: 403 }),
          ),
        )
        const page = await ErrorPage.render(`/matches/${id}/scores/game/1/edit`)

        expect(page.title).toHaveTextContent('We can’t find that page')
      })

      it('shows the app’s error page, not Try again, for a read the page can’t use', async () => {
        server.use(http.get(`${API_BASE_URL}/v1/matches/:matchId`, () => HttpResponse.json({ data: {} })))
        const page = await ErrorPage.render(`/matches/${id}/scores/game/1/edit`)

        expect(page.title).toHaveTextContent('Something went wrong')
        expect(page.homeLink).toBeInTheDocument()
      })

      it('shows a skeleton while the match loads, then its scores', async () => {
        const api = mockMatchReads([served([[11, 3]])])
        api.hold = true
        const page = await ScoreGamePage.renderLoading(`/matches/${id}/scores/game/1/edit`)

        expect(await page.loading()).toBeInTheDocument()
        await api.release()

        await page.settle()
        expect(page.heading).toHaveTextContent('Game 2')
      })

      it('shows an error with Try again when the API fails, then the scores', async () => {
        const api = mockMatchReads([served([[11, 3]])])
        api.fails = true
        const page = await ScoreGamePage.renderLoading(`/matches/${id}/scores/game/1/edit`)
        expect(await page.findAlert()).toHaveTextContent('Try again')

        api.fails = false
        await page.tryAgain()

        expect(page.heading).toHaveTextContent('Game 2')
      })

      describe('with no network', () => {
        let onLine: MockInstance
        beforeEach(() => {
          onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
        })
        afterEach(() => onLine.mockRestore())

        it('says to open the match with signal, and sends nothing', async () => {
          const api = mockMatchReads([served([[11, 3]])])
          const page = await ScoreGamePage.render(`/matches/${id}/scores/game/1/edit`)

          expect(page.heading).toHaveTextContent('This match’s scores aren’t on this device')
          expect(page.openMatchLink).toHaveAttribute('href', `/matches/${id}`)
          expect(api.reads).toEqual([])
        })

        it('starts the scores empty when the URL still carries the match', async () => {
          const api = mockMatchReads([served([[11, 3]])])
          const page = await ScoreGamePage.render(path(spectated, [[11, 10]]))

          expect(page.heading).toHaveTextContent('Game 1')
          expect(page.notices).toEqual([DISCARDED])
          expect(page.sides).toEqual(['Player 1', 'Player 2'])
          expect(api.reads).toEqual([])
        })
      })

      it('says to open the match with signal when the API holds the request for 8 seconds', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        onTestFinished(() => {
          vi.useRealTimers()
        })
        const api = mockMatchReads([served([[11, 3]])])
        api.hold = true
        const page = await ScoreGamePage.renderLoading(`/matches/${id}/scores/game/1/edit`)

        await act(() => vi.advanceTimersByTimeAsync(7_900))
        expect(await page.loading()).toBeInTheDocument()
        await act(() => vi.advanceTimersByTimeAsync(100))
        await page.settle()

        expect(page.heading).toHaveTextContent('This match’s scores aren’t on this device')
        await api.release()
      })

      it('says to open the match with signal when the request gets no response', async () => {
        server.use(http.get(`${API_BASE_URL}/v1/matches/:matchId`, () => HttpResponse.error()))
        const page = await ScoreGamePage.render(`/matches/${id}/scores/game/1/edit`)

        expect(page.heading).toHaveTextContent('This match’s scores aren’t on this device')
      })
    })

    describe('for an account without matches.score', () => {
      it('saves a game with no board request and no sync mark', async () => {
        const boards = mockBoards()
        const page = await ScoreGamePage.render(path())

        await page.enter({ 'Player 1': '11', 'Player 2': '3' })
        await page.save()

        expect(page.slotScore(1)).toBe('11–3')
        expect(page.slotSync(1)).toBeNull()
        expect(page.stripNote).toBeNull()
        expect(boards.pushes).toEqual([])
      })

      it('submits a decided match with no board request', async () => {
        const boards = mockBoards()
        const played = apiMatch(id, 3, false, [player.id, gecko])
        const page = await ScoreGamePage.render(path(played, [[11, 5]]).replace('/game/1/', '/game/2/'))
        await page.waitForKey()
        await page.enter({ [ME]: '11', [OPPONENT]: '2' })

        await page.click('Submit result')
        await page.waitForPath(`/matches/${id}/scores/submission`)

        expect(decodeEnvelope(fromBase64url(page.hash)).signatures).toHaveLength(1)
        expect(boards.pushes).toEqual([])
      })
    })
  })

  it('saves the demo match with no board request and no sync mark, whatever the account may do', async () => {
    grantSession('matches.score')
    const boards = mockBoards()
    const page = await ScoreGamePage.render()

    await saveGame(page, 1, '11', '3')

    expect(page.slotSync(1)).toBeNull()
    expect(page.stripNote).toBeNull()
    expect(boards.pushes).toEqual([])
  })

  describe('background sync', () => {
    const gecko = 'a4d8f0e6-1b2c-4e3d-8f5a-9c7b6e1d2f08'
    // The session's player plays side 0, so the page can submit.
    const scored = apiMatch('01970000-0000-7000-8000-0000000000c8', 5, false, [player.id, gecko])
    const edit = `/matches/${scored.id}/scores/game`
    let boards: ReturnType<typeof mockBoards>

    beforeEach(() => {
      grantSession('matches.score')
      boards = mockBoards()
    })

    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    const render = (games: GamePoints[] = [], game = 1) => ScoreGamePage.renderApiMatch(scored, games, game)
    const landed = () => boards.board(scored.id)

    it('sends a save to the API as the hex of the fragment', async () => {
      const page = await render()

      await saveGame(page, 1, '11', '3')

      expect(boards.pushes).toEqual([{ matchId: scored.id, board: hex(fromBase64url(page.hash)) }])
      expect(landed()).toBe(page.hash)
      expect(page.slotSync(1)).toBe('Synced')
    })

    it('shows a board on its way as syncing, and as synced once the API takes it', async () => {
      boards.hold = true
      const page = await render()
      await page.enter({ [ME]: '11', [OPPONENT]: '6' })

      await userEvent.click(page.saveButton!)

      await waitFor(() => expect(page.slotSync(1)).toBe('Syncing'))
      await boards.release()
      await page.settle()
      expect(page.slotSync(1)).toBe('Synced')
      expect(page.slotShowsSynced(1)).toBe(true)
    })

    describe('a board the API refuses', () => {
      it.each([
        [403, 'Not synced. Saved on this device.'],
        [404, 'Not synced. Saved on this device.'],
        [409, 'Match final. A correction syncs once you submit it.'],
        [422, 'Not synced. Saved on this device.'],
      ])('never shows a %i as synced, and says why', async (status, note) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        boards.answers.push({ status })
        const page = await render()

        await saveGame(page, 1, '11', '7')

        expect(page.slotSync(1)).toBeNull()
        expect(page.slotShowsSynced(1)).toBe(false)
        expect(page.stripNote).toBe(note)
        expect(landed()).toBeNull()
      })

      it('refreshes the session after a 403, and never sends the board again', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const page = await render()
        const sessions = countSessions()
        boards.answers.push({ status: 403, title: 'You can’t score this match' })

        await saveGame(page, 1, '11', '2')
        await act(() => vi.advanceTimersByTimeAsync(60_000))

        expect(boards.pushes).toHaveLength(1)
        await waitFor(() => expect(sessions.count).toBe(1))
      })

      it('still says why after a 403 whose session refresh takes away matches.score', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const page = await render()
        const sessions = { count: 0 }
        server.use(
          http.post(`${API_BASE_URL}/v1/session`, () => {
            sessions.count += 1
            return HttpResponse.json({ data: { account: { ...sessionResponse.data.account, permissions: [] } } })
          }),
        )
        boards.answers.push({ status: 403, title: 'You can’t score this match' })

        await saveGame(page, 1, '11', '2')
        await waitFor(() => expect(sessions.count).toBe(1))
        await page.settle()

        expect(page.stripNote).toBe('Not synced. Saved on this device.')
        expect(page.slotSync(1)).not.toBe('Synced')
      })

      it('warns with the status and title of a 422', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        boards.answers.push({ status: 422, title: 'The board isn’t a valid result' })
        const page = await render()

        await saveGame(page, 1, '11', '8')

        expect(warn).toHaveBeenCalledWith(expect.any(String), 422, 'The board isn’t a valid result')
      })

      it('still says why after the person leaves and comes back', async () => {
        boards.answers.push({ status: 409 })
        const page = await render()
        await saveGame(page, 1, '11', '4')
        const saved = page.hash

        await act(() => page.router.navigate({ to: '/' }))
        await act(() => page.router.navigate({ href: `${edit}/1/edit#${saved}` }))
        await page.settle()

        expect(page.stripNote).toBe('Match final. A correction syncs once you submit it.')
      })

      it('says why a board refused with the scoring page closed', async () => {
        const page = await render()
        page.goOffline()
        await saveGame(page, 1, '11', '6')
        const saved = page.hash
        boards.answers.push({ status: 422 })
        vi.spyOn(console, 'warn').mockImplementation(() => {})

        await act(() => page.router.navigate({ to: '/' }))
        await page.goOnline()
        await waitFor(() => expect(boards.pushes).toHaveLength(1))
        await waitFor(() => expect(console.warn).toHaveBeenCalled())
        await act(() => page.router.navigate({ href: `${edit}/2/edit#${saved}` }))
        await page.settle()

        expect(page.stripNote).toBe('Not synced. Saved on this device.')
      })

      it('clears its note once a later save lands, and shows that game as synced', async () => {
        boards.answers.push({ status: 409 })
        const page = await render()
        await saveGame(page, 1, '11', '5')
        expect(page.stripNote).toBe('Match final. A correction syncs once you submit it.')

        await saveGame(page, 2, '11', '9')

        expect(page.stripNote).toBeNull()
        expect(page.slotSync(2)).toBe('Synced')
        expect(landed()).toBe(page.hash)
      })
    })

    it('refreshes the session after a 401, keeps the board, and sends it again', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const page = await render()
      const sessions = countSessions()
      boards.answers.push({ status: 401, title: 'The request has no valid session' })

      await saveGame(page, 1, '11', '2')

      expect(landed()).toBeNull()
      expect(page.stripNote).toBeNull()
      await waitFor(() => expect(sessions.count).toBe(1))

      await act(() => vi.advanceTimersByTimeAsync(2000))
      await page.settle()

      expect(boards.pushes).toHaveLength(2)
      expect(landed()).toBe(page.hash)
      expect(page.slotSync(1)).toBe('Synced')
    })

    it('refreshes the session after a 401 on a page that doesn’t read the session', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const page = await render()
      page.goOffline()
      await saveGame(page, 1, '11', '2')
      const sessions = countSessions()
      boards.answers.push({ status: 401, title: 'The request has no valid session' })

      await act(() => page.router.navigate({ to: '/design-system' }))
      // Not page.goOnline(): it waits for the sync to settle, and a 401
      // keeps the board, so this one goes on retrying.
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
      act(() => window.dispatchEvent(new Event('online')))
      await waitFor(() => expect(boards.pushes).toHaveLength(1))

      await waitFor(() => expect(sessions.count).toBe(1))
    })

    it('waits for a slow session refresh rather than starting another, and says why after a second 401', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const page = await render()
      const session = holdSession()
      boards.answers.push({ status: 401 }, { status: 401 })

      await saveGame(page, 1, '11', '2')
      await waitFor(() => expect(session.requests).toHaveLength(1))
      await act(() => vi.advanceTimersByTimeAsync(2000))
      await waitFor(() => expect(boards.pushes).toHaveLength(2))
      await page.settle()

      expect(session.requests).toHaveLength(1)
      expect(page.stripNote).toBe('Not synced yet. Saved on this device.')

      await session.respond(
        Response.json({ data: { account: { ...sessionResponse.data.account, permissions: ['matches.score'] } } }),
      )
      await act(() => vi.advanceTimersByTimeAsync(4000))
      await page.settle()

      expect(landed()).toBe(page.hash)
      expect(page.stripNote).toBeNull()
    })

    it('refreshes the session again after a refresh that got no response', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const page = await render()
      const sessions: string[] = []
      server.use(
        http.post(`${API_BASE_URL}/v1/session`, () => {
          sessions.push('sent')
          if (sessions.length === 1) return HttpResponse.error()
          return HttpResponse.json({
            data: { account: { ...sessionResponse.data.account, permissions: ['matches.score'] } },
          })
        }),
      )
      boards.answers.push({ status: 401 }, { status: 401 })

      await saveGame(page, 1, '11', '2')
      await waitFor(() => expect(sessions).toHaveLength(1))
      await act(() => vi.advanceTimersByTimeAsync(2000))
      await waitFor(() => expect(sessions).toHaveLength(2))
      await act(() => vi.advanceTimersByTimeAsync(4000))
      await page.settle()

      expect(boards.pushes).toHaveLength(3)
      expect(landed()).toBe(page.hash)
      expect(page.slotSync(1)).toBe('Synced')
    })

    it('saves at once while offline, and syncs once back online', async () => {
      const page = await render()
      page.goOffline()

      await saveGame(page, 1, '11', '9')

      expect(page.heading).toHaveTextContent('Game 2')
      expect(page.slotScore(1)).toBe('11–9')
      expect(page.slotSync(1)).toBe('Not synced')
      expect(page.stripNote).toBe('Offline. Saved on this device.')
      expect(boards.pushes).toEqual([])

      await page.goOnline()

      expect(landed()).toBe(page.hash)
      expect(page.slotSync(1)).toBe('Synced')
    })

    describe('a send that doesn’t get through', () => {
      beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
      })

      it('shows nothing after one 503, and tries again after 2 seconds', async () => {
        const page = await render()
        boards.answers.push({ status: 503 })

        await saveGame(page, 1, '11', '4')

        expect(page.stripNote).toBeNull()
        expect(page.slotSync(1)).toBeNull()
        expect(landed()).toBeNull()

        await act(() => vi.advanceTimersByTimeAsync(2000))
        await page.settle()

        expect(landed()).toBe(page.hash)
      })

      it.each([502, 503, 504])('says the server is failing, not offline, after a second %i', async (status) => {
        const page = await render()
        boards.answers.push({ status }, { status })

        await saveGame(page, 1, '11', '4')
        await act(() => vi.advanceTimersByTimeAsync(2000))
        await page.settle()

        expect(boards.pushes).toHaveLength(2)
        expect(page.slotSync(1)).toBe('Not synced')
        expect(page.stripNote).toBe('Not synced yet. Saved on this device.')
      })

      it('counts failures only in a row, so a refusal starts the count again', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const page = await render()
        boards.answers.push({ status: 503 }, { status: 422 })
        await saveGame(page, 1, '11', '4')
        await act(() => vi.advanceTimersByTimeAsync(2000))
        await page.settle()
        boards.answers.push({ status: 503 })

        await saveGame(page, 2, '11', '6')

        expect(boards.pushes).toHaveLength(3)
        expect(page.stripNote).toBe('Not synced. Saved on this device.')
      })

      describe('a 429', () => {
        const rateLimitNextSend = (retryAfter?: string) =>
          boards.answers.push({ status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {} })

        it('waits out its Retry-After, whatever wakes the page', async () => {
          const page = await render()
          rateLimitNextSend('60')

          await saveGame(page, 1, '11', '4')
          expect(page.stripNote).toBe('Not synced yet. Saved on this device.')
          await page.goOnline()
          vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
          act(() => document.dispatchEvent(new Event('visibilitychange')))
          act(() => window.dispatchEvent(new Event('pageshow')))
          await act(() => vi.advanceTimersByTimeAsync(59_000))

          expect(boards.pushes).toHaveLength(1)

          await act(() => vi.advanceTimersByTimeAsync(1000))
          await page.settle()

          expect(boards.pushes).toHaveLength(2)
          expect(landed()).toBe(page.hash)
        })

        it('waits no more than 5 minutes', async () => {
          const page = await render()
          rateLimitNextSend('600')

          await saveGame(page, 1, '11', '4')
          await act(() => vi.advanceTimersByTimeAsync(299_000))

          expect(boards.pushes).toHaveLength(1)

          await act(() => vi.advanceTimersByTimeAsync(1000))

          await waitFor(() => expect(boards.pushes).toHaveLength(2))
        })

        it('waits the backoff without a Retry-After', async () => {
          const page = await render()
          rateLimitNextSend()

          await saveGame(page, 1, '11', '4')
          await act(() => vi.advanceTimersByTimeAsync(1000))

          expect(boards.pushes).toHaveLength(1)

          await act(() => vi.advanceTimersByTimeAsync(1000))

          await waitFor(() => expect(boards.pushes).toHaveLength(2))
        })
      })

      it('sends at once when the browser comes back online during a backoff', async () => {
        const page = await render()
        boards.answers.push({ status: 503 })
        await saveGame(page, 1, '11', '4')

        await page.goOnline()

        expect(boards.pushes).toHaveLength(2)
        expect(landed()).toBe(page.hash)
      })

      it('says offline when no response came back', async () => {
        const page = await render()
        boards.answers.push('unreachable')

        await saveGame(page, 1, '11', '4')

        expect(page.slotSync(1)).toBe('Not synced')
        expect(page.stripNote).toBe('Offline. Saved on this device.')
      })
    })

    it('never changes its pad for another device’s board', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const page = await render()
      await saveGame(page, 1, '11', '3')
      const mine = page.hash
      boards.store(scored.id, draftHash(scored, [[2, 11], [11, 9]], null, nowSeconds() + 60))

      await act(() => vi.advanceTimersByTimeAsync(30_000))
      await page.goOnline()

      expect(page.hash).toBe(mine)
      expect(page.slotScore(1)).toBe('11–3')
      expect(page.slotScore(2)).toBe('–')
    })

    it('keeps an empty pad while the API holds a board', async () => {
      boards.store(scored.id, draftHash(scored, [[11, 3], [5, 11]], null, nowSeconds() - 30))

      const page = await render()
      const opened = page.hash
      await page.goOnline()

      expect(page.hash).toBe(opened)
      expect(page.slotScore(1)).toBe('–')
    })

    it('syncs a board saved offline when the page comes back without an online event', async () => {
      const page = await render()
      page.goOffline()
      await saveGame(page, 1, '11', '7')

      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      await page.settle()

      expect(landed()).toBe(page.hash)
      expect(page.slotSync(1)).toBe('Synced')
    })

    it('syncs a board saved offline after the scoring page has closed', async () => {
      const page = await render()
      page.goOffline()
      await saveGame(page, 1, '11', '5')
      const saved = page.hash

      await act(() => page.router.navigate({ to: '/' }))
      await page.goOnline()

      await waitFor(() => expect(landed()).toBe(saved))
    })

    it('syncs the submitted result for whoever watches', async () => {
      const page = await render([[11, 5], [11, 9]], 3)
      await page.waitForKey()
      await page.enter({ [ME]: '11', [OPPONENT]: '2' })

      await page.click('Submit result')
      await page.waitForPath(`/matches/${scored.id}/scores/submission`)

      await waitFor(() => expect(landed()).toBe(page.hash))
      expect(decodeEnvelope(fromBase64url(page.hash)).signatures).toHaveLength(1)
    })

    it('records the submitted result on the API, with the submitter’s signature', async () => {
      const approvals = mockApprovals()
      const page = await render([[11, 5], [11, 9]], 3)
      await page.waitForKey()
      await page.enter({ [ME]: '11', [OPPONENT]: '2' })

      await page.click('Submit result')
      await page.waitForPath(`/matches/${scored.id}/scores/submission`)

      await waitFor(() =>
        expect(approvals.checks).toEqual([{ matchId: scored.id, envelope: hex(fromBase64url(page.hash)) }]),
      )
      await waitFor(() => expect(resultsOf(scored.id)).toEqual([]))
    })

    it('holds a result and its correction submitted offline, and sends both in order once online', async () => {
      const approvals = mockApprovals()
      const page = await render([[11, 5], [11, 9]], 3)
      await page.waitForKey()
      page.goOffline()
      await page.enter({ [ME]: '11', [OPPONENT]: '2' })
      await page.click('Submit result')
      await page.waitForPath(`/matches/${scored.id}/scores/submission`)
      const first = page.hash
      await act(() => page.router.navigate({ to: '/matches/$matchId/scores/game/$gameNumber/edit', params: { matchId: scored.id, gameNumber: '3' }, hash: first }))
      await page.enter({ [ME]: '11', [OPPONENT]: '4' })
      await page.click('Submit result')
      await page.waitForPath(`/matches/${scored.id}/scores/submission`)
      const corrected = page.hash
      expect(approvals.checks).toEqual([])

      await page.goOnline()

      await waitFor(() =>
        expect(approvals.checks.map(({ envelope }) => envelope)).toEqual([
          hex(fromBase64url(first)),
          hex(fromBase64url(corrected)),
        ]),
      )
    })

    it('corrects the submitted result from the pad the phone’s Back button opens', async () => {
      const approvals = mockApprovals()
      const page = await render([[11, 5], [11, 9]], 3)
      await page.waitForKey()
      await page.enter({ [ME]: '11', [OPPONENT]: '2' })
      await page.click('Submit result')
      await page.waitForPath(`/matches/${scored.id}/scores/submission`)
      const first = page.hash

      await act(async () => page.router.history.back())
      await page.waitForPath(`${edit}/3/edit`)
      await page.enter({ [ME]: '11', [OPPONENT]: '4' })
      await page.click('Submit result')
      await page.waitForPath(`/matches/${scored.id}/scores/submission`)

      const { replaces } = decodePayload(decodeEnvelope(fromBase64url(page.hash)).payload).result
      expect(replaces && hex(replaces)).toBe(hex(await resultHash(decodeEnvelope(fromBase64url(first)).payload)))
      await waitFor(() => expect(approvals.checks).toHaveLength(2))
    })

    it('sends a result again after an unknown key, once the session registers it', async () => {
      const approvals = mockApprovals({ refused: "A signature's key isn't registered, or was revoked" })
      const sessions = countSessions()
      const page = await render([[11, 5], [11, 9]], 3)
      await page.waitForKey()
      const before = sessions.count
      await page.enter({ [ME]: '11', [OPPONENT]: '2' })
      await page.click('Submit result')
      await page.waitForPath(`/matches/${scored.id}/scores/submission`)
      await waitFor(() => expect(approvals.checks).toHaveLength(1))

      approvals.answer = 'accepted'

      await waitFor(() => expect(resultsOf(scored.id)).toEqual([]), { timeout: 5000 })
      expect(approvals.checks).toHaveLength(2)
      expect(sessions.count, "the session refreshed, which registers the key").toBeGreaterThan(before)
    })

    it('sends a board at once while a result waits for the result it replaces, and shows nothing stuck', async () => {
      const approvals = mockApprovals({ refused: "The result doesn't replace the match's newest result", status: 409 })
      const page = await render([[11, 5], [11, 9]], 3)
      await page.waitForKey()
      await page.enter({ [ME]: '11', [OPPONENT]: '2' })
      await page.click('Submit result')
      await page.waitForPath(`/matches/${scored.id}/scores/submission`)
      await waitFor(() => expect(approvals.checks).toHaveLength(2), { timeout: 5000 })
      const pushed = boards.pushes.length

      await act(() =>
        page.router.navigate({
          to: '/matches/$matchId/scores/game/$gameNumber/edit',
          params: { matchId: scored.id, gameNumber: '1' },
          hash: page.hash,
        }),
      )
      await saveGame(page, 1, '5', '11')

      expect(boards.pushes.length).toBeGreaterThan(pushed)
      expect(page.stripNote).toBeNull()
      expect(resultsOf(scored.id)).toHaveLength(1)
    })

    it('drops a result the API refuses, and never sends it again', async () => {
      const approvals = mockApprovals({ refused: "Another result replaced this one, so it can't be approved", status: 409 })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const page = await render([[11, 5], [11, 9]], 3)
      await page.waitForKey()
      await page.enter({ [ME]: '11', [OPPONENT]: '2' })

      await page.click('Submit result')
      await page.waitForPath(`/matches/${scored.id}/scores/submission`)

      await waitFor(() => expect(resultsOf(scored.id)).toEqual([]))
      await page.goOnline()
      expect(approvals.checks).toHaveLength(1)
    })
  })
})

// Counts the session requests from now on, each answered with the default
// guest holding `matches.score`.
function countSessions() {
  const sessions = { count: 0 }
  server.use(
    http.post(`${API_BASE_URL}/v1/session`, () => {
      sessions.count += 1
      return HttpResponse.json({
        data: { account: { ...sessionResponse.data.account, permissions: ['matches.score'] } },
      })
    }),
  )
  return sessions
}
