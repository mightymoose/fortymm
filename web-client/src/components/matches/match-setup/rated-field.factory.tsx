import { vi } from 'vitest'

import type { RatedFieldProps } from './rated-field'
import { buildOpponent } from './selected-opponent.factory'

/** Props for `RatedField` — a rated match against a picked opponent. */
export function buildRatedFieldProps(
  overrides: Partial<RatedFieldProps> = {},
): RatedFieldProps {
  return {
    rated: true,
    setRated: vi.fn(),
    opponent: buildOpponent(),
    isGuest: false,
    ...overrides,
  }
}
