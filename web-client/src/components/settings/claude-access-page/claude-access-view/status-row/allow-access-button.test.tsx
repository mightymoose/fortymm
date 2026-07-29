import { HttpResponse, delay } from 'msw'

import { waitFor } from '@/test/utilities'
import { buildAgentAccess } from '@/mocks/factories/settings/agent-access.factory'
import { allowAccessButtonPage } from './allow-access-button.page'

const PENDING_NOTE = 'Switching Claude access back on…'
const FAILURE_NOTE =
  "We couldn't switch Claude access back on. Try again in a moment."

describe('AllowAccessButton', () => {
  it('offers the press with nothing else to read', () => {
    allowAccessButtonPage.render()

    expect(allowAccessButtonPage.getAllowButton()).toBeEnabled()
    // The live region exists from first paint — that is what makes anything
    // landing in it get announced — but says nothing yet.
    expect(allowAccessButtonPage.getAllowNote()).toBeEmptyDOMElement()
  })

  it('asks the server to clear the revocation', async () => {
    const calls: string[] = []
    allowAccessButtonPage.mockEndpoint(({ request }) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`)
      return HttpResponse.json(buildAgentAccess({ state: 'ready' }))
    })
    allowAccessButtonPage.render()

    await allowAccessButtonPage.clickAllow()

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatch(/^POST .*\/v1\/settings\/agent-access\/allow$/)
  })

  it('says the switch is being flipped, and refuses a second press meanwhile', async () => {
    allowAccessButtonPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(buildAgentAccess({ state: 'ready' }))
    })
    allowAccessButtonPage.render()

    await allowAccessButtonPage.clickAllow()

    expect(allowAccessButtonPage.getAllowNote()).toHaveTextContent(PENDING_NOTE)
    // A second POST would buy nothing and lose the first request's answer.
    expect(allowAccessButtonPage.getAllowButton()).toBeDisabled()

    // And it is transient: once the server answers, the region falls silent
    // and the press is available again.
    await waitFor(() =>
      expect(allowAccessButtonPage.getAllowNote()).toBeEmptyDOMElement(),
    )
    expect(allowAccessButtonPage.getAllowButton()).toBeEnabled()
  })

  it('says a refused re-allow did not work, and leaves the press available', async () => {
    allowAccessButtonPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    )
    allowAccessButtonPage.render()

    await allowAccessButtonPage.clickAllow()

    await waitFor(() =>
      expect(allowAccessButtonPage.getAllowNote()).toHaveTextContent(
        FAILURE_NOTE,
      ),
    )
    // Pressing again is the whole remedy, so the button must come back.
    expect(allowAccessButtonPage.getAllowButton()).toBeEnabled()
    expect(allowAccessButtonPage.getAllowNote()).toHaveClass(
      'fmm-claude__allow-note--failed',
    )
  })

  it('refuses a payload it cannot trust rather than claim the switch flipped', async () => {
    // The server's own contract says this endpoint returns the page's whole new
    // state; a body that isn't one is a failure, not a success with holes.
    allowAccessButtonPage.mockEndpoint(() =>
      HttpResponse.json({ state: 'nonsense' } as never),
    )
    allowAccessButtonPage.render()

    await allowAccessButtonPage.clickAllow()

    await waitFor(() =>
      expect(allowAccessButtonPage.getAllowNote()).toHaveTextContent(
        FAILURE_NOTE,
      ),
    )
  })
})
