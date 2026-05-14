import { faker } from '@faker-js/faker'
import type { components } from '@/api/schema'

type ComponentHealth = components['schemas']['ComponentHealth']
type HealthResponse = components['schemas']['HealthResponse']
type SessionUser = components['schemas']['SessionUser']
type SessionResponse = components['schemas']['SessionResponse']
type Permission = components['schemas']['PermissionRead']
type Role = components['schemas']['RoleRead']
type RbacUser = components['schemas']['RbacUserRead']
type Player = components['schemas']['PlayerRead']
type MatchRead = components['schemas']['MatchRead']

function fastCheck(overrides: Partial<ComponentHealth> = {}): ComponentHealth {
  return {
    healthy: true,
    latency_ms: faker.number.float({ min: 1, max: 80, fractionDigits: 1 }),
    error: null,
    ...overrides,
  }
}

export function redisCheck(
  overrides: Partial<ComponentHealth> = {},
): ComponentHealth {
  return fastCheck(overrides)
}

export function databaseCheck(
  overrides: Partial<ComponentHealth> = {},
): ComponentHealth {
  return fastCheck(overrides)
}

export function solverCheck(
  overrides: Partial<ComponentHealth> = {},
): ComponentHealth {
  return fastCheck({
    latency_ms: faker.number.float({ min: 30, max: 250, fractionDigits: 1 }),
    ...overrides,
  })
}

export function healthCheck(
  overrides: Partial<HealthResponse> = {},
): HealthResponse {
  return {
    redis: redisCheck(),
    database: databaseCheck(),
    solver: solverCheck(),
    ...overrides,
  }
}

export function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    username: faker.internet.username().toLowerCase(),
    permissions: [],
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

const ISO = '2026-05-12T09:00:00Z'

let counter = 0
function nextId(prefix: string) {
  counter += 1
  return `${prefix}_${faker.string.alphanumeric(6)}_${counter}`
}

export function permission(overrides: Partial<Permission> = {}): Permission {
  const name = overrides.name ?? `${faker.word.noun().toLowerCase()}.${faker.word.verb().toLowerCase()}`
  return {
    id: nextId('p'),
    name,
    description: `Mock permission ${name}`,
    created_at: ISO,
    updated_at: ISO,
    ...overrides,
  }
}

export function role(overrides: Partial<Role> = {}): Role {
  return {
    id: nextId('r'),
    name: `Role ${faker.word.adjective()}`,
    description: 'Mock role',
    permission_ids: [],
    created_at: ISO,
    updated_at: ISO,
    ...overrides,
  }
}

export function rbacUser(overrides: Partial<RbacUser> = {}): RbacUser {
  return {
    id: nextId('u'),
    username: faker.internet.username().toLowerCase(),
    role_ids: [],
    created_at: ISO,
    ...overrides,
  }
}

export function player(overrides: Partial<Player> = {}): Player {
  return {
    id: nextId('pl'),
    username: faker.internet.username().toLowerCase(),
    ...overrides,
  }
}

/**
 * Builds a `MatchRead` the way the API would for a `POST /v1/matches` body:
 * the creator always gets side 1, a registered opponent gets side 2, and
 * guest / no-opponent matches stay single-sided and unrated.
 */
export function matchResponse(input: {
  creatorUsername: string
  opponent: Player | null
  bestOf: number
  rated: boolean
}): MatchRead {
  const creatorId = nextId('u')
  const affectsRating = input.rated && input.opponent !== null
  const sides: MatchRead['sides'] = [
    {
      side_number: 1,
      score: 0,
      won: null,
      players: [{ user_id: creatorId, username: input.creatorUsername }],
    },
  ]
  if (input.opponent) {
    sides.push({
      side_number: 2,
      score: 0,
      won: null,
      players: [
        { user_id: input.opponent.id, username: input.opponent.username },
      ],
    })
  }
  return {
    id: nextId('m'),
    status: 'pending',
    created_by_user_id: creatorId,
    created_at: ISO,
    settings: {
      team_size: 1,
      best_of: input.bestOf,
      affects_rating: affectsRating,
      verification_policy: 'none',
    },
    sides,
  }
}
