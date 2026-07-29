import type { ClaudeAccessStatus } from './claude-access-query'
import {
  buildClaudeAccessView,
  buildClaudeConnector,
} from './claude-access-view.factory'
import { claudeAccessViewPage } from './claude-access-view.page'
import { buildConnectedStatus } from './claude-access-view/status-row.factory'

/** Everyone the setup panel is *not* for, and why. */
const NOT_READY: [string, ClaudeAccessStatus][] = [
  ['a player with no email', { kind: 'guest' }],
  ['a player whose club is not switched on', { kind: 'gated' }],
  ['a player who switched agent access off', { kind: 'revoked' }],
  ['a player who has already connected', buildConnectedStatus()],
  ['a deployment with no connector to paste', { kind: 'unavailable' }],
]

describe('ClaudeAccessView', () => {
  it('shows the grant summary while there is still a grant to make', async () => {
    claudeAccessViewPage.render({
      view: buildClaudeAccessView({
        username: 'rita.kovac',
        status: { kind: 'ready', email: 'rita@club.tt' },
        showsPermissionsSummary: true,
      }),
    })

    await claudeAccessViewPage.findStatus()

    expect(claudeAccessViewPage.querySummary()).toBeInTheDocument()
    // Wiring only: the bullets' wording is pinned by the summary's own tests.
    expect(claudeAccessViewPage.getBullets()).toHaveLength(4)
  })

  it('drops the grant summary once an agent is connected', async () => {
    claudeAccessViewPage.render({
      view: buildClaudeAccessView({
        status: {
          kind: 'connected',
          email: 'rita@club.tt',
          connectedOn: 'May 12, 2026',
        },
        showsPermissionsSummary: false,
      }),
    })

    await claudeAccessViewPage.findStatus()

    expect(claudeAccessViewPage.queryPill('CONNECTED')).toBeInTheDocument()
    expect(claudeAccessViewPage.querySummary()).not.toBeInTheDocument()
  })

  it('hands a ready player the pair to paste', async () => {
    claudeAccessViewPage.render({
      view: buildClaudeAccessView({
        status: { kind: 'ready', email: 'rita@club.tt' },
        connector: buildClaudeConnector({ url: 'https://fortymm.test/mcp/' }),
      }),
    })

    await claudeAccessViewPage.findStatus()

    // Wiring only: the steps, the copy buttons and the marker are pinned by the
    // panel's own tests.
    expect(claudeAccessViewPage.setup.querySetupPanel()).toBeInTheDocument()
    expect(
      claudeAccessViewPage.setup.getCopyValue('Connector URL'),
    ).toHaveTextContent('https://fortymm.test/mcp/')
  })

  it('gives a revoked player the way back instead of the setup steps', async () => {
    claudeAccessViewPage.render({
      view: buildClaudeAccessView({
        status: { kind: 'revoked' },
        // A configured deployment, so the panel's absence is about the player's
        // state and not about having nothing to paste.
        connector: buildClaudeConnector(),
      }),
    })

    await claudeAccessViewPage.findStatus()

    // Both halves matter: printed steps a revoked player can follow are a
    // silent 401 they cannot diagnose, and the button is the only exit.
    expect(claudeAccessViewPage.setup.querySetupPanel()).toBeNull()
    expect(claudeAccessViewPage.getAllowButton()).toBeEnabled()
  })

  it.each(NOT_READY)(
    'withholds the setup panel from %s',
    async (_who, status) => {
      claudeAccessViewPage.render({
        view: buildClaudeAccessView({
          status,
          connector:
            status.kind === 'unavailable' ? null : buildClaudeConnector(),
          showsPermissionsSummary: status.kind !== 'connected',
        }),
      })

      await claudeAccessViewPage.findStatus()

      expect(claudeAccessViewPage.setup.querySetupPanel()).toBeNull()
    },
  )

  it('offers both accordions, closed, in every state', async () => {
    claudeAccessViewPage.render({
      view: buildClaudeAccessView({ status: { kind: 'unavailable' } }),
    })

    await claudeAccessViewPage.findStatus()

    const { accordions } = claudeAccessViewPage
    expect(accordions.queryAccordion('Capabilities and security')).not.toBeNull()
    expect(accordions.isOpen('Capabilities and security')).toBe(false)
    expect(accordions.queryAccordion('Troubleshooting')).not.toBeNull()
    expect(accordions.isOpen('Troubleshooting')).toBe(false)
  })

  it('spells out what an agent may do, and that a token is what carries it', async () => {
    claudeAccessViewPage.render()

    await claudeAccessViewPage.findStatus()

    const items = claudeAccessViewPage.accordions.getItems(
      'Capabilities and security',
    )
    expect(items).toHaveLength(6)
    expect(items[0]).toHaveTextContent(
      "Matches — start a match, enter scores, propose or accept a result, list what you've played, fix or clear a score.",
    )
    expect(items[3]).toHaveTextContent(
      'Sign-in — you sign in on FortyMM, in your browser, not inside Claude. Claude then holds an OAuth access token for your account and sends it with each request.',
    )
    expect(items[5]).toHaveTextContent(
      'Revoking — disconnect on this page and we stop authorizing requests immediately, even ones using a token Claude already holds.',
    )
  })

  it('names the four ways this goes wrong, by symptom', async () => {
    claudeAccessViewPage.render()

    await claudeAccessViewPage.findStatus()

    const items = claudeAccessViewPage.accordions.getItems('Troubleshooting')
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent(
      "Claude says you have no matches — it signed in with a different email, so it's reading a different account. Disconnect here, then sign in with the email shown above.",
    )
    expect(items[3]).toHaveTextContent(
      "Claude can't reach the connector — check the connector URL for a typo. A wrong hostname won't authorize anyone.",
    )
  })
})
