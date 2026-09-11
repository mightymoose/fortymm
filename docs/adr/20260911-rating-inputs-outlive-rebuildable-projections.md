# Rating inputs outlive rebuildable projections

Status: Accepted for #1683, following the design interview. Part of #1669.

Manual adjustments and imported ratings are original facts. Calculated rating
history and current ratings are projections that may be deleted and rebuilt.
Retain the original inputs and official result revisions, not every obsolete
calculation. Each match-derived projection identifies the official revision and
immutable strategy version it used; its revision must belong to that same match.

## Inputs and replay

An adjustment assigns an absolute rating at its effective time. It replaces only
the rating number: Glicko-2 deviation and volatility continue from the state
reached during replay. Imports obey the same rule. An earlier score correction
can change the uncertainty reaching an adjustment, but cannot change its explicit
rating. Subsequent matches calculate from the adjusted state.

Match events remain ordered by their original completion time and match ID.
Adjustments precede matches at the same instant; adjustments sharing an instant
have a stable recorded order. Recording time and effective time are distinct:
correcting an adjustment appends a replacement at the original effective time,
retaining the superseded input and original attribution. It does not rewrite
history or masquerade as a new adjustment made later. Only the active replacement
participates in replay.

Player reconciliation preserves each input's original Player and acting Account.
Replay resolves the explicit Player merge chain and combines both identities'
adjustments chronologically, without preference for the surviving identity.
There is one strategy starting state for the combined timeline. Automatic league
enrollment seeds are not adjustments and a second enrollment cannot reset play.
Voiding a match, including a self-play collision, removes its calculated influence
without deleting inputs or official results.

Replay reconstructs the connected group of players reached through rated matches
within the league, including earlier opponent histories. It leaves unrelated
groups untouched. The former forward-only cascade seeded from existing calculated
rows; that optimization cannot independently recover uncertainty after those rows
are deleted. Reconstructing earlier dependencies costs more work but makes the
durable facts sufficient to rebuild. A heavily connected league may require a
whole-league replay, making synchronous corrections slower. A future validated
checkpoint optimization must preserve the same result after checkpoint deletion.

## Strategy meaning and representation

Strategy definitions are immutable versions: algorithm, parameters, initial state
and state format must not change the meaning of existing references. Replay uses
the recorded version and refuses an unsupported version explicitly, rather than
quietly applying a newer formula. Introducing a league strategy-change workflow
is outside this issue.

The algorithm state is canonical. Retain the numeric rating column for existing
queries, with PostgreSQL enforcing its agreement with the state's rating rather
than relying only on application validation. Manual leagues retain an intentional
unrated state until an input supplies a rating; absence is not zero and does not
invent Glicko-2 uncertainty.

## Transaction and scope

An internal administrator correction and its affected rating replay succeed or
fail in the same transaction. The revision, displayed score and rating projections
must not commit a partial correction. Replay does not repeat first-completion
notifications or advancement effects. Existing Account-merge background processing
continues to own its per-league transactions. No public correction/adjustment
endpoint, UI or strategy migration workflow is introduced.

**Known concurrent-writer defect** (a separate beta prerequisite in
[#1669](https://github.com/mightymoose/fortymm/issues/1669)): the existing recompute advisory lock orders
recompute workers, but first-completion rating writes do not share that complete
serialization protocol. Separate matches involving the same Player can read the
same incoming rating; a replay can also race with a live completion. Revision
foreign keys and unique projection rows do not prevent those lost updates.
Minimum compatibility writes belong here, but a complete lock-order and
rating-writer serialization design is a separate follow-up. Atomic correction
rollback is not a claim that all concurrent rating writers are serialized.

## Amended decisions

- [The rating timeline is anchored on completed_at](0012-the-rating-timeline-is-anchored-on-completed-at.md):
  retain the stable match-time axis and deterministic ordering; durable adjustments
  now participate throughout replay, rather than surviving only as possible seeds
  in a disposable history table. An empty match list still replays its inputs.
  Supersede the forward-only scope restriction: earlier connected histories are
  needed to rebuild without trusting disposable projection seeds.
- [A self-play collision transfers the match then voids it](0013-a-self-play-collision-transfers-the-match-then-voids-it.md):
  retain collision voiding, but delete only projections; original inputs survive.
- [Accounts authorize durable Players](20260905-accounts-authorize-durable-players.md):
  replace the rating-history deletion policy with retained original Player inputs
  resolved through the merge chain. Historical Account actors remain unchanged.
- [Official results have immutable revisions](20260911-official-results-have-immutable-revisions.md):
  fulfill its deferred rating correction integration in the same transaction.
  Advancement reconciliation remains #1684.

## Verification

Use actual fresh Alembic installations and schema parity checks. Exercise accepted
results, correction chains, rating-only inputs, timestamp ties, replacement inputs,
Player merges and collisions through backend interfaces. Direct SQL tests enforce
immutable facts, scoped references and representation consistency. Test rollback
when correction replay fails and unchanged supported API behavior. The pre-beta
baseline may be rewritten until #1670; no legacy-data backfill is needed and this
change does not reset any deployed database.
