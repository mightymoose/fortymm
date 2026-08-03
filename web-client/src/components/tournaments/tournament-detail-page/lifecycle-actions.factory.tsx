import {
  buildEntrant,
  buildEvent,
  buildFixture,
  buildTournament,
} from '../data/seed.factory'
import type { Tournament } from '../data/types'
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

/** A published, owned tournament with **no events at all** — the state the "nothing to
 * start" refusal is produced about (ADR-0786), and the one the director leaves by adding
 * an event (#1216). */
export function buildEmptyTournament(): Tournament {
  return buildTournament({ id: 't-1', status: 'published', events: [] })
}

/** A published, owned tournament whose one event's draw seats `seated` while its entrants
 * are `entry-1`, `entry-2`, `entry-3` and `entry-6`.
 *
 * The two builders below are the **before and after of the fix the refusal asks for**, and
 * they differ in nothing but *who* is seated: same event, same entrants, same number of
 * fixtures. Any expiry rule built on counts reads them as the same state. */
function tournamentSeating(seated: [string, string][]): Tournament {
  return buildTournament({
    id: 't-1',
    status: 'published',
    events: [
      buildEvent({
        id: 'ev-u1200',
        name: 'Under 1200',
        entrants: ['entry-1', 'entry-2', 'entry-3', 'entry-6'].map((id, i) =>
          buildEntrant({ id, userId: `u-${i + 1}`, username: `player.${i + 1}` }),
        ),
        fixtures: seated.map(([entryAId, entryBId], i) =>
          buildFixture({
            id: `fx-${i + 1}`,
            round: 1,
            position: i + 1,
            entryAId,
            entryBId,
          }),
        ),
      }),
    ],
  })
}

/** The event's draw is **stale**: `entry-4` withdrew and `entry-6` entered since it was
 * cut, so the fixtures still seat a player who has left while the one who replaced them is
 * seated nowhere — the second shape of the go-live refusal (ADR-0786). */
export function buildStaleDrawTournament(): Tournament {
  return tournamentSeating([
    ['entry-1', 'entry-2'],
    ['entry-3', 'entry-4'],
  ])
}

/** The same tournament after the director **re-cut the draw** over the field as it now
 * stands — `entry-6` is seated, `entry-4` is not. The refusal that named this event has
 * stopped being true. */
export function buildRecutDrawTournament(): Tournament {
  return tournamentSeating([
    ['entry-1', 'entry-2'],
    ['entry-3', 'entry-6'],
  ])
}
