import type { DrawRound } from '../../../data/draw'
// FixtureLine is shared with RoundList (the pooled renderer); its owner is the
// `round-list/` subtree today. Reached across for the sides + match-link rendering rather
// than duplicating the three-way `FixtureSide` switch. If a third importer appears it
// should float up to `draw-panel/` per the supremum rule — left in place here to keep this
// change scoped to the bracket.
import { FixtureLine } from './round-list/fixture-line'

export interface BracketProps {
  /** The event's un-pooled fixtures, already grouped and ordered into rounds by
   * `drawState` (`../../../data/draw`) — round 1 first, the final last. A single-elim
   * draw's whole bracket; the round-robin path never reaches here (it renders pools). */
  rounds: DrawRound[]
}

/**
 * The name a single-elimination round goes by, read back from the **final**. The last
 * column is the *Final*, the one before it the *Semifinals*, the one before that the
 * *Quarterfinals*; anything earlier is just its number.
 *
 * Named off the last round *present* rather than a fixed table keyed on `round`, so a
 * two-entrant bracket — a single round — is correctly a lone "Final", not "Round 1", and
 * an eight-entrant bracket's round 1 reads as "Quarterfinals".
 */
function roundLabel(round: number, finalRound: number): string {
  switch (finalRound - round) {
    case 0:
      return 'Final'
    case 1:
      return 'Semifinals'
    case 2:
      return 'Quarterfinals'
    default:
      return `Round ${round}`
  }
}

/**
 * A single-elimination draw's un-pooled fixtures, as a **columnar bracket** (ADR-0785):
 * one column per round laid out left-to-right (Round 1 … Final), each fixture a card
 * naming both sides.
 *
 * This replaces the flat `RoundList` placeholder for `state.unpooled` — pools still render
 * through `RoundList`, a bracket does not. What it renders is entirely `drawState`'s read
 * model; it derives nothing of its own:
 *
 * - **Byes are implied, never drawn.** A byed seed has no round-1 fixture (a bye is the
 *   absence of one, ADR-0786) and is already seated onto a later column's card by the read
 *   model. So a bye-heavy round 1 simply holds fewer cards, and the byed seed appears, by
 *   name, one column along — there is no "bye" row to invent.
 * - **Progression is legible without connectors.** A decided fixture seats its winner onto
 *   the next round's card *upstream*, in the read model; this component just renders what
 *   it is handed, so the winner appears by name in the next column. **Elbow/SVG connectors
 *   are deferred** (ADR-0785): the round headers and repeated names carry the bracket
 *   unambiguously, and the columns stay mobile-friendly by scrolling horizontally instead
 *   of fighting a fixed connector geometry.
 * - **It renders pre-live too.** A cut-but-not-yet-live draw shows the seeded round-1
 *   pairings and its downstream `TBD` cards for the director to review before go-live;
 *   once live, each card that has materialized links to its match and shows its status
 *   (all of that is `FixtureLine`, reused unchanged from the pooled renderer).
 *
 * Each round is its own `<ul>` so a fixture stays an `<li>` a screen reader can count, and
 * each list is named by its round (`"Semifinals fixtures in the bracket"`) so the rotor
 * tells one column from the next.
 */
export const Bracket = ({ rounds }: BracketProps) => {
  const finalRound = rounds.reduce((max, r) => Math.max(max, r.round), 0)

  return (
    <div className="mt-2 flex gap-3 overflow-x-auto pb-1">
      {rounds.map((round) => {
        const label = roundLabel(round.round, finalRound)
        return (
          <div
            key={round.round}
            className="flex min-w-[190px] shrink-0 flex-col"
          >
            <div className="text-[11px] font-semibold tracking-[0.08em] text-[color:var(--fg-3)] uppercase">
              {label}
            </div>
            {/* Named per round so two columns' cards are told apart by the rotor, mirroring
                RoundList's per-group naming. Centred vertically so a later, shorter column
                sits opposite the middle of the taller one it feeds from — the bracket read
                the columns give without any connector geometry. */}
            <ul
              data-testid={`bracket-round-${round.round}`}
              aria-label={`${label} fixtures in the bracket`}
              className="mt-1 flex flex-1 flex-col justify-center gap-2 [&>li]:rounded-[8px] [&>li]:border [&>li]:border-[color:var(--border-subtle)] [&>li]:px-2.5 [&>li]:py-1.5"
            >
              {round.fixtures.map((fixture) => (
                <FixtureLine key={fixture.id} fixture={fixture} />
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
