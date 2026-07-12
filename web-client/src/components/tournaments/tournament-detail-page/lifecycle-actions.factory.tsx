import { buildTournament } from '../data/seed.factory'
import type { LifecycleActionsProps } from './lifecycle-actions'

/** Props for `LifecycleActions` — the seeded (published, owned) Bay Area Open.
 * Override `tournament` with another `status` / `canEdit: false` to reach the
 * other branches. */
export function buildLifecycleActionsProps(
  overrides: Partial<LifecycleActionsProps> = {},
): LifecycleActionsProps {
  return {
    tournament: buildTournament(),
    ...overrides,
  }
}
