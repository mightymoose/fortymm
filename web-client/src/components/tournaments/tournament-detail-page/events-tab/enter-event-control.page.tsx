import { http, HttpResponse } from 'msw'

import { PERM } from '@/lib/permissions'
import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { SessionProbe } from '@/test/session-probe'
import { render, screen, type Container } from '@/test/utilities'

import { EnterEventControl, type EnterEventControlProps } from './enter-event-control'
import { buildEnterEventControlProps } from './enter-event-control.factory'

/** The signed-in player these tests act as, unless a case says otherwise. */
export const SIGNED_IN_USERNAME = 'rita.kovac'

const scoped = (container: Container) => ({
  /** The Enter control for `eventName` — absent when the player is entered, is
   * unpermitted, or the event isn't singles. */
  queryEnterButton(eventName: string) {
    return container.queryByRole('button', { name: `Enter ${eventName}` })
  },
  findEnterButton(eventName: string) {
    return container.findByRole('button', { name: `Enter ${eventName}` })
  },
  /** The Withdraw control for `eventName` — shown only when the signed-in player
   * holds an active entry in it. */
  queryWithdrawButton(eventName: string) {
    return container.queryByRole('button', { name: `Withdraw from ${eventName}` })
  },
  findWithdrawButton(eventName: string) {
    return container.findByRole('button', { name: `Withdraw from ${eventName}` })
  },
  /** Resolves once the session has landed (`SessionProbe`) — gate absence
   * assertions on this, or they pass vacuously while it is still in flight. */
  findSessionReady() {
    return container.findByTestId('session-ready')
  },
})

/**
 * Test page-object for `EnterEventControl`. The control reads `/v1/session` for
 * the player's permissions **and** their username (membership is a username
 * join — the session has no user id), so `render` stubs the session per
 * scenario; the enter/withdraw endpoints are stubbed per test.
 */
export const enterEventControlPage = {
  /**
   * Stub the session, then render the control (alongside the session probe).
   * Defaults to a beta tester who holds `tournament.enter`; pass `permissions: []`
   * for the unpermitted case, or a different `username` to change who you are.
   */
  render(
    overrides: Partial<EnterEventControlProps> = {},
    session: { permissions?: string[]; username?: string } = {},
  ) {
    const {
      permissions = [PERM.TOURNAMENT_VIEW, PERM.TOURNAMENT_ENTER],
      username = SIGNED_IN_USERNAME,
    } = session
    server.use(
      http.get('*/v1/session', () =>
        HttpResponse.json(sessionResponse({ user: { username, permissions } })),
      ),
    )
    render(
      <>
        <SessionProbe />
        <EnterEventControl {...buildEnterEventControlProps(overrides)} />
      </>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
