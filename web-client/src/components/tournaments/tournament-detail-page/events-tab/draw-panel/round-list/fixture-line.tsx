import { Link } from '@tanstack/react-router'

import { matchDetailRoute, type MatchStatus } from '@/api/matches'

import {
  TBD_LABEL,
  WITHDRAWN_LABEL,
  type FixtureLine as FixtureLineView,
  type FixtureMatch,
  type FixtureSide,
} from '../../../../data/draw'

export interface FixtureLineProps {
  fixture: FixtureLineView
}

/** A materialized fixture's status, in words a director reads rather than the wire's
 * enum key. `in_progress` is the state every slot is in at go-live, so it leads; a slot
 * never *starts* as `pending`, but a match can be reset to it, so it is covered too. */
const MATCH_STATUS_LABEL: Record<MatchStatus, string> = {
  pending: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
  voided: 'Voided',
}

/** One side of the "A vs B" line. The three kinds of side are three different facts
 * (`FixtureSide`, `data/draw.ts`), and each says its own word — a side is NEVER blank,
 * and never a raw entry id:
 *
 * - an **entrant**: their username, as the roster shows it (bare, no `@`);
 * - **TBD**: the feeding fixture is undecided. Not a bye — a bye is the absence of a
 *   fixture (ADR-0786) — so this is a real pairing whose other half is still being
 *   played for;
 * - **Withdrawn**: the entry this side names is no longer in the event, which means the
 *   draw is *stale* and wants re-cutting. Both are marked in words, not merely in a hue:
 *   a colour-only difference is no difference to a director who cannot see it. */
const Side = ({ side }: { side: FixtureSide }) => {
  switch (side.kind) {
    case 'entrant':
      return <span className="text-[color:var(--fg-1)]">{side.name}</span>
    case 'tbd':
      return (
        <span className="text-[color:var(--fg-3)] italic">{TBD_LABEL}</span>
      )
    case 'withdrawn':
      return (
        <span className="text-[color:var(--warn)]">{WITHDRAWN_LABEL}</span>
      )
    default: {
      // A fourth kind of side without copy is a TYPE error here, not a blank half-line
      // — the exact failure this sum type exists to prevent.
      const exhaustive: never = side
      return exhaustive
    }
  }
}

/** The materialized half of a fixture line: a **link to the live match** and its
 * **status**, shown only once the slot has become a real match at go-live (#788).
 *
 * The link is built with `matchDetailRoute` — the one typed builder every "open this
 * match" affordance in the app goes through (the matches list row, the profile's Recent
 * matches) — so a fixture slot deep-links a match exactly the way the rest of the app
 * does, and a route rename touches one place. Its accessible name carries the status, so
 * a screen reader hears "View match — In progress" rather than a bare "View match" it
 * cannot tell from the next slot's. */
const MatchLink = ({ match }: { match: FixtureMatch }) => {
  const label = MATCH_STATUS_LABEL[match.status]
  return (
    <>
      <span
        data-testid="fixture-match-status"
        className="text-[11px] font-medium text-[color:var(--fg-3)]"
      >
        {label}
      </span>{' '}
      <Link
        {...matchDetailRoute(match.id)}
        aria-label={`View match — ${label}`}
        className="text-[color:var(--ball-500)] hover:underline"
      >
        View match
      </Link>
    </>
  )
}

/**
 * One **fixture** of a cut draw, as a named line: `player.1 vs player.4`.
 *
 * A fixture is a *planned* pairing, not a match (CONTEXT.md) — so **until it materializes
 * the line is inert**: no score, no link, no control. At go-live it becomes a real match
 * (#788), and from then on the line links to that match (`MatchLink`) and shows the
 * match's live status. The `match` field is the whole switch: `null` is the planned
 * pairing, a `FixtureMatch` is the live one.
 *
 * Rendered as the `<li>` of the round's list, so a round stays a list of its fixtures
 * and a screen reader can count them. The "vs" is a real word in the DOM, not a
 * separator glyph: it is what makes the line read as a pairing to someone who is hearing
 * it rather than seeing it.
 */
export const FixtureLine = ({ fixture }: FixtureLineProps) => (
  <li
    data-testid={`fixture-line-${fixture.id}`}
    className="flex flex-wrap items-baseline gap-x-1.5 py-0.5 text-[13px] leading-snug"
  >
    {/* The `{' '}`s are LOAD-BEARING, and they are not the flex gap. The gap is
        *layout*: whitespace-only text between flex items is not rendered, so these cost
        nothing on screen — but without them the line's text content is
        `player.1vsplayer.4`, which is what a screen reader reads out and what the
        clipboard gets. Three separate spans and a visual gap look like a sentence; only
        the spaces make it one. */}
    <Side side={fixture.a} />{' '}
    <span className="text-[color:var(--fg-3)]">vs</span>{' '}
    <Side side={fixture.b} />
    {fixture.match && (
      <span className="ml-auto flex items-baseline gap-x-1.5">
        <MatchLink match={fixture.match} />
      </span>
    )}
  </li>
)
