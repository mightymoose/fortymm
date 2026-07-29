import {
  buildConnectedStatus,
  buildReadyStatus,
} from './status-row.factory'
import { statusRowPage } from './status-row.page'

/** Every pill this row can show. A state's test asserts its own is present and
 * that none of the others is — "only its own row" is a claim about absence. */
const ALL_PILLS = [
  'UNAVAILABLE',
  'EMAIL NEEDED',
  'NOT ENABLED',
  'TURNED OFF',
  'READY TO CONNECT',
  'CONNECTED',
]

function expectOnlyPill(label: string) {
  expect(statusRowPage.queryPill(label)).toBeInTheDocument()
  for (const other of ALL_PILLS.filter((p) => p !== label)) {
    expect(statusRowPage.queryPill(other)).not.toBeInTheDocument()
  }
}

describe('StatusRow', () => {
  it('tells a ready player which email to sign in with', async () => {
    statusRowPage.render({ status: buildReadyStatus({ email: 'rita@club.tt' }) })

    await statusRowPage.findStatus()

    expectOnlyPill('READY TO CONNECT')
    expect(statusRowPage.queryCopy('rita@club.tt')).toBeInTheDocument()
  })

  it('sends a player with no email to the settings email section', async () => {
    statusRowPage.render({ status: { kind: 'guest' } })

    await statusRowPage.findStatus()

    expectOnlyPill('EMAIL NEEDED')
    expect(
      statusRowPage.queryCopy(
        'Claude signs in by email. Add one to your account first.',
      ),
    ).toBeInTheDocument()
    expect(statusRowPage.queryAction('Add an email')).toHaveAttribute(
      'href',
      '/settings#sec-email',
    )
  })

  it('offers a gated player a way to ask for access', async () => {
    statusRowPage.render({ status: { kind: 'gated' } })

    await statusRowPage.findStatus()

    expectOnlyPill('NOT ENABLED')
    expect(
      statusRowPage.queryCopy(
        "We're switching Claude access on club by club. Requests are declined until yours is on.",
      ),
    ).toBeInTheDocument()
    expect(statusRowPage.queryAction('Ask for access')).toHaveAttribute(
      'href',
      'mailto:support@fortymm.com?subject=Claude%20access',
    )
  })

  it('offers a revoked player the one control that turns access back on', async () => {
    statusRowPage.render({ status: { kind: 'revoked' } })

    await statusRowPage.findStatus()

    expectOnlyPill('TURNED OFF')
    expect(
      statusRowPage.queryCopy(
        'Claude access is switched off for your account. No agent can read or change anything until you turn it back on.',
      ),
    ).toBeInTheDocument()
    expect(statusRowPage.getAllowButton()).toBeEnabled()
  })

  it.each([
    ['ready', buildReadyStatus()],
    ['guest', { kind: 'guest' } as const],
    ['gated', { kind: 'gated' } as const],
    ['unavailable', { kind: 'unavailable' } as const],
    ['connected', buildConnectedStatus()],
  ])('offers no re-allow control in the %s state', async (_kind, status) => {
    statusRowPage.render({ status })

    await statusRowPage.findStatus()

    // Only a revoked account has a revocation to clear; anywhere else the
    // button would be a no-op the player has to reason about.
    expect(statusRowPage.queryAllowButton()).not.toBeInTheDocument()
  })

  it('says the details could not be loaded, and offers no action to take', async () => {
    statusRowPage.render({ status: { kind: 'unavailable' } })

    await statusRowPage.findStatus()

    expectOnlyPill('UNAVAILABLE')
    expect(
      statusRowPage.queryCopy(
        "We couldn't load your account and connector details. Reload the page, or try again in a minute.",
      ),
    ).toBeInTheDocument()
    expect(statusRowPage.queryAction('Add an email')).not.toBeInTheDocument()
    expect(statusRowPage.queryAction('Ask for access')).not.toBeInTheDocument()
  })

  it('names the account and the date an agent was connected', async () => {
    statusRowPage.render({
      status: buildConnectedStatus({
        email: 'rita@club.tt',
        connectedOn: 'May 12, 2026',
      }),
    })

    await statusRowPage.findStatus()

    expectOnlyPill('CONNECTED')
    expect(
      statusRowPage.queryCopy('Claude can act on your account'),
    ).toBeInTheDocument()
    expect(statusRowPage.getFieldValue('Signed in as')).toHaveTextContent(
      'rita@club.tt',
    )
    expect(statusRowPage.getFieldValue('Connected')).toHaveTextContent(
      'May 12, 2026',
    )
  })

  it('offers a connected player the way to switch agent access off', async () => {
    statusRowPage.render({ status: buildConnectedStatus() })

    await statusRowPage.findStatus()

    expect(statusRowPage.getDisconnectButton()).toBeEnabled()
    // The press asks; it does not act. The confirmation is what disconnects.
    expect(statusRowPage.queryDialog()).toBeNull()
  })

  it.each([
    ['ready', buildReadyStatus()],
    ['guest', { kind: 'guest' } as const],
    ['gated', { kind: 'gated' } as const],
    ['revoked', { kind: 'revoked' } as const],
    ['unavailable', { kind: 'unavailable' } as const],
  ])('offers no disconnect control in the %s state', async (_kind, status) => {
    statusRowPage.render({ status })

    await statusRowPage.findStatus()

    // Only a connected account has a link to cut; anywhere else the button
    // would be a destructive-looking no-op the player has to reason about —
    // and in `revoked` it would sit next to the control that undoes it.
    expect(statusRowPage.queryDisconnectButton()).toBeNull()
  })
})
