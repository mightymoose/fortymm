import { ApiError } from '@/api/client'

import type { MatchDetailsErrorProps } from './match-details-error'

/** An `ApiError` carrying `status` — the field `MatchDetailsError` branches on.
 * `detail` defaults to null; pass a raw API string to exercise the no-leak
 * path (#152). */
export function buildApiError(
  status: number,
  detail: string | null = null,
): ApiError {
  return new ApiError(status, detail, 'load match')
}

/** Props for `MatchDetailsError`. Default scenario: a 404 no-such-match — the
 * friendly not-found dead end with a "Back to matches" link and AppShell
 * chrome. */
export function buildMatchDetailsErrorProps(
  overrides: Partial<MatchDetailsErrorProps> = {},
): MatchDetailsErrorProps {
  return {
    error: buildApiError(404, 'Match not found.'),
    reset: () => {},
    ...overrides,
  }
}
