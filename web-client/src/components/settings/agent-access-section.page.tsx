import { http, HttpResponse } from 'msw'

import { render, screen, type Container } from '@/test/utilities'
import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { SessionProbe } from '@/test/session-probe'
import { mockAuth0LinkStatusEndpoint } from '@/mocks/endpoints/auth0/auth0-link.endpoint'

import { AgentAccessSection } from './agent-access-section'
import { buildLinkStatus } from './agent-access-section.factory'

const scoped = (container: Container) => ({
  /** The whole section — absent for a user without `mcp.access`. */
  querySection() {
    return container.queryByRole('region', { name: /agent access/i })
  },
  /** The "Connected" badge shown in the linked state's header. */
  queryConnectedBadge() {
    return container.queryByText('Connected')
  },
  /** The Unlink control — present only in the linked state. */
  queryUnlinkButton() {
    return container.queryByRole('button', { name: /unlink/i })
  },
  findUnlinkButton() {
    return container.findByRole('button', { name: /unlink/i })
  },
  /** The Connect affordance — a real link (full navigation to the OAuth
   * redirect), present only in the not-connected state. */
  queryConnectLink() {
    return container.queryByRole('link', { name: /connect/i })
  },
  findConnectLink() {
    return container.findByRole('link', { name: /connect/i })
  },
  /** The signal that `GET /v1/session` has resolved — `await` it before
   * asserting the section's *absence*, or a still-loading session reads as
   * "no permission" and the assertion proves nothing. */
  findSessionReady() {
    return container.findByTestId('session-ready')
  },
})

/** Bumped each time `DELETE /v1/auth0/link` is hit — proves the Unlink click
 * actually calls the endpoint. */
let unlinkCallCount = 0

export const agentAccessSectionPage = {
  render() {
    render(
      <>
        <AgentAccessSection />
        <SessionProbe />
      </>,
    )
  },

  /** Make `GET /v1/session` return a user with the given permission list. */
  signInWithPermissions(permissions: string[]) {
    server.use(
      http.get('*/v1/session', () =>
        HttpResponse.json(sessionResponse({ user: { permissions } })),
      ),
    )
  },

  /** Stub `GET /v1/auth0/link` to report a fixed link status. */
  mockLinkStatus(linked: boolean) {
    mockAuth0LinkStatusEndpoint(server, () =>
      HttpResponse.json(buildLinkStatus({ linked })),
    )
  },

  /** Stub `DELETE /v1/auth0/link` to return the now-cleared status and count
   * the calls, so a test can assert the Unlink click hit the endpoint. */
  stubUnlink() {
    unlinkCallCount = 0
    server.use(
      http.delete('*/v1/auth0/link', () => {
        unlinkCallCount += 1
        return HttpResponse.json(buildLinkStatus({ linked: false }))
      }),
    )
  },

  unlinkCallCount() {
    return unlinkCallCount
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
