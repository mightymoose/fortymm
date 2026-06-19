import { http, HttpResponse } from 'msw'
import { render, screen, type Container } from '@/test/utilities'
import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { BroadcastPage } from './broadcast-page'

const scoped = (container: Container) => ({
  /** The compose heading only renders once the tool is mounted. */
  queryComposeHeading() {
    return container.queryByRole('heading', { name: 'Compose' })
  },
  queryAccessDenied() {
    return container.queryByText("You don't have access to this page")
  },
})

export const broadcastPageObject = {
  render() {
    render(<BroadcastPage />)
  },

  /** Make `GET /v1/session` return a user with the given permission list. */
  signInWithPermissions(permissions: string[]) {
    server.use(
      http.get('*/v1/session', () =>
        HttpResponse.json(sessionResponse({ user: { permissions } })),
      ),
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
