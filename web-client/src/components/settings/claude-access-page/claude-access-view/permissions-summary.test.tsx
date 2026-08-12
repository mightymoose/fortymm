import { permissionsSummaryPage } from './permissions-summary.page'

describe('PermissionsSummary', () => {
  it('says the agent deletes, not only creates and updates', () => {
    permissionsSummaryPage.render()

    // The load-bearing word on the whole page: there is no server-side
    // confirmation between the agent and a delete, so the consent copy has to
    // name it. A summary that only promised "creates and updates" would
    // understate the grant.
    expect(permissionsSummaryPage.getBullets()[0]).toHaveTextContent(
      'Claude creates, updates and deletes matches, entries and draws as you',
    )
  })

  it('names the account everything will appear under', () => {
    permissionsSummaryPage.render({ username: 'rita.kovac' })

    expect(permissionsSummaryPage.getBullets()[0]).toHaveTextContent(
      'everything appears under rita.kovac',
    )
  })

  it('bounds the read scope to the player and public records', () => {
    permissionsSummaryPage.render()

    expect(permissionsSummaryPage.getBullets()[1]).toHaveTextContent(
      "It reads your account data and public player records — never another player's private account.",
    )
  })

  it("states that the agent is held to the player's own permissions", () => {
    permissionsSummaryPage.render()

    expect(permissionsSummaryPage.getBullets()[2]).toHaveTextContent(
      'Claude can never do more than you can do yourself — every action is held to your own permissions.',
    )
  })

  it('says what disconnecting does and does not undo', () => {
    permissionsSummaryPage.render()

    expect(permissionsSummaryPage.getBullets()[3]).toHaveTextContent(
      'You can disconnect at any time. Anything Claude logged stays on your account.',
    )
  })

  it('renders under a "What you\'re granting" heading', () => {
    permissionsSummaryPage.render()

    expect(permissionsSummaryPage.querySummary()).toBeInTheDocument()
    expect(permissionsSummaryPage.getBullets()).toHaveLength(4)
  })
})
