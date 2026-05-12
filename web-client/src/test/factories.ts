import { faker } from '@faker-js/faker'
import type { components } from '@/api/schema'

type ComponentHealth = components['schemas']['ComponentHealth']
type HealthResponse = components['schemas']['HealthResponse']
type SessionUser = components['schemas']['SessionUser']
type SessionResponse = components['schemas']['SessionResponse']

export function healthyComponent(
  overrides: Partial<ComponentHealth> = {},
): ComponentHealth {
  return {
    healthy: true,
    latency_ms: faker.number.float({ min: 1, max: 80, fractionDigits: 1 }),
    error: null,
    ...overrides,
  }
}

export function degradedComponent(
  overrides: Partial<ComponentHealth> = {},
): ComponentHealth {
  return {
    healthy: true,
    latency_ms: faker.number.float({
      min: 1600,
      max: 3500,
      fractionDigits: 1,
    }),
    error: null,
    ...overrides,
  }
}

const DOWN_ERRORS = [
  'connection refused (ECONNREFUSED)',
  'timeout after 5000ms',
  'connection reset by peer',
  'host unreachable',
] as const

export function downComponent(
  overrides: Partial<ComponentHealth> = {},
): ComponentHealth {
  return {
    healthy: false,
    latency_ms: null,
    error: faker.helpers.arrayElement(DOWN_ERRORS),
    ...overrides,
  }
}

export function healthResponse(
  overrides: Partial<HealthResponse> = {},
): HealthResponse {
  return {
    redis: healthyComponent(),
    database: healthyComponent(),
    solver: healthyComponent(),
    ...overrides,
  }
}

export function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    username: faker.internet.username().toLowerCase(),
    ...overrides,
  }
}

export function sessionResponse(
  overrides: { user?: Partial<SessionUser> } = {},
): SessionResponse {
  return {
    data: { user: sessionUser(overrides.user) },
  }
}
