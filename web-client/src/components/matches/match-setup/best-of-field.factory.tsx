import { vi } from 'vitest'

import type { BestOfFieldProps } from './best-of-field'

/** Props for `BestOfField` — best-of-5 selected, the form's default. */
export function buildBestOfFieldProps(
  overrides: Partial<BestOfFieldProps> = {},
): BestOfFieldProps {
  return { bestOf: 5, setBestOf: vi.fn(), ...overrides }
}
