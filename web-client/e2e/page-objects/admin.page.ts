import type { Locator, Page, Route } from '@playwright/test'

export type HealthScenario = {
  redis: { healthy: boolean; latency_ms?: number | null; error?: string | null }
  database: { healthy: boolean; latency_ms?: number | null; error?: string | null }
  solver: { healthy: boolean; latency_ms?: number | null; error?: string | null }
}

export const HEALTH_SCENARIOS = {
  healthy: {
    redis: { healthy: true, latency_ms: 4 },
    database: { healthy: true, latency_ms: 12 },
    solver: { healthy: true, latency_ms: 38 },
  },
  degraded: {
    redis: { healthy: true, latency_ms: 6 },
    database: {
      healthy: true,
      latency_ms: 1840,
      error: null,
    },
    solver: { healthy: true, latency_ms: 42 },
  },
  failing: {
    redis: { healthy: true, latency_ms: 5 },
    database: {
      healthy: false,
      latency_ms: null,
      error: 'connection refused (ECONNREFUSED)',
    },
    solver: {
      healthy: false,
      latency_ms: null,
      error: 'timeout after 5000ms · OOMKilled',
    },
  },
  serverError: null,
} as const satisfies Record<string, HealthScenario | null>

export type ScenarioName = keyof typeof HEALTH_SCENARIOS

type SessionResponse = {
  data: { user: { username: string } }
}

const SESSION_RESPONSE: SessionResponse = {
  data: { user: { username: 'rita.kovac' } },
}

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
      if (scenario === 'serverError') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'service unavailable' }),
        })
        return
      }
      const payload = HEALTH_SCENARIOS[scenario]
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
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
