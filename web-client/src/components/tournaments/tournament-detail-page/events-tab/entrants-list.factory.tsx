import { buildEvent } from '../../data/seed.factory'
import type { EntrantsListProps } from './entrants-list'

/** Props for `EntrantsList` — the seeded Open Singles event and its 52 entrants,
 * seen by a signed-out viewer (no `username`, so no chip is anyone's own).
 * Override `event` with `buildEvent({ entrants: [...] })` for the empty and
 * short-roster cases (`entered` is derived from `entrants`, so a fixture cannot
 * disagree with itself), and pass `username` to view the roster AS one of them. */
export function buildEntrantsListProps(
  overrides: Partial<EntrantsListProps> = {},
): EntrantsListProps {
  return { event: buildEvent(), username: null, ...overrides }
}
