# The Approve push binds to the result it showed, not to current standing

The result-confirmation push renders an **Approve** action on the lock screen so
a recipient can accept their opponent's reported score in one tap. The push body
carries the specific score ("Alice reported beating you 3–0. Games: 11-4, 11-6,
11-8. Accept or suggest a correction?"), so the tap is informed consent — *for
that result*. But the handler carried only `match_id` and, on tap,
**re-resolved the current standing result** and accepted whatever that was
(`acceptStandingResult(matchId)` → GET the match → accept `standingResult.id`).
A stale lock-screen notification describing R1 could therefore bind the user to a
later self-edited R2 they never saw — silently defeating the `result_id`
concurrency token the accept endpoint (`POST /.../results/{result_id}/acceptance`,
spec §6) exists to enforce (finding D7).

We decided to keep the one-tap background Approve — the body is already fully
informative and it is the whole point of the APNs action — but make it bind to
the result the notification was *about*, with defense in depth:

1. **`apns-collapse-id = f"result-confirm:{match_id}"`.** A superseding
   proposal's push *replaces* the stale one on the lock screen (works even when
   the app isn't running), so a stale Approve mostly never survives to be
   tapped. Also gives one live result-confirmation notification per match
   instead of a stack. The id is **scoped to the push type**, not a bare
   `match_id`, so a future non-result push for the same match can never collapse
   over (or be clobbered by) a pending Approve — only result-confirmation pushes
   for a match collapse together.
2. **`result_id` in `push_data`, used as the token.** The Approve action passes
   *that* id to `acceptResult(matchId, resultId)` — no re-fetch of current
   standing. The user accepts exactly the score the notification showed; a
   superseded id 409s at the endpoint instead of binding to a different result.
3. **409 → local follow-up notification.** If the tapped result was superseded
   in the collapse window, iOS catches the 409, does not accept, and posts a
   local notification ("this result changed — open the match to review"), or
   deep-links to the match when the app is foreground. Honest feedback, no
   silent outcome.

## Considered options

- **Keep one-tap, make it token-safe (chosen).** The notification is already
  informative and the token makes staleness a 409; three layers make the stale
  tap rare, correct when it happens, and never silent.
- **Downgrade Approve to "open the match".** Foreground-only; always open to
  current standing and accept there. Safest, but discards the lock-screen
  one-tap the feature exists to provide, to solve a problem the token already
  solves.
- **Silent no-op on 409.** Rejected — trades D7's silent-wrong-accept for a
  silent-nothing; the user assumes their tap worked.

## Consequence

The push payload gains `result_id`; the APNs sender gains an optional
`collapse_id` parameter (the `apns-collapse-id` header) threaded from the
notification job — added to the `PushSender` Protocol and every implementation
(`NoopSender`, `APNsClient`, the test helper) so `mypy --strict` stays green.
iOS's
`acceptStandingResult(matchId)` re-fetch path is replaced by
`acceptResult(matchId, resultId)` driven off the payload token. Accepting from a
notification is now bound to the score the user was shown, on every surface.
Fixes D7.
