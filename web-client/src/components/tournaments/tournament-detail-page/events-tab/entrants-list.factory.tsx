import { buildEvent } from '../../data/seed.factory'
import type { EntrantsListProps } from './entrants-list'

/** Props for `EntrantsList` — the seeded Open Singles event and its 52 entrants.
 * Override `event` with `buildEvent({ entrants: [...] })` for the empty and
 * short-roster cases (`entered` is derived from `entrants`, so a fixture cannot
 * disagree with itself). */
export function buildEntrantsListProps(
  overrides: Partial<EntrantsListProps> = {},
): EntrantsListProps {
  return { event: buildEvent(), ...overrides }
}
