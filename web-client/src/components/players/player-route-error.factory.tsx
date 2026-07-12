import { ApiError } from '@/api/client'

import type { PlayerRouteErrorProps } from './player-route-error'

/** An `ApiError` carrying `status` — the shape a failed `GET /v1/players/{id}`
 * throws. `PlayerRouteError` deliberately does **not** branch on it (ADR-1001
 * left it one always-retryable branch), which is exactly why the tests build
 * one per status: the copy and the action must come out the same for a 500, a
 * 401 and a 403. */
export function buildPlayerApiError(
  status: number,
  detail: string | null = null,
): ApiError {
  return new ApiError(status, detail, 'load player')
}

/**
 * Props for `PlayerRouteError`. Default scenario: the server broke (500) — the
 * retryable state this boundary exists for.
 *
 * `reset` defaults to a no-op; a test that asserts the retry fires passes a
 * `vi.fn()`.
 */
export function buildPlayerRouteErrorProps(
  overrides: Partial<PlayerRouteErrorProps> = {},
): PlayerRouteErrorProps {
  return {
    error: buildPlayerApiError(500),
    reset: () => {},
    ...overrides,
  }
}
