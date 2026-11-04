import { cleanup } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { sessionResponse } from '../../test/server'
import { AwaitingValidationPage } from '../../test/pages/AwaitingValidationPage'
import { ScoreGamePage } from '../../test/pages/ScoreGamePage'
import { demoMatch } from '../../scoring/demoMatches'
import { draftHash } from '../../scoring/fragment'
import { signWithDeviceKey } from '../../signing/deviceKey'
import { hex } from '../../signing/bytes'
import { decodeEnvelope } from '../../signing/envelope'
import { decodePayload } from '../../signing/result'
import { fromBase64url } from '../../signing/text'

const ME = 'excited egret 387'
const OPPONENT = 'brave badger 214'
const player = sessionResponse.data.account.player
const match = demoMatch('demo', { id: player.id, name: player.display_name })

async function submitThreeNil(): Promise<AwaitingValidationPage> {
  const pad = await ScoreGamePage.render(
    `/matches/demo/scores/game/3/edit#${draftHash(match, [[11, 5], [11, 7]], null, 1)}`,
  )
  await pad.waitForKey()
  await pad.enter({ You: '11', 'Your opponent': '9' })
  await pad.click('Submit result')
  await pad.waitForPath('/matches/demo/scores/submission')
  return new AwaitingValidationPage(pad.router)
}

describe('AwaitingValidation', () => {
  it('shows the submitted result after a submit', async () => {
    const page = await submitThreeNil()

    expect(page.heading).toHaveTextContent('Waiting for validation')
    expect(page.text).toContain(`${OPPONENT} confirms the result`)
    expect(page.result).toHaveTextContent(`${ME} wins 3–0`)
    expect(page.result).toHaveTextContent('Game 1 11–5')
  })

  it('links to the result in its URL, and shows its QR code', async () => {
    const page = await submitThreeNil()

    const link = await page.findLink()
    expect(page.qrCode).toBeInTheDocument()
    const [path, fragment] = link.getAttribute('href')!.split('#')
    expect(path).toBe('/matches/demo/scores/approvals/new')
    expect(fragment).toBe(page.hash)
    const { payload, signatures } = decodeEnvelope(fromBase64url(fragment))
    expect(decodePayload(payload).result).toMatchObject({
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

  it('shows the same result after a reload, and goes back to its scores', async () => {
    const { hash } = await submitThreeNil()
    cleanup()
    const reloaded = await AwaitingValidationPage.render(`/matches/demo/scores/submission#${hash}`)

    expect(reloaded.result).toHaveTextContent(`${ME} wins 3–0`)
    expect(reloaded.backLink).toHaveAttribute('href', `/matches/demo/scores/game/1/edit#${hash}`)
  })

  it.each([
    ['no result', ''],
    ['a damaged result', '#not-a-result'],
    ['a draft nobody approved', `#${draftHash(match, [[11, 5]], null, 1)}`],
  ])('says the page has no result for %s', async (_, fragment) => {
    const page = await AwaitingValidationPage.render(`/matches/demo/scores/submission${fragment}`)

    expect(page.heading).toHaveTextContent('This page has no result to share')
  })
})
