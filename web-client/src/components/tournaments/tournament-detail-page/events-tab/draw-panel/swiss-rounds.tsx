import type {
  DrawRound,
  FixtureLine as FixtureLineView,
  SwissByes,
} from '../../../data/draw'
import type { Entrant } from '../../../data/types'
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
  /** Who sits each round out, by round number — derived by `drawState` from the entry ids
   * (`SwissByes`, `../../../data/draw`), because a `FixtureLine` carries usernames and no
   * ids at all. A round with no entry here byes nobody, and that is the ONE place the
   * question is decided: this component renders whatever the map says, for whatever round
   * it says it about. */
  byes: SwissByes
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
 * The entrant an odd field leaves out of a round — **named**, as part of the round.
 *
 * A bye is the absence of a fixture, so before this line the seventh entrant of a
 * seven-player event appeared nowhere in the draw: they were in Standings and in no
 * pairing, and a director could only work out who was sitting out by diffing the two by
 * hand. It reads as a fact about the round, not as a warning, and it credits nothing —
 * a bye scores no win here, and the standings are where a record belongs.
 *
 * Plural because a **stale** draw leaves more than one entrant unseated (entries taken
 * since the cut). "Byes: a, b" is then the honest reading of the same subtraction, and
 * saying it is how the staleness shows.
 */
const ByeLine = ({ round, sittingOut }: { round: number; sittingOut: Entrant[] }) => (
  <p
    data-testid={`swiss-round-bye-${round}`}
    className="mt-0.5 text-[13px] text-[color:var(--fg-3)]"
  >
    {sittingOut.length === 1 ? 'Bye' : 'Byes'}:{' '}
    {sittingOut.map((entrant) => entrant.username).join(', ')}
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
 *
 * ## The bye is a line of the round, beside the pairings
 *
 * An odd field byes one entrant a round, and a bye is the *absence* of a fixture — so it
 * cannot be an `<li>` of the list above without inventing the row the format does not
 * have. It is a line of its own under the round (`ByeLine`), fed by `byes`.
 *
 * **It is deliberately not nested inside the paired branch.** Whether a round byes anybody
 * is decided once, in `drawState` (`SwissByes` — swiss only, odd field only, paired rounds
 * only), and this component renders that answer wherever it lands. A second gate here
 * would look safer while making the first one untestable: break the derivation and the
 * nesting would hide it, so nothing would ever go red for the whole field being listed
 * under a round that has not been paired.
 */
export const SwissRounds = ({ rounds, byes }: SwissRoundsProps) => (
  <div className="mt-2 flex flex-col gap-2">
    {rounds.map((round) => {
      const sittingOut = byes.get(round.round) ?? []
      return (
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
          {sittingOut.length > 0 && (
            <ByeLine round={round.round} sittingOut={sittingOut} />
          )}
        </div>
      )
    })}
  </div>
)
