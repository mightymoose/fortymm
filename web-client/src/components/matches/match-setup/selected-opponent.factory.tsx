import { vi } from 'vitest'

import type { Opponent } from './opponent'
import type { SelectedOpponentProps } from './selected-opponent'

/** A rated opponent — the common case once a player is picked. */
export function buildOpponent(overrides: Partial<Opponent> = {}): Opponent {
  return { id: 'p-1', name: 'nguyen.t', rating: 1540, ...overrides }
}

/** Props for `SelectedOpponent`. */
export function buildSelectedOpponentProps(
  overrides: Partial<SelectedOpponentProps> = {},
): SelectedOpponentProps {
  return { opponent: buildOpponent(), onChange: vi.fn(), ...overrides }
}
