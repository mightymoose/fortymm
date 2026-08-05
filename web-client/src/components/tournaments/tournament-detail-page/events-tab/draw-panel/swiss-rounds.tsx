import type { DrawRound, FixtureLine as FixtureLineView } from '../../../data/draw'
// `FixtureLine` is shared with `RoundList` (the pooled renderer) and `Bracket`; its owner
// is the `round-list/` subtree today. Reached across rather than duplicating the three-way
// `FixtureSide` switch — the same call `Bracket` makes, and for the same reason. It is now
// the third importer, so per the supremum rule it wants floating up to `draw-panel/`; left
// in place to keep this change to the routing it is about.
import { FixtureLine } from './round-list/fixture-line'

export interface SwissRoundsProps {
  /** The event's un-pooled fixtures, already grouped and ordered into rounds by
   * `drawState` (`../../../data/draw`) — round 1 first. A swiss draw's rounds are **all**
   * of them: the cut writes `R × ⌊n/2⌋` fixtures up front. */
  rounds: DrawRound[]
}

/**
 * Whether a round has been **paired** — anybody at all is seated in it.
 *
 * Asked of the SIDES, never of the round number. `round > 1` gives the same answer on a
 * freshly-cut draw and a different one the moment `advance()` pairs round 2, which is the
 * ordinary state of a running event — so a renderer keyed off the number would show a live,
 * paired round 2 as "not paired yet" for the rest of the tournament.
 *
 * A withdrawn side counts as paired: the entry was seated, and the round is a real pairing
 * whose draw has gone stale — which is a thing to show, not to hide behind "forthcoming".
 */
const isPaired = (fixtures: FixtureLineView[]): boolean =>
  fixtures.some((f) => f.a.kind !== 'tbd' || f.b.kind !== 'tbd')

/** A round nobody is seated in yet, announced as **forthcoming** rather than drawn as a
 * column of "TBD vs TBD" lines.
 *
 * Those lines would be honest and unreadable: `⌊n/2⌋` identical rows saying nothing, which
 * a director reads as a bug rather than as a format. Hiding the round would be worse — it
 * exists, it is already cut, and how many rounds the event plays is the setting the
 * director chose. So the round keeps its heading and says the two facts it has: how many
 * matches it holds, and what has to happen before it has players in it. */
const ForthcomingRound = ({ round }: { round: DrawRound }) => (
  <p
    data-testid={`swiss-round-forthcoming-${round.round}`}
    className="mt-0.5 text-[13px] text-[color:var(--fg-3)] italic"
  >
    {round.fixtures.length} {round.fixtures.length === 1 ? 'match' : 'matches'},
    paired once round {round.round - 1} is decided.
  </p>
)

/**
 * A **swiss** draw's fixtures, round by round (ADR "swiss pre-cuts every round and pairs
 * each one on advance").
 *
 * ## Why not the bracket
 *
 * A swiss draw is un-pooled, exactly as a single-elimination bracket is, and until this
 * component existed it was routed to `Bracket` on that resemblance alone. It is the wrong
 * view, not merely a plain one: a bracket's columns are named back from the **Final**
 * ("Semifinals", "Quarterfinals") and its whole read is that a winner reappears one column
 * along. Swiss eliminates nobody, has no final, and pairs each round from the standings —
 * "no successor arithmetic", as the ADR puts it. A flat, numbered list of rounds is what
 * the format actually is.
 *
 * ## Every round is here from the cut
 *
 * The cut writes all `R` rounds at once, so rounds 2…R exist as fixtures with **both sides
 * null** from the moment the draw is dealt. They are shown as *forthcoming* — the round,
 * its match count, and what has to finish first — rather than as rows of `TBD vs TBD`
 * (which reads as a bug) or hidden (which loses the length of the day the director booked).
 *
 * The distinction is drawn from the **sides**, not the round number (`isPaired`), so a
 * round that `advance()` has paired renders its real fixtures whatever its number is.
 *
 * Each paired round is its own `<ul>` so a fixture stays an `<li>` a screen reader can
 * count, named by its round so the rotor tells one from the next — the same shape
 * `RoundList` and `Bracket` use.
 */
export const SwissRounds = ({ rounds }: SwissRoundsProps) => (
  <div className="mt-2 flex flex-col gap-2">
    {rounds.map((round) => (
      <div key={round.round}>
        <div className="text-[11px] font-semibold tracking-[0.08em] text-[color:var(--fg-3)] uppercase">
          Round {round.round}
        </div>
        {isPaired(round.fixtures) ? (
          <ul
            data-testid={`swiss-round-${round.round}`}
            aria-label={`Round ${round.round} fixtures`}
            className="mt-0.5"
          >
            {round.fixtures.map((fixture) => (
              <FixtureLine key={fixture.id} fixture={fixture} />
            ))}
          </ul>
        ) : (
          <ForthcomingRound round={round} />
        )}
      </div>
    ))}
  </div>
)
