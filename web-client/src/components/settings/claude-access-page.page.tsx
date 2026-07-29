import { screen, type Container } from '@/test/utilities'
import { renderWithRoutes } from '@/test/router'
import {
  mockAgentAccessEndpoint,
  type AgentAccessResolver,
} from '@/mocks/endpoints/settings/agent-access.endpoint'
import { server } from '@/mocks/server'
import { ClaudeAccessPage } from './claude-access-page'
import { claudeAccessViewPage } from './claude-access-page/claude-access-view.page'
import { allowAccessButtonPage } from './claude-access-page/claude-access-view/status-row/allow-access-button.page'
import { disconnectButtonPage } from './claude-access-page/claude-access-view/status-row/disconnect-button.page'

const scoped = (container: Container) => ({
  /** The page's H1. */
  findHeading() {
    return container.findByRole('heading', { name: 'Claude access', level: 1 })
  },
  /** The one-line explanation under the title. */
  queryLede() {
    return container.queryByText(
      'Say what happened and Claude logs the match, checks your rating, or sets up a draw — as you, in your account.',
    )
  },
  ...claudeAccessViewPage.within(container),
})

/**
 * Test page-object for `ClaudeAccessPage`.
 *
 * The page fetches, and its guest row renders a typed `<Link>`, so it mounts
 * under the memory-router harness and every test starts with an `await find…()`.
 * Stub the endpoint with `mockEndpoint` **before** rendering.
 */
export const claudeAccessPagePage = {
  /** Override `GET /v1/settings/agent-access` for this test. */
  mockEndpoint(resolver: AgentAccessResolver) {
    mockAgentAccessEndpoint(server, resolver)
  },

  /** Override `POST /v1/settings/agent-access/allow` — the revoked row's write. */
  mockAllowEndpoint: allowAccessButtonPage.mockEndpoint,

  /** Press "Allow Claude to connect" on the revoked row. */
  clickAllow: allowAccessButtonPage.clickAllow,

  /** Override `POST /v1/settings/agent-access/disconnect` — the connected
   * card's write. */
  mockDisconnectEndpoint: disconnectButtonPage.mockEndpoint,

  render() {
    renderWithRoutes(<ClaudeAccessPage />, { linkTargets: ['/settings'] })
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
