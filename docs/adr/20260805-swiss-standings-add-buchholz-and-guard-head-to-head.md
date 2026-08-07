# Swiss standings add Buchholz, and head-to-head is guarded on having met

Date: 2026-08-05

## Status

Accepted

## Context

`app/pool_finishing_order.py` holds the one definition of the tiebreak chain that
orders a round-robin pool. The draw layer and the results layer both import it, so
"the qualifiers" and "the top of the table" cannot disagree (ADR 20260727).

The chain is wins, then head-to-head when exactly two entries are tied, then game
difference, then games won, then the entry id.

Swiss orders its field with the same kind of table, but two steps in that chain
rest on a round-robin assumption that swiss breaks.

**Head-to-head, when the tied pair never met.** In a round-robin everyone
eventually plays everyone, so a completed two-way tie has a head-to-head result to
read. In swiss a pair tied on wins may never have been paired at all.

**Correction, 2026-08-05.** This section originally claimed the existing step had
no way to say "they did not meet", and that adding the guard was a correctness fix
swiss forced. **That was wrong.** `_head_to_head` already returned `None` for a
pair with no fixture between them, and `_break_tie` already fell through to the
scalar chain. The guard predates swiss, because a *part-played* round-robin pool
reaches the same state.

The claim was made during design and not checked against the code. Swiss needed
nothing here. What this ADR actually contributes on this point is a **test** for
the guard, which nothing had — confirmed by deliberately breaking it, which reds
both a swiss test and a pre-existing round-robin one.

**Strength of schedule is invisible.** A round-robin gives every entrant the same
opponents, so who you played carries no information and the chain rightly ignores
it. Swiss is the opposite. It deliberately pairs you against players on your own
score, so two entrants on the same number of wins may have faced completely
different halves of the field. Ordering them on game difference ranks them by
margin against unequal opposition.

## Decision

### Swiss gets its own ordering function, in the same shared module

A second function lands beside `finishing_order` in `app/pool_finishing_order.py`.
It does not go in a new module, and it does not go in either caller. The reason
the existing function lives there is that both `app.draws` and `app.results` must
read one definition, and that reason applies unchanged to swiss.

### The swiss chain

1. **wins** — most match wins first.
2. **head-to-head**, only when exactly two entries are tied **and they actually
   met**. When they did not meet, the step falls through.
3. **Buchholz** — the sum of the entrant's opponents' win counts, highest first.
4. **game difference** — games won minus games lost.
5. **games won**.
6. the **entry id**, a total deterministic fallback.

Buchholz sits above game difference because it measures who you had to beat, and
game difference measures margin. In a format that pairs by score, the first is the
stronger signal.

Buchholz needs no new input. `MatchOutcome` already records who was in each match,
so an entrant's opponents are derivable from data the function already receives.

### A bye contributes nothing to Buchholz

A bye is the absence of a fixture row, so a byed round produced no opponent and
adds no term to the sum. This falls out of the definition rather than needing a
special case.

### But a bye win *does* count toward the Buchholz of whoever played that entrant

Added 2026-08-05, after the bye's scoring landed and made the question real.

A bye scores as a win. Buchholz sums an entrant's opponents' win counts. So the
question is whether those counts are the wins the standings display, bye wins
included, or some adjusted number that strips them out.

**They are the wins the standings display.** Buchholz reads the same wins column
a director is looking at.

The case against is real: a bye win is not evidence of strength, so counting it
slightly inflates the Buchholz of whoever happened to play the byed entrant. The
case for wins anyway:

- Stripping bye wins would mean **two definitions of "wins"** in one module — the
  one the table shows and a private one Buchholz uses. Avoiding exactly that
  divergence is why this chain lives in a shared module at all (ADR 20260727).
- A director can verify Buchholz by adding up their opponents' win columns. Under
  an adjusted number that arithmetic silently fails to reconcile, and the figure
  reads as a bug.

The inflation is bounded at one win per opponent per event, and it lands on
whoever played the entrant the format handed a bye to, which is arbitrary rather
than systematic.

A bye still scores as a **win worth zero games** in step 1. The win is granted
because a player must not be punished for a scheduling artifact. The games are
zero so the bye stays neutral on steps 4 and 5, rather than awarding difference
nobody earned.

### The head-to-head guard is shared machinery, and it is now tested

The guard is a property of the step, not a swiss branch. It already existed (see
the correction above); what changes is that it is pinned. Breaking it deliberately
reds a swiss test **and** a pre-existing round-robin one, which is the empirical
demonstration that one piece of machinery serves both formats.

### A rematch counts twice in Buchholz

Buchholz iterates the outcomes, so an opponent met twice contributes their win
count twice. This is standard Buchholz, which is a sum over games played rather
than over distinct opponents, and it is what we take.

The alternative — summing over distinct opponents — would make a player's Buchholz
depend on how many of their games the pairing happened to repeat, which is not
something they controlled. Since a rematch only occurs when the greedy walk could
find no fresh opponent, double-counting keeps the measure a straight function of
the games actually played.

## Consequences

There are now two ordering functions to keep in step. That is the real cost, and
it is why they stay in one module where a reader sees both at once.

**A bye is slightly under-credited, deliberately.** An entrant who won 3-0 gains
game difference the byed entrant does not. Erring toward under-crediting a result
nobody played is the right direction to err.

**Buchholz moves as the event runs.** It is a function of opponents' current win
counts, so an entrant's tiebreak position changes when an opponent wins a later
match, without that entrant playing. This is inherent to the measure and is true
of every swiss event. Standings are computed live from completed matches, which
this module already does, so nothing needs to be recomputed or invalidated.
