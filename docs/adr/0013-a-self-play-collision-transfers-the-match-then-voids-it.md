---
status: accepted
---

# A self-play collision transfers the match to the claimed account, then voids it (#750)

When a **guest** merges into a **claimed account** they had already played, both
users sit on opposite sides of the same match. `_repoint_match_side_players` skips
re-pointing the guest's row (the `NOT EXISTS` guard — the claimed account is already
on that match, and `uq_match_side_players_match_id_user_id` forbids a second row).
The belt-and-braces `DELETE` then drops the guest's `MatchSidePlayer`, emptying their
side, and the prune deletes that now-empty `MatchSide`.

For an unrated match that prune is right: it stops "vs Guest" surfacing in history.
For a **rated, completed** match it is a **half-delete**. The match keeps
`status == completed` and `affects_rating`, but has one side. The claimed account's
`rating_history` row for it survives — recording points won against themselves —
while `_decided_sides()` now returns `None`, so the cascade *skips* the match and
never deletes or replays that row. The rating stays inflated, permanently, with no
surface that can correct it.

## Decision

A **self-play collision** is not an error and never blocks the merge. The merge is
simply the moment the system learns the match was always one person playing
themselves. So, at merge time, for each collided match:

1. **Transfer it to the claimed account.** This is mostly *already true* and must
   stay true: the merge unconditionally re-points `match.created_by_user_id`,
   `match_result.submitted_by_user_id` / `accepted_by_user_id`, and
   `rating_history.created_by_user_id` before it touches sides. The one pointer that
   cannot move is the guest's `MatchSidePlayer` row —
   `uq_match_side_players_match_id_user_id` forbids the claimed account appearing
   twice on one match, and that constraint is load-bearing (it is what makes
   `_repoint_match_side_players`'s rowcount equal the number of matches moved). The
   claimed account already has a `MatchSidePlayer` row on the match, so the match
   stays in their **match history** without any new re-pointing.
2. **Leave the opposing side player-less.** Do *not* prune it. This is the same
   structural shape a **solo match**'s sentinel side already has, and the reads
   tolerate it. Pruning is what half-deletes the match today.
3. **Void it.** `status = voided` — a status that already existed in the domain,
   read everywhere (rendered "Voided", terminal, closed to new proposals, excluded
   from the recompute's `status == completed` filter) and, until now, **written
   nowhere**. The collision is its first producer.
4. **Delete its `rating_history` rows, for both users.** The recompute cannot do
   this: its `DELETE` is scoped to `affected_match_ids`, which comes from a
   `status == completed` query, so a voided match's rows are unreachable from there.

This establishes a domain rule beyond the merge path: **voiding a match deletes its
rating history.** A voided match is *absent* from the rating timeline, not merely
skipped by it.

## The empty-timeline reset

Voiding can remove a user's **only** rated match. Two guards then conspire to strand
the inflated rating: `_recompute_after_merge` discovers leagues by selecting matches
where the user has a *completed* rated match (now none, so the job returns before the
cascade runs), and `recompute_league_ratings` returns early when `t_start is None`.

**The recompute owns this case, not the merge.** `t_start is None` now means "this
user's timeline is empty, therefore their state is the strategy's initial state," and
the recompute writes that rather than returning. League discovery widens from "has a
completed rated match" to "has a rating row in this league" so the empty case is
reachable at all. Non-automatic strategies still bail at the existing `is_automatic`
guard.

This restores the module's own invariant — *"reads current state and rewrites it
deterministically"* — which the empty timeline was the one input to falsify. Every
user already has a `UserLeagueRating` row and an `initial` `RatingHistory` event from
`seed_user_rating`, so "no rated matches" means "initial state", never "no row".

## Considered option: guard the prune and keep the match

Adding a `completed`/`rated` guard to the prune is the fix the issue proposes. It
stops the half-delete but preserves the corruption: a completed, rated, one-sided
match whose rating history says the user beat themselves. It fixes the symptom the
ticket names and leaves the defect the ticket is about.

## Considered option: refuse the merge

Rejected. The merge is the mechanism by which a guest becomes a real user. Blocking
it to protect a rating inverts the priority, and punishes the player for the system's
own failure to notice the collision earlier.

## Considered option: hard-delete the match

Rejected. The players remember playing it. `voided` already means "kept, but does not
count" — deleting throws away a record for which we have a perfectly good status.

## Considered option: forbid rated guest-vs-claimed matches upstream

`matches.py` resolves `affects_rating = payload.rated and opponent is not None` with
no verified-opponent requirement, which is what permits the rated guest-vs-claimed
match to exist. Rejected as a wrong-layer fix: a guest legitimately playing a claimed
account is real and common, and forbidding it to prevent a rare merge collision trades
a live feature for an edge case. The match was not wrong when it was created. The
merge is the event that makes it wrong, so the fix belongs at merge time.
