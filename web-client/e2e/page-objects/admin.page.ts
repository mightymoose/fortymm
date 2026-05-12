import type { Locator, Page, Route } from '@playwright/test'
import type { components } from '../../src/api/schema'
import {
  degradedComponent,
  downComponent,
  healthResponse,
  sessionResponse,
} from '../../src/test/factories'

type HealthResponse = components['schemas']['HealthResponse']

export const HEALTH_SCENARIOS: Record<
  'healthy' | 'degraded' | 'failing' | 'serverError',
  (() => HealthResponse) | null
> = {
  healthy: () => healthResponse(),
  degraded: () =>
    healthResponse({
      database: degradedComponent({ latency_ms: 1840 }),
    }),
  failing: () =>
    healthResponse({
      database: downComponent({ error: 'connection refused (ECONNREFUSED)' }),
      solver: downComponent({ error: 'timeout after 5000ms · OOMKilled' }),
    }),
  serverError: null,
}

export type ScenarioName = keyof typeof HEALTH_SCENARIOS

const SESSION_RESPONSE = sessionResponse({ user: { username: 'rita.kovac' } })

export class AdminPage {
  static async navigateTo(
    page: Page,
    options: {
      scenario?: ScenarioName
      healthDelayMs?: number
      onHealthRequest?: () => void
    } = {},
  ): Promise<AdminPage> {
    const admin = new AdminPage(page)
    await admin.mockSession()
    await admin.mockHealth(
      options.scenario ?? 'healthy',
      options.healthDelayMs ?? 0,
      options.onHealthRequest,
    )
    await page.goto('/admin')
    return admin
  }

  constructor(public readonly page: Page) {}

  async mockSession() {
    await this.page.route('**/v1/session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SESSION_RESPONSE),
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
}
