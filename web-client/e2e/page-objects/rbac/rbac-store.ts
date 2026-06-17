import type { Locator, Page, Request as PWRequest, Route } from '@playwright/test'
import { PERM } from '../../../src/lib/permissions'
import { sessionResponse } from '../../../src/test/factories'
import {
  createRbacState,
  dispatchRbac,
  type Permission,
  type RbacState,
  type RbacUser,
  type Role,
  type SeedSpec,
} from '../../../src/mocks/rbac-engine'

export type { Permission, RbacUser, Role, SeedSpec }

// The default session carries both admin permissions so the existing RBAC
// e2e tests see the full Roles/Permissions/Users sub-nav. Suites that need
// a non-admin session should layer their own page.route('**/v1/session')
// AFTER calling RbacStore.install() so it wins by recency.
const SESSION = sessionResponse({
  user: {
    username: 'rita.kovac',
    permissions: [PERM.ADMIN_VIEW, PERM.AUTH_MANAGE],
  },
})

/**
 * Answer `/v1/session` with an admin session, nothing else. The `_app` layout
 * loader establishes the session before any admin route renders, so MSW-off
 * specs that bare-`goto` an admin URL (rather than going through
 * `RbacStore.install`) must still answer the session bootstrap — otherwise the
 * loader hangs on the session-loader screen and the page never mounts.
 */
export async function mockAdminSession(page: Page) {
  await page.route('**/v1/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SESSION),
    }),
  )
}

export interface FailureSpec {
  /** Matched against `${method} ${url}` — substring (string) or regex. */
  pattern: RegExp | string
  status: number
  body?: unknown
  /** Apply the failure for the first N matching requests, then succeed. */
  times?: number
  /** Hold the response for this many ms before replying. */
  delayMs?: number
}

export class RbacStore {
  private state: RbacState
  private failures: FailureSpec[] = []
  public readonly requests: { method: string; url: string }[] = []

  constructor(seed: SeedSpec = {}) {
    this.state = createRbacState(seed)
  }

  getPermission(id: string) {
    return this.state.permissions.get(id)
  }
  getRole(id: string) {
    return this.state.roles.get(id)
  }
  getUser(id: string) {
    return this.state.users.get(id)
  }
  listPermissions() {
    return [...this.state.permissions.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  listRoles() {
    return [...this.state.roles.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  listUsers() {
    return [...this.state.users.values()].sort((a, b) => a.username.localeCompare(b.username))
  }

  fail(spec: FailureSpec) {
    this.failures.push({ ...spec })
  }

  private matchFailure(method: string, url: string): FailureSpec | null {
    const idx = this.failures.findIndex((f) => {
      const target = `${method} ${url}`
      return typeof f.pattern === 'string' ? target.includes(f.pattern) : f.pattern.test(target)
    })
    if (idx === -1) return null
    const spec = this.failures[idx]
    if (spec.times !== undefined) {
      spec.times -= 1
      if (spec.times <= 0) this.failures.splice(idx, 1)
    }
    return spec
  }

  async install(page: Page) {
    await page.route('**/v1/session', async (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SESSION),
      }),
    )
    await page.route('**/api/v1/**', async (route) => this.handle(route))
  }

  private async handle(route: Route) {
    const request = route.request()
    const method = request.method()
    const url = request.url()
    this.requests.push({ method, url })

    const failure = this.matchFailure(method, url)
    if (failure) {
      if (failure.delayMs) await wait(failure.delayMs)
      await route.fulfill({
        status: failure.status,
        contentType: 'application/json',
        body: JSON.stringify(failure.body ?? { detail: `mock ${failure.status}` }),
      })
      return
    }

    const path = new URL(url).pathname.replace(/^\/api/, '')

    // The session endpoint shares the `/api/v1/**` prefix, so it lands here
    // rather than on the dedicated `**/v1/session` route. Serve it directly
    // so `useSession()` consumers (user menu, self-removal guard) get a user.
    if (path === '/v1/session') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SESSION),
      })
      return
    }

    const body = readJson(request)
    const result = dispatchRbac(this.state, method, path, body)
    if (!result) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: `unmocked ${method} ${path}` }),
      })
      return
    }
    await route.fulfill({
      status: result.status,
      contentType: 'application/json',
      body: result.body === null ? '' : JSON.stringify(result.body),
    })
  }
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function readJson(request: PWRequest): unknown {
  try {
    const text = request.postData()
    if (!text) return undefined
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function toast(page: Page): Locator {
  return page.locator('[data-sonner-toast]')
}
