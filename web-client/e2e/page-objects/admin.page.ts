import type { Locator, Page, Route } from '@playwright/test'
import type { components } from '../../src/api/schema'
import { PERM } from '../../src/lib/permissions'
import {
  databaseCheck,
  healthCheck,
  sessionResponse,
  solverCheck,
} from '../../src/test/factories'
import { stubRealtimeStream } from '../support/realtime'

type HealthResponse = components['schemas']['HealthResponse']

export const HEALTH_SCENARIOS: Record<
  'healthy' | 'degraded' | 'failing' | 'serverError',
  (() => HealthResponse) | null
> = {
  healthy: () => healthCheck(),
  degraded: () =>
    healthCheck({
      database: databaseCheck({ latency_ms: 1840 }),
    }),
  failing: () =>
    healthCheck({
      database: databaseCheck({
        healthy: false,
        latency_ms: null,
        error: 'connection refused (ECONNREFUSED)',
      }),
      solver: solverCheck({
        healthy: false,
        latency_ms: null,
        error: 'timeout after 5000ms · OOMKilled',
      }),
    }),
  serverError: null,
}

export type ScenarioName = keyof typeof HEALTH_SCENARIOS

// The Overview page is gated on `administration.view`; grant it by default so
// the system-health scenarios render. Tests that exercise the gate itself pass
// `permissions: []` to mock an unauthorized visitor.
function buildSession(permissions: string[]) {
  return sessionResponse({ user: { username: 'rita.kovac', permissions } })
}

export class AdminPage {
  static async navigateTo(
    page: Page,
    options: {
      scenario?: ScenarioName
      healthDelayMs?: number
      onHealthRequest?: () => void
      permissions?: string[]
    } = {},
  ): Promise<AdminPage> {
    const admin = new AdminPage(page)
    await admin.mockSession(options.permissions ?? [PERM.ADMIN_VIEW])
    await admin.mockHealth(
      options.scenario ?? 'healthy',
      options.healthDelayMs ?? 0,
      options.onHealthRequest,
    )
    await page.goto('/admin')
    return admin
  }

  constructor(public readonly page: Page) {}

  async mockSession(permissions: string[] = [PERM.ADMIN_VIEW]) {
    // `_app` opens a realtime stream alongside the session bootstrap; this
    // suite has no catch-all, so it needs its own stub (`../support/realtime`).
    await stubRealtimeStream(this.page)
    await this.page.route('**/v1/session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildSession(permissions)),
      })
    })
  }

  async mockHealth(
    scenario: ScenarioName,
    delayMs = 0,
    onRequest?: () => void,
  ) {
    await this.page.unroute('**/v1/health').catch(() => undefined)
    await this.page.route('**/v1/health', async (route: Route) => {
      onRequest?.()
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      const build = HEALTH_SCENARIOS[scenario]
      if (build === null) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'service unavailable' }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(build()),
      })
    })
  }

  get widget(): Locator {
    return this.page.getByTestId('system-health')
  }

  row(service: 'redis' | 'database' | 'solver'): Locator {
    return this.page.getByTestId(`system-health-row-${service}`)
  }

  pill(service: 'redis' | 'database' | 'solver'): Locator {
    return this.page.getByTestId(`system-health-pill-${service}`)
  }

  errorChip(service: 'redis' | 'database' | 'solver'): Locator {
    return this.page.getByTestId(`system-health-error-${service}`)
  }

  get eyebrow(): Locator {
    return this.page.getByTestId('system-health-eyebrow')
  }

  get recheckButton(): Locator {
    return this.page.getByTestId('system-health-recheck')
  }

  get heading(): Locator {
    return this.page.getByRole('heading', { level: 1, name: 'Administration' })
  }

  get accessDenied(): Locator {
    return this.page.getByText("You don't have access to this page")
  }
}
