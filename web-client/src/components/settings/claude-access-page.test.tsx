import { HttpResponse } from 'msw'

import { waitFor } from '@/test/utilities'
import { buildAgentAccess } from '@/mocks/factories/settings/agent-access.factory'
import { claudeAccessPagePage } from './claude-access-page.page'

describe('ClaudeAccessPage', () => {
  it('leads with what saying something to Claude actually does', async () => {
    claudeAccessPagePage.mockEndpoint(() =>
      HttpResponse.json(buildAgentAccess()),
    )
    claudeAccessPagePage.render()

    await claudeAccessPagePage.findHeading()

    expect(claudeAccessPagePage.queryLede()).toBeInTheDocument()
  })

  it('tells a ready player which email to connect with', async () => {
    claudeAccessPagePage.mockEndpoint(() =>
      HttpResponse.json(
        buildAgentAccess({ state: 'ready', email: 'rita@club.tt' }),
      ),
    )
    claudeAccessPagePage.render()

    await claudeAccessPagePage.findStatus()

    expect(claudeAccessPagePage.queryPill('READY TO CONNECT')).toBeInTheDocument()
    // Scoped to the row: the setup panel prints the same address in step 3, and
    // an unscoped match would no longer say which surface carried it.
    expect(
      claudeAccessPagePage.queryStatusCopy('rita@club.tt'),
    ).toBeInTheDocument()
    expect(claudeAccessPagePage.querySummary()).toBeInTheDocument()
  })

  it('gives a ready player the connector pair to paste', async () => {
    claudeAccessPagePage.mockEndpoint(() =>
      HttpResponse.json(buildAgentAccess({ state: 'ready' })),
    )
    claudeAccessPagePage.render()

    await claudeAccessPagePage.findStatus()

    // Wiring only: the panel's steps and copy behaviour are pinned by its own
    // tests.
    expect(claudeAccessPagePage.setup.querySetupPanel()).toBeInTheDocument()
    expect(
      claudeAccessPagePage.setup.getCopyValue('Connector URL'),
    ).toHaveTextContent('https://fortymm.com/api/mcp/')
  })

  it('asks a player with no email to add one', async () => {
    claudeAccessPagePage.mockEndpoint(() =>
      HttpResponse.json(buildAgentAccess({ state: 'guest', email: null })),
    )
    claudeAccessPagePage.render()

    await claudeAccessPagePage.findStatus()

    expect(claudeAccessPagePage.queryPill('EMAIL NEEDED')).toBeInTheDocument()
    expect(claudeAccessPagePage.queryPill('READY TO CONNECT')).not.toBeInTheDocument()
  })

  it('tells a gated player their club is not switched on yet', async () => {
    claudeAccessPagePage.mockEndpoint(() =>
      HttpResponse.json(buildAgentAccess({ state: 'gated' })),
    )
    claudeAccessPagePage.render()

    await claudeAccessPagePage.findStatus()

    expect(claudeAccessPagePage.queryPill('NOT ENABLED')).toBeInTheDocument()
    expect(claudeAccessPagePage.queryAction('Ask for access')).toBeInTheDocument()
  })

  it('withholds the setup steps from a player who switched Claude access off', async () => {
    claudeAccessPagePage.mockEndpoint(() =>
      HttpResponse.json(buildAgentAccess({ state: 'revoked' })),
    )
    claudeAccessPagePage.render()

    await claudeAccessPagePage.findStatus()

    expect(claudeAccessPagePage.queryPill('TURNED OFF')).toBeInTheDocument()
    // The dead end this state exists to prevent: the steps work exactly as
    // printed and every agent request still 401s, with nothing saying why.
    expect(claudeAccessPagePage.setup.querySetupPanel()).toBeNull()
    expect(claudeAccessPagePage.getAllowButton()).toBeEnabled()
  })

  it('puts the page back to ready once the player allows Claude to connect', async () => {
    claudeAccessPagePage.mockEndpoint(() =>
      HttpResponse.json(buildAgentAccess({ state: 'revoked' })),
    )
    // The endpoint answers with the page's whole new state, which is what the
    // page renders from — no follow-up read, so the GET stub above deliberately
    // still says `revoked` and cannot be what turns this green.
    claudeAccessPagePage.mockAllowEndpoint(() =>
      HttpResponse.json(
        buildAgentAccess({ state: 'ready', email: 'rita@club.tt' }),
      ),
    )
    claudeAccessPagePage.render()
    await claudeAccessPagePage.findStatus()

    await claudeAccessPagePage.clickAllow()

    await waitFor(() =>
      expect(
        claudeAccessPagePage.queryPill('READY TO CONNECT'),
      ).toBeInTheDocument(),
    )
    expect(claudeAccessPagePage.queryPill('TURNED OFF')).not.toBeInTheDocument()
    expect(claudeAccessPagePage.queryAllowButton()).not.toBeInTheDocument()
    // The steps come back with it — that is what being ready again means.
    expect(claudeAccessPagePage.setup.querySetupPanel()).toBeInTheDocument()
    expect(
      claudeAccessPagePage.setup.getCopyValue('Connector URL'),
    ).toHaveTextContent('https://fortymm.com/api/mcp/')
  })

  it('shows a connected player which account and when, and drops the grant summary', async () => {
    claudeAccessPagePage.mockEndpoint(() =>
      HttpResponse.json(
        buildAgentAccess({
          state: 'connected',
          email: 'rita@club.tt',
          connected_on: '2026-05-12T09:30:00Z',
        }),
      ),
    )
    claudeAccessPagePage.render()

    await claudeAccessPagePage.findStatus()

    expect(claudeAccessPagePage.queryPill('CONNECTED')).toBeInTheDocument()
    expect(claudeAccessPagePage.getFieldValue('Signed in as')).toHaveTextContent(
      'rita@club.tt',
    )
    expect(claudeAccessPagePage.getFieldValue('Connected')).toHaveTextContent(
      'May 12, 2026',
    )
    expect(claudeAccessPagePage.querySummary()).not.toBeInTheDocument()
  })

  it('takes a connected player out of the connected state on a confirmed disconnect', async () => {
    claudeAccessPagePage.mockEndpoint(() =>
      HttpResponse.json(
        buildAgentAccess({
          state: 'connected',
          email: 'rita@club.tt',
          connected_on: '2026-05-12T09:30:00Z',
        }),
      ),
    )
    // As with the allow endpoint, the disconnect answers with the page's whole
    // new state — so the GET stub above deliberately still says `connected` and
    // cannot be what turns this green.
    claudeAccessPagePage.mockDisconnectEndpoint(() =>
      HttpResponse.json(buildAgentAccess({ state: 'revoked' })),
    )
    claudeAccessPagePage.render()
    await claudeAccessPagePage.findStatus()

    await claudeAccessPagePage.clickDisconnect()
    await claudeAccessPagePage.findDialog()
    await claudeAccessPagePage.clickConfirm()

    await waitFor(() =>
      expect(claudeAccessPagePage.queryPill('TURNED OFF')).toBeInTheDocument(),
    )
    expect(claudeAccessPagePage.queryPill('CONNECTED')).not.toBeInTheDocument()
    expect(claudeAccessPagePage.queryDisconnectButton()).toBeNull()
    // Revocation is sticky, so the one control that clears it comes with the
    // new state — and the setup steps deliberately do not.
    expect(claudeAccessPagePage.getAllowButton()).toBeEnabled()
    expect(claudeAccessPagePage.setup.querySetupPanel()).toBeNull()
  })

  it('refuses to render a state it cannot act on when the connector is absent', async () => {
    claudeAccessPagePage.mockEndpoint(() =>
      HttpResponse.json(buildAgentAccess({ state: 'ready', connector: null })),
    )
    claudeAccessPagePage.render()

    await claudeAccessPagePage.findStatus()

    expect(claudeAccessPagePage.queryPill('UNAVAILABLE')).toBeInTheDocument()
    expect(claudeAccessPagePage.queryPill('READY TO CONNECT')).not.toBeInTheDocument()
    // The player's email is a real value the ready row would have shown; with
    // no connector there is nothing to paste it into, so it must not appear at
    // all rather than appear beside empty connector fields.
    expect(claudeAccessPagePage.queryCopy('rita@example.com')).not.toBeInTheDocument()
  })

  it('says so, in the same words, when the load itself fails', async () => {
    claudeAccessPagePage.mockEndpoint(() => new HttpResponse(null, { status: 500 }))
    claudeAccessPagePage.render()

    await claudeAccessPagePage.findStatus()

    expect(claudeAccessPagePage.queryPill('UNAVAILABLE')).toBeInTheDocument()
    // No username to name, so the grant summary would have an empty subject.
    expect(claudeAccessPagePage.querySummary()).not.toBeInTheDocument()
    // The reference material stands on its own and stays.
    expect(
      claudeAccessPagePage.accordions.queryAccordion('Troubleshooting'),
    ).not.toBeNull()
  })
})
