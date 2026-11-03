import { describe, expect, it } from 'vitest'
import { sessionResponse } from '../../test/server'
import { AwaitingValidationPage } from '../../test/pages/AwaitingValidationPage'
import { ScoreGamePage } from '../../test/pages/ScoreGamePage'
import { demoMatch } from '../../scoring/demoMatches'
import { submitResult } from '../../scoring/scratchpad'
import { signWithDeviceKey, takeKey } from '../../signing/deviceKey'
import { hex } from '../../signing/bytes'
import { decodeEnvelope } from '../../signing/envelope'
import { decodePayload } from '../../signing/result'
import { fromBase64url } from '../../signing/text'

const ME = 'excited egret 387'
const OPPONENT = 'brave badger 214'
const player = sessionResponse.data.account.player
const match = demoMatch('demo', { id: player.id, name: player.display_name })

async function submitThreeNil(): Promise<AwaitingValidationPage> {
  const pad = await ScoreGamePage.render()
  for (const [game, points] of [[1, '5'], [2, '7'], [3, '9']] as const) {
    if (game > 1) await pad.goToGame(game)
    await pad.enter({ [ME]: '11', [OPPONENT]: points })
    await pad.click(game === 3 ? 'Submit result' : `Save game ${game}`)
  }
  return new AwaitingValidationPage(pad.router)
}

describe('AwaitingValidation', () => {
  it('shows the submitted result after a submit', async () => {
    const page = await submitThreeNil()

    expect(page.href).toBe('/matches/demo/scores/submission')
    expect(page.heading).toHaveTextContent('Waiting for validation')
    expect(page.text).toContain(`${OPPONENT} confirms the result`)
    expect(page.result).toHaveTextContent(`${ME} wins 3–0`)
    expect(page.result).toHaveTextContent('Game 1 11–5')
  })

  it('links to the result this device signed, and shows its QR code', async () => {
    const page = await submitThreeNil()

    const link = await page.findLink()
    expect(page.qrCode).toBeInTheDocument()
    const [path, fragment] = link.getAttribute('href')!.split('#')
    expect(path).toBe('/matches/demo/scores/approvals/new')
    const { payload, signatures } = decodeEnvelope(fromBase64url(fragment))
    const { result } = decodePayload(payload)
    expect(result).toMatchObject({
      match: match.uuid,
      bestOf: 5,
      rated: false,
      players: [player.id, match.players[1].id],
      games: [[11, 5], [11, 7], [11, 9]],
      ending: 'completed',
    })
    const signer = await signWithDeviceKey()
    expect(signatures.map(({ side, kid }) => [side, hex(kid)])).toEqual([[0, hex(signer!.kid)]])
  })

  it('sends an open pad to its scores', async () => {
    const page = await AwaitingValidationPage.render()

    await page.waitForPath('/matches/demo/scores/game/1/edit')
  })

  it('sends a result the other player submitted to the scores', async () => {
    submitResult('demo', match.players[1].id, [[5, 11], [5, 11], [5, 11]])
    const page = await AwaitingValidationPage.render()

    await page.waitForPath('/matches/demo/scores/game/1/edit')
  })

  it('says so when this browser has no signing key', async () => {
    // A sign-out in progress keeps the session's registration from making one.
    await takeKey()
    submitResult('demo', player.id, [[11, 5], [11, 7], [11, 9]])
    const page = await AwaitingValidationPage.render()

    expect(await page.findAlert()).toHaveTextContent('This browser can’t sign the result yet')
    expect(page.heading).toHaveTextContent('Waiting for validation')
  })
})
