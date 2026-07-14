import type {
  FixtureLine,
  FixtureMatch,
  FixtureSide,
} from '../../../../data/draw'
import type { FixtureLineProps } from './fixture-line'

/** A fixture line between two named entrants — the ordinary case, and the only one a
 * round-robin draw produces. `match: null` is the default because a *planned* pairing is
 * the state a director sees the morning of; pass `a`/`b` for the TBD and withdrawn sides,
 * and `buildFixtureMatch()` (or `match`) for a materialized slot. */
export function buildFixtureLineView(
  overrides: Partial<FixtureLine> = {},
): FixtureLine {
  return {
    id: 'fx-a-1',
    position: 1,
    a: { kind: 'entrant', name: 'player.1' },
    b: { kind: 'entrant', name: 'player.4' },
    match: null,
    ...overrides,
  }
}

/** The materialized match behind a fixture — an `in_progress` match, the state every slot
 * is in the moment its draw goes live (#788). Pass `status` for a played-out slot. */
export function buildFixtureMatch(
  overrides: Partial<FixtureMatch> = {},
): FixtureMatch {
  return { id: 'm-fx-a-1', status: 'in_progress', ...overrides }
}

/** A side that is **not decided yet** — never a bye (ADR-0786). */
export function buildTbdSide(): FixtureSide {
  return { kind: 'tbd' }
}

/** A side naming an entry the event no longer lists: they withdrew, and the draw is
 * stale. */
export function buildWithdrawnSide(): FixtureSide {
  return { kind: 'withdrawn' }
}

/** Props for `FixtureLine`. */
export function buildFixtureLineProps(
  overrides: Partial<FixtureLineProps> = {},
): FixtureLineProps {
  return { fixture: buildFixtureLineView(), ...overrides }
}
