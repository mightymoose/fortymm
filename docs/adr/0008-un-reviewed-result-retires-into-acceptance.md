# An un-reviewed result auto-accepts at the retirement deadline

The two-verb propose/accept model
(`docs/designs/match-result-model.md`) deliberately has **no timeout, deadline,
or auto-resolution** — its load-bearing claim is that "a match can never get
stuck, so there is no withdraw or void… after the first proposal the
negotiation is always advanceable by *someone*." That holds mechanically, but it
leaves a real product hole: a rated **standing result** the opponent never
answers stalls *forever*, so ratings never settle. This is the exact failure the
"Needs your attention" PRD opened with, and its own success metric
("rated matches stuck `in_progress` with ≥1 signature older than 7 days").

We decided to introduce **retirement**: when the side that owes a response lets
a per-match **retirement window** lapse, the **standing result auto-accepts**
through the *existing* accept path — the match completes and ratings settle
exactly as a manual accept would. The non-responding side forfeits its turn by
not taking it (a walkover, not the injury sense of "retire").

- **Anchored to the standing result, reset on every supersede.** The window is
  measured from the moment the current standing result was proposed. A counter,
  a self-edit, or a first post each start a *fresh* window against whichever
  side now owes the review — so retirement can only ever auto-accept a result
  the owing side has had the *full* window to see. Reuses the head of the
  result chain and ADR 0007's `result_id` discipline (the fired acceptance
  binds to the specific standing result, not "current standing").
- **Configured per match, opt-out-able.** A nullable `retirement_window`
  `Interval` on `match_settings` (default **7 days**; **`NULL` disables** and
  restores the plain never-auto-resolving negotiation). A tournament/club
  template can shorten, lengthen, or switch it off at match-creation time — the
  same copy-from-template path `match_settings` already documents. The
  invariant is therefore amended *opt-in*: a match only auto-resolves where the
  global default or a template explicitly set a window.
- **Never silent.** The retired party is notified that the match was finalized
  because they didn't respond in time, and a reminder fires as the deadline
  nears. Silent auto-acceptance would violate the no-silent-outcome principle
  ADR 0007 established.

## Considered options

- **Auto-accept the standing result (chosen).** The only option that resolves
  the stall the PRD exists to fix. Counter-intuitively it *honors* "a match can
  never get stuck" — it guarantees terminal resolution rather than adding a new
  limbo state.
- **Auto-void.** Discards the match, no result, no rating change. Safe but
  throws the played game away and settles nothing.
- **Nudge only** (visible clock + reminders, nothing auto-fires). Leaves the
  invariant untouched but also leaves the stall unfixed; "retirement" would be a
  misnomer.

## Consequence — and the tension we accepted

This is the deliberate reverse of ADR 0007, which went out of its way to make
acceptance **informed consent bound to a result the user was shown**.
Retirement binds a user to a rated result by *inaction*. We accept that: the
owing side was notified, shown the score, and given the whole window, and the
behavior is opt-out-able per match. It is consent-by-lapse, scoped and warned,
not silent.

Downstream: a new nullable `Interval` column + migration on `match_settings`; a
scheduled job (RQ) that fires at each standing result's deadline and drives the
existing accept path; the deadline recomputes whenever the result chain's head
changes; the dashboard/match/list BFFs expose the remaining time so the
front-end can render the countdown; and two new notifications (deadline-nearing
reminder, retired-on-lapse notice).
