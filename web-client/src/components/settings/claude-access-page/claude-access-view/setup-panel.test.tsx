import { buildClaudeConnector } from '../claude-access-view.factory'
import { setupPanelPage } from './setup-panel.page'

/** The client-id field's label carries a "where to find it" aside, so tests
 * reach it by the part that identifies it. */
const CLIENT_ID_FIELD = /^Client ID/

describe('SetupPanel', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('walks a player through three steps, in the order Claude asks for them', () => {
    setupPanelPage.render()

    const steps = setupPanelPage.getSteps()
    expect(steps).toHaveLength(3)
    expect(steps[0]).toHaveTextContent(
      'In Claude, open Settings → Connectors → Add custom connector',
    )
    expect(steps[1]).toHaveTextContent(
      'Paste the connector URL and the client ID',
    )
    expect(steps[2]).toHaveTextContent(
      'Select Connect, and sign in with this email',
    )
  })

  it('shows the exact pair this deployment issues', () => {
    setupPanelPage.render({
      connector: buildClaudeConnector({
        url: 'https://uat.fortymm.com/api/mcp/',
        client_id: 'zZ99yY88xX77',
      }),
    })

    expect(setupPanelPage.getCopyValue('Connector URL')).toHaveTextContent(
      'https://uat.fortymm.com/api/mcp/',
    )
    expect(setupPanelPage.getCopyValue(CLIENT_ID_FIELD)).toHaveTextContent(
      'zZ99yY88xX77',
    )
  })

  it('warns that the client secret stays empty', () => {
    setupPanelPage.render()

    expect(setupPanelPage.getSteps()[1]).toHaveTextContent(
      'Leave client secret empty',
    )
  })

  it('names the account Claude has to sign in as, and what a different one costs', () => {
    setupPanelPage.render({ email: 'rita@club.tt' })

    expect(setupPanelPage.queryPanelEmail('rita@club.tt')).toBeInTheDocument()
    expect(setupPanelPage.getSteps()[2]).toHaveTextContent(
      'Choose this account when Claude asks you to sign in. Another email opens a different FortyMM account.',
    )
  })

  it('gives a player one sentence that proves the connection works', () => {
    setupPanelPage.render()

    expect(setupPanelPage.getSteps()[2]).toHaveTextContent(
      "Then ask Claude list my matches. If Claude returns your recent matches, you're connected.",
    )
  })

  it('puts the connector URL on the clipboard, and marks that field alone', async () => {
    setupPanelPage.render({
      connector: buildClaudeConnector({ url: 'https://fortymm.test/api/mcp/' }),
    })

    await setupPanelPage.clickCopy('Copy URL')

    expect(
      await setupPanelPage.findCopiedMarker('Connector URL'),
    ).toBeInTheDocument()
    expect(setupPanelPage.getClipboardWrites()).toEqual([
      'https://fortymm.test/api/mcp/',
    ])
    // The crux: a marker on both fields would leave a player unable to tell
    // which value they are actually holding.
    expect(setupPanelPage.queryCopiedMarker(CLIENT_ID_FIELD)).toBeNull()
  })

  it('moves the marker to the client id when that is copied next', async () => {
    setupPanelPage.render({
      connector: buildClaudeConnector({
        url: 'https://fortymm.test/api/mcp/',
        client_id: 'zZ99yY88xX77',
      }),
    })

    await setupPanelPage.clickCopy('Copy URL')
    await setupPanelPage.findCopiedMarker('Connector URL')
    await setupPanelPage.clickCopy('Copy client ID')

    expect(
      await setupPanelPage.findCopiedMarker(CLIENT_ID_FIELD),
    ).toBeInTheDocument()
    expect(setupPanelPage.queryCopiedMarker('Connector URL')).toBeNull()
    expect(setupPanelPage.getClipboardWrites()).toEqual([
      'https://fortymm.test/api/mcp/',
      'zZ99yY88xX77',
    ])
  })

  it('announces the copy politely, rather than only showing it', async () => {
    setupPanelPage.render()

    expect(setupPanelPage.getAnnouncer()).toBeEmptyDOMElement()

    await setupPanelPage.clickCopy('Copy client ID')

    const announcer = setupPanelPage.getAnnouncer()
    // Polite, not assertive: the player pressed the button, so nothing here
    // justifies interrupting whatever they were being read.
    expect(announcer).toHaveAttribute('aria-live', 'polite')
    // It names the FIELD — with two copy buttons, a bare "Copied" leaves a
    // screen-reader user exactly as unsure as no announcement would.
    await expect
      .poll(() => announcer.textContent)
      .toBe('Client ID copied to the clipboard.')
  })

  it('takes the marker down on its own', async () => {
    vi.useFakeTimers()
    setupPanelPage.render()

    await setupPanelPage.clickCopyOnAFakeClock('Copy URL')
    expect(
      setupPanelPage.queryCopiedMarker('Connector URL'),
    ).toBeInTheDocument()

    await setupPanelPage.runMarkerClock()

    expect(setupPanelPage.queryCopiedMarker('Connector URL')).toBeNull()
  })

  it('says what to do instead when the clipboard refuses', async () => {
    setupPanelPage.render({}, { clipboard: 'rejects' })

    await setupPanelPage.clickCopy('Copy URL')

    expect(
      await setupPanelPage.findCopyError('Connector URL'),
    ).toBeInTheDocument()
    // Claiming COPIED over a failed write is the one outcome worse than the
    // failure itself.
    expect(setupPanelPage.queryCopiedMarker('Connector URL')).toBeNull()
    await expect
      .poll(() => setupPanelPage.getAnnouncer().textContent)
      .toBe(
        "We couldn't copy the Connector URL. Select the value and copy it yourself.",
      )
  })

  it('stays on its feet in a browser with no clipboard at all', async () => {
    setupPanelPage.render({}, { clipboard: 'absent' })

    await setupPanelPage.clickCopy('Copy URL')

    expect(
      await setupPanelPage.findCopyError('Connector URL'),
    ).toBeInTheDocument()
    // The values are still on screen and still selectable, which is what the
    // failure line tells the player to use.
    expect(setupPanelPage.getCopyValue('Connector URL')).toHaveTextContent(
      'https://fortymm.com/api/mcp/',
    )
  })
})
