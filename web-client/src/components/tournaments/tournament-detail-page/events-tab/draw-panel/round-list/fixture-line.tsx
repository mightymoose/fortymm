import {
  TBD_LABEL,
  WITHDRAWN_LABEL,
  type FixtureLine as FixtureLineView,
  type FixtureSide,
} from '../../../../data/draw'

export interface FixtureLineProps {
  fixture: FixtureLineView
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

/**
 * One **fixture** of a cut draw, as a named line: `player.1 vs player.4`.
 *
 * A fixture is not a match (CONTEXT.md) — it is the *planned* pairing, and it may not
 * even have both its sides yet — so the line is deliberately inert: no score, no link,
 * no control. Materializing it into a real match is #788.
 *
 * Rendered as the `<li>` of the round's list, so a round stays a list of its fixtures
 * and a screen reader can count them. The "vs" is a real word in the DOM, not a
 * separator glyph: it is what makes the line read as a pairing to someone who is hearing
 * it rather than seeing it.
 */
export const FixtureLine = ({ fixture }: FixtureLineProps) => (
  <li
    data-testid={`fixture-line-${fixture.id}`}
    className="flex items-baseline gap-1.5 py-0.5 text-[13px] leading-snug"
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
  </li>
)
