import type { DrawRound } from '../../../data/draw'
import { FixtureLine } from './round-list/fixture-line'

export interface RoundListProps {
  rounds: DrawRound[]
  /** What these rounds belong to — a pool's name ("Pool A"), or the un-pooled group's
   * heading. It is not rendered: it *names* each round's list for a screen reader
   * ("Round 1 fixtures in Pool A"), which is the only thing that tells one pool's round
   * 1 from the next pool's when a rotor lists them side by side. */
  groupName: string
}

/**
 * A draw's fixtures, **grouped by round** — the shape a director reads a draw in.
 *
 * Every round is a labelled list of its own fixtures, in position order. An odd
 * round-robin pool has rounds holding **fewer fixtures** than the others, because the
 * player drawn against the phantom seat sits that round out — and that is the entire
 * representation of a bye (ADR-0786: "a bye is modeled as absence"). Nothing here emits
 * a "bye" row: the wire never says one is missing, and a derived one would be a second
 * copy of the planner's rotation, free to disagree with it.
 *
 * Shared by `PoolDraw` (a pool's rounds) and `DrawPanel` (the un-pooled fixtures of a
 * knockout stage, which no draw type can cut yet — but which must not be dropped when
 * one can, #785).
 */
export const RoundList = ({ rounds, groupName }: RoundListProps) => (
  <div className="mt-2 flex flex-col gap-2">
    {rounds.map((round) => (
      <div key={round.round}>
        <div className="text-[11px] font-semibold tracking-[0.08em] text-[color:var(--fg-3)] uppercase">
          Round {round.round}
        </div>
        <ul
          data-testid={`draw-round-${round.round}`}
          aria-label={`Round ${round.round} fixtures in ${groupName}`}
          className="mt-0.5"
        >
          {round.fixtures.map((fixture) => (
            <FixtureLine key={fixture.id} fixture={fixture} />
          ))}
        </ul>
      </div>
    ))}
  </div>
)
