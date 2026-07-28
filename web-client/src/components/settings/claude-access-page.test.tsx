import { HttpResponse } from 'msw'

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
