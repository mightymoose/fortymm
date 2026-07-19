import { http, HttpResponse } from 'msw'
import { render, screen, type Container } from '@/test/utilities'
import { server } from '@/mocks/server'
import { apiTokenCreated, sessionResponse } from '@/test/factories'
import { ApiTokensPage } from './api-tokens-page'

const scoped = (container: Container) => ({
  /** The Generate/Regenerate control — the affordance gated on
   * `api_token.manage`. Absent for a viewer who lacks the grant. */
  queryGenerateButton() {
    return container.queryByRole('button', { name: /generate token/i })
  },
  /** The shared `AccessDenied` panel shown in the ungated state. */
  queryNoPermission() {
    return container.queryByText("You don't have access to this page")
  },
  /** The one-time password caution that fronts a revealed token. */
  queryPasswordCaution() {
    return container.queryByText(/won't be shown again/i)
  },
  /** The revealed raw token, addressed by its exact value. */
  queryToken(token: string) {
    return container.queryByText(token)
  },
})

/** Bumped by `stubGeneratedToken` each time the mint endpoint is hit — proves a
 * Generate click actually calls `POST /v1/api-tokens`. */
let createCallCount = 0

export const apiTokensPageObject = {
  render() {
    render(<ApiTokensPage />)
  },

  /** Make `GET /v1/session` return a user with the given permission list. */
  signInWithPermissions(permissions: string[]) {
    server.use(
      http.get('*/v1/session', () =>
        HttpResponse.json(sessionResponse({ user: { permissions } })),
      ),
    )
  },

  /** Stub `POST /v1/api-tokens` to return a fixed raw token, and count the
   * calls so a test can assert the mint endpoint was actually hit. */
  stubGeneratedToken(token: string) {
    createCallCount = 0
    server.use(
      http.post('*/v1/api-tokens', () => {
        createCallCount += 1
        return HttpResponse.json(apiTokenCreated({ token }), { status: 201 })
      }),
    )
  },

  createCallCount() {
    return createCallCount
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
