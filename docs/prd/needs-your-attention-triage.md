# PRD — Dashboard "Needs your attention" triage module

**Status:** Largely shipped — reconciled to the two-verb model; one net-new area (retirement) still to build
**Author:** Ryan Morris
**Last updated:** 2026-07-08
**Surface:** Dashboard (web + mobile web), Matches list, Match detail
**Design:** `docs/designs/Needs Attention Panel.pdf`

---

## 0. Status reconciliation (2026-07-08)

**This PRD was written 2026-06-15, against the *old* match-result model
(confirm / dispute / sign-off / `MatchSignature` / the `disputed` enum). The
two-verb propose/accept epic (#721, `docs/designs/match-result-model.md`) landed
2026-06-28 and *replaced that model*, then the panel was built on top of it.**
So most of this document describes behavior that already shipped, in vocabulary
the codebase has since retired. What actually stands today:

| Requirement | State |
|---|---|
| P0-1 panel, P0-3 rows, P0-4 sort, P0-5 footer | **Shipped** (`attention-panel.tsx`, PRs #547 / #620). |
| P0-2 review-needed BFF | **Shipped** as the `review` kind; `GET /v1/dashboard` returns `attention` / `attention_total_count` / `waiting_count`, current-user-aware via `app/attention.py`. |
| P0-6 `Attention` filter | **Shipped** (`attention` param + server query). |
| P0-7 user-aware labels | **Shipped** — `match-list-row-view.ts` maps `review → "Needs your review"`, `score → "Needs score"`, `waiting_opponent → "Waiting on opponent"` off the viewer-relative `negotiation.viewer_state`. (The server's shared `status_label` still returns `"Awaiting confirmation"` as a fallback only.) |
| P0-8 match-detail review context | **Shipped in two-verb form** — see the rewritten §8 below. |
| Priority-0 "Resolve dispute" tier (D3) | **Removed.** The two-verb model has no dispute *state*; `MatchStatus.disputed` is never set by any code path, so the `kind: "dispute"` row was dead. A **separate in-flight PR removes the `disputed` enum value** and its now-dead classifier arms. Not re-litigated here. |

**Vocabulary correction (binds the whole doc).** Per `CONTEXT.md`, there is **no
"confirm" and no "dispute"** — a reviewer either **accepts** the standing result
or **proposes a correction** (a full re-score that supersedes it). Read every
"confirm" / "dispute" below as accept / propose-correction. Disagreement is not
a state; it is just a counter-proposal, and a match is never "stuck."

**What is genuinely still to build:** result **retirement** — a per-match
countdown after which an un-answered standing result auto-accepts so ratings
settle (new §14 + P0-9 below). This is the one area that needs building, not
documenting.

## 1. Problem statement

Players miss required match actions because the work that needs them is scattered. Today the dashboard surfaces only *score-needed* items (the `score_banners` array from `GET /v1/dashboard`) and a single pending match — it has **no concept of a rated result that another player has posted and is waiting on the current user to confirm.** That review/confirmation step lives only on the match-detail page and an APNS push, so a player who misses the notification has no in-app surface that says "a rated result is waiting for your sign-off."

The dashboard also fails to distinguish "your turn" from "waiting on someone else," and the matches list reuses one ambiguous label ("Awaiting confirmation") for both sides of a posted result. The cost is real: rated matches stall un-confirmed, ratings don't settle, and players lose trust that the app is telling them what to do next.

## 2. Goals

1. Make the dashboard answer one question at a glance — "what needs me right now?" — by consolidating score-entry, result-review, and dispute-resolution into a single ranked panel.
2. Surface rated-result confirmation in-app, independent of push notifications, so review-needed matches are discoverable without browsing the full matches list.
3. Make "your turn" vs. "waiting on them" unambiguous everywhere it appears (dashboard panel, matches list labels, match detail).
4. Keep the dashboard calm and bounded — a triage surface, not a task inbox — by capping the panel and routing all final decisions to the right page.
5. Give players one trustworthy destination ("View all") for the complete pending picture, with attention-priority ordering.

## 3. Non-goals

- **Not a notification inbox.** The panel triages *match actions* only; it does not absorb social, club, or system notifications.
- **No score details in the panel.** Rows show opponent + action, never game scores. Full scores stay on scoring / detail pages.
- **No final decisions from the dashboard.** `Confirm result` and `Dispute` never appear in the panel; its buttons only route.
- **No change to the default matches-list sort.** Attention-priority sorting is scoped to the new `Attention` filter only. `All`, `Live`, `Up next`, `Final` keep their current newest-first behavior.
- **No tournament/league priority tier in v1.** The data model has no tournament/league match type, so that distinction is deferred (see §7, decision 2).
- **No deadline-based *sorting* in v1.** Retirement (§14) adds a per-match
  window and a countdown, but the `Attention` sort still uses the §5 ranking
  (tie-broken oldest-waiting-first); ordering rows *by* remaining time is still
  deferred (see P2-1).

---

## 4. Current-state grounding (what exists today)

This section records what the code does now, so the requirements below are precise about what changes.

**Dashboard.** Route `web-client/src/routes/dashboard.tsx` → component `web-client/src/components/dashboard/dashboard-page.tsx`, fed by `useDashboard()` (`web-client/src/api/dashboard.ts`) calling `GET /v1/dashboard` (`api/app/dashboard.py`). The response (`DashboardResponse` in `api/app/schemas/dashboard.py`) is `{ score_banners, next_match, recent_results, rating, completed_match_count }`. The UI renders score banners (an orange-ringed "Enter final score" card plus a compact second banner and a "+N more pending" pill that links to `/matches?status=live`), a "Your game" rating card, recent results, and a guest-persistence banner. There is **no review-needed feed.**

**Matches list.** Route `web-client/src/routes/matches/index.tsx`, fed by `useMatchList()` (`web-client/src/api/matches.ts`) calling `GET /v1/matches` with `status` (`pending` / `in_progress` / `completed`), `q` (username search), and pagination. Tabs map to `All / Live / Up next / Final`. Sort is newest-first within a status. Labels come from server `status_label`.

**Match statuses.** `MatchStatus` enum (`api/app/models/match.py`): `pending`, `in_progress`, `completed`, `disputed`, `voided`. Server labels (`api/app/matches.py` ≈ lines 190–208): `Scheduled`, `Live`, `Final`, `Disputed`, `Voided`, and `Awaiting confirmation` for an `in_progress` match that already has ≥1 signature. **These labels are not current-user-aware** — both the poster and the reviewer see "Awaiting confirmation."

**Result flow** (`api/app/matches.py`):
- Per-game score writes (`POST/PUT .../games/{n}/scores/...`); locked once a result is posted (422 "posted result awaiting confirmation").
- `POST /v1/matches/{id}/results` — posts the series result. Solo/unrated matches complete immediately; rated matches with an opponent create a `MatchSignature` for the poster, stay `in_progress`, and push an APNS confirmation prompt to the opponent.
- `POST /v1/matches/{id}/confirmation` — the other side signs; when all sides have signed, status → `completed` and ratings apply.
- `POST /v1/matches/{id}/dispute` — clears all signatures, resets `side.won` to null, **leaves status at `in_progress`**, and re-unlocks scoring. (Note: the standalone `disputed` enum value is not set by this flow today — see §7, decision 3.)

**Match detail.** `GET /v1/matches/{id}` → `MatchDetails` with `can_score`, `can_finalize`, `can_confirm`, `status_label`, `signatures`, `sides[].won`, `games`, `current_game`. UI callouts: `finalize-callout.tsx` ("Post result") and `confirmation-callout.tsx` ("Confirm" / "Dispute" / "Awaiting <opponent>").

**Rated vs. unrated.** Driven by `match_settings.affects_rating`; solo matches are forced unrated; rating cards show only for automatic-strategy (e.g. Glicko-2) leagues. There is **no tournament/league match-type field** — every match belongs to one `League`.

**Handles.** Players are shown as `@username` throughout.

---

## 5. Resolved decisions

These were confirmed with the product owner during scoping; the requirements below assume them.

| # | Decision | Resolution |
|---|----------|------------|
| D1 | Sort order vs. mockup emphasis | **Follow the priority list.** Review-needed rows sort above score-needed and may take the primary button. The PDF mockup (score rows on top, Review result as a secondary outline button) is treated as illustrative and should be re-cut to match. |
| D2 | Tournament/league vs. rated priority tiers | **Collapse to four tiers for v1** (no tournament/league field exists). |
| D3 | Disputed matches | **Own row type — `Resolve dispute` — ranked at the very top** of attention. |
| D4 | Panel scope vs. existing UI | **Replace the existing score banners.** Panel includes in-progress score-needed + review-needed + disputes; pending/scheduled matches contribute to the `waiting on others` footer count. |
| D5 | Primary when review is mixed with score | Highest-priority bucket wins (review can be primary) — consistent with D1. |
| D6 | "Waiting on others" treatment | **Footer text only, never a full row.** |
| D7 | "View all pending" label | **Shorten to `View all`.** |

### Attention-priority ranking (v1)

```
0. Resolve dispute        (own row type — top)
1. Result needing review  (rated result posted by opponent, awaiting current user)
2. Rated score to enter   (affects_rating = true)
3. Score to enter         (unrated / friendly)
4. Waiting on others      (footer count only)
```

Within a bucket: oldest waiting-on-user first; otherwise fall back to the existing recency rules (`created_at` for pending, `updated_at` for in-progress). Deadline-first is deferred (§10).

---

## 6. Core UX

### 6.1 The panel

A single dashboard panel titled **`Needs your attention`** that replaces the current score banners. It shows **up to 3 visible rows**, each compact and action-oriented. A footer summarizes everything not shown as a row and links to the full view.

Row anatomy: a player avatar/initials, `vs @opponent-handle`, and one action button. No scores, no status prose.

Example (illustrative — note ordering follows D1, review first):

```
Needs your attention
  ⚠  vs @congenial-wallaby   [ Resolve dispute ]
  RV vs @lively-otter        [ Review result ]
  BI vs @brainy-inchworm     [ Enter score ]
  ───────────────────────────────────────────
  2 waiting on others · View all
```

### 6.2 Row types

**`Resolve dispute`** (priority 0)
- A match the current user disputed or had disputed against them, now reopened for score correction.
- Button routes to the scoring page (or match detail where correction begins).
- Always ranks above all other attention rows.

**`Review result`** (priority 1)
- A rated match where the opponent posted a result and the current user must review it.
- Button routes to **match detail**, which holds `Confirm result` / `Dispute`.

**`Enter score`** (priorities 2–3)
- A match where the current user needs to enter or finish scoring (rated ranks above unrated).
- Button routes to the scoring page.

**`Waiting on others`** (priority 4 — footer only)
- Matches where no action is available to the current user: a result the current user posted and is awaiting the opponent's sign-off, plus scheduled/pending matches whose next move isn't theirs.
- **Never rendered as a full row.** Summarized in the footer (e.g. `2 waiting on others`).

### 6.3 Button rules

- The **primary** button is the most direct action the current user can take to move a match forward.
- One actionable item → its button is primary.
- Multiple same-type actionable items → all primary.
- Mixed actionable types → primary goes to the **highest-priority bucket** present (D1/D5); lower-priority routing (e.g. `Review result` beneath a `Resolve dispute`) may render secondary.
- Passive (`waiting on others`) items never get a primary button — and never appear as rows anyway (D6).
- **Dashboard buttons always route; they never finalize a decision.**

### 6.4 Overflow & footer

- Show the top 3 attention rows only; never let the panel grow unbounded.
- Footer combines an overflow count and/or a waiting count with the `View all` link:
  - `3 more need attention · View all`
  - `2 waiting on others · View all`
  - both, when applicable: `3 more need attention · 2 waiting on others · View all`
- If there are zero attention items, the panel shows a calm empty state (e.g. "You're all caught up") rather than disappearing, so the surface is predictable. *(Empty-state copy — open question O4.)*

### 6.5 `View all` behavior

`View all` routes to the matches list with a new **`Attention`** filter active. This replaces the current "+N more pending" pill, which links to `/matches?status=live`.

---

## 7. Matches list changes

### 7.1 New `Attention` filter

Add an `Attention` filter/tab to the matches list. It includes: needs score, needs review, resolve-dispute, and waiting-on-others matches. **Only this filter uses attention-priority sorting** (§5 ranking). Existing tabs are unchanged:

| Tab | Status param | Sort |
|-----|--------------|------|
| All | (none) | newest-first (unchanged) |
| Live | `in_progress` | newest-first (unchanged) |
| Up next | `pending` | newest-first (unchanged) |
| Final | `completed` | newest-first (unchanged) |
| **Attention** *(new)* | new server-side attention query | **attention-priority** |

### 7.2 Current-user-aware labels

Replace ambiguous shared labels with current-user-aware ones. This requires the matches-list BFF to compute the label relative to the requesting user (today `status_label` is shared):

| Situation | New label |
|-----------|-----------|
| Current user must enter/finish a score | `Needs score` |
| Opponent posted a rated result; current user must review | `Needs your review` |
| Current user posted; awaiting opponent | `Waiting on opponent` |
| Reopened after dispute, current user can correct | `Resolve dispute` |
| Ambiguous/shared context only | `Awaiting confirmation` (kept only where the actor is obvious) |

Each row shows the matching action where applicable: `Enter score`, `Review result`, `Resolve dispute`, or `View match` for passive states.

---

## 8. Match-detail requirements (review-required matches) — *reconciled to two-verb; shipped*

There is no `Confirm` button and no `Dispute` button. A reviewer either
**accepts** the standing result (agreeing to it → the match completes and
ratings settle) or **proposes a correction** (a full re-score that supersedes
it). The genuine requirement — *give the reviewer enough context to decide
before they act* — survives, restated in that vocabulary. **This is already
built** in `confirmation-callout/…/confirmation-callout-display.tsx`; this
section documents it rather than specifying new work.

For a match where the opponent posted the standing result, match detail must,
before any action:

- state it is **the opponent's posted result** awaiting the viewer *(shipped:
  "Your opponent has posted the result below")*,
- state whether the match is **rated** and what accepting does *(shipped
  `StakesLine`: "Accepting finalizes this rated match and updates both
  ratings." / the unrated variant)*,
- show the **full game scores** — the board on the page, plus, on a `corrected`
  standing result, the **server-computed viewer-relative diff** of what changed
  *(shipped: `ScoreDiff`)*,
- offer **Accept** and **Suggest correction** / **Counter** *(shipped)*.

**The accidental-accept guard is the real safety concern — and it already
exists.** Accept is one tap bound to a specific `result_id` (ADR 0007). The
danger is finalizing a result you never saw because the opponent superseded it;
the shipped callout catches the 409 and swaps Accept for a "reload to review the
latest score" prompt (#726) rather than silently retargeting. That is a stronger
guarantee than the old "Dispute needs a confirmation step" ask, which is dropped.

**Known residual gap (small, optional):** the `review` copy says "Your opponent"
generically rather than naming the `@handle`. In a 1v1 match that is unambiguous,
so this is a nicety, not a defect — track as a P1 polish item if desired, not a
P0.

- *AC (shipped, regression-guard):* Opening a review-required match shows the
  opponent-posted copy, the rated/unrated stakes line, and the full board (plus
  the correction diff when the standing result is a correction); the primary
  action is Accept and the secondary is Suggest correction / Counter. Accepting a
  standing result that was superseded meanwhile 409s and prompts a reload rather
  than finalizing the unseen result.

---

## 9. User stories

**Triage (dashboard)**
- As a player with a posted rated result waiting on me, I want it shown on my dashboard so that I can confirm it without hunting through my matches or relying on a push I may have missed.
- As a player mid-match, I want unfinished scoring surfaced as `Enter score` so that I can jump straight back into the right game.
- As a player whose match was disputed, I want a top-ranked `Resolve dispute` prompt so that I know a rated result is stuck on me.
- As a player, I want to tell "my turn" from "waiting on them" at a glance so that I'm not anxious about matches I can't act on.
- As a player with many pending items, I want a bounded panel plus a `View all` link so that the dashboard stays calm but complete.

**Full view (matches list)**
- As a player, I want an `Attention` filter that gathers everything needing me, priority-ordered, so that I can clear my queue in sensible order.
- As a player scanning my matches, I want labels that say whose turn it is (`Needs your review` vs. `Waiting on opponent`) so that statuses aren't ambiguous.

**Decision (match detail)**
- As a reviewer, I want match detail to show who posted, whether it's rated, the full scores, and what confirm/dispute each do, so that I can decide with full context.
- As a reviewer, I want `Dispute` to require a confirmation step so that I don't reopen a match by accident.

**Edge / empty**
- As a player with nothing pending, I want a clear "all caught up" state so that the panel's absence isn't confusing.

---

## 10. Requirements

### Must-have (P0)

**P0-1 — Attention dashboard panel.** Render `Needs your attention` on the dashboard, replacing the existing score banners, with up to 3 priority-ordered rows + footer.
- *AC:* Given the current user has ≥1 actionable match, the panel renders the top 3 by the §5 ranking. Given >3 actionable items, only 3 rows show and the footer reports the overflow. Given 0 actionable items, a calm empty state shows.

**P0-2 — Review-needed feed (BFF).** Extend the dashboard BFF (`GET /v1/dashboard`) to return review-needed (and dispute) items in addition to score-needed, current-user-aware, pre-ranked.
- *AC:* Given an opponent posted a rated result awaiting the current user, the dashboard response includes that match as a `review` item. Given the current user posted and awaits the opponent, it is classified `waiting` (footer), not a row. Given a disputed/reopened match actionable by the current user, it is classified `dispute` at top priority.

**P0-3 — Row types & routing.** Support `Resolve dispute`, `Review result`, and `Enter score` rows; every button routes (scoring page for score/dispute-correction, match detail for review). No `Confirm`/`Dispute` action in the panel.
- *AC:* Clicking `Review result` lands on match detail with confirm/dispute available. Clicking `Enter score` lands on the correct game's scoring page. No panel button finalizes a result.

**P0-4 — Attention-priority sort.** Apply the §5 ranking in the panel and in the `Attention` filter; tie-break oldest-waiting-first then existing recency.
- *AC:* A rated review item ranks above a rated score item; a dispute ranks above both; an unrated score ranks last among actionable items.

**P0-5 — Footer & `View all`.** Footer shows overflow and/or waiting counts and a `View all` link routing to the matches list with `Attention` active. Waiting items never render as rows.
- *AC:* With 1 actionable + 2 waiting, the panel shows 1 row and footer `2 waiting on others · View all`. `View all` opens matches list with the `Attention` filter selected.

**P0-6 — `Attention` matches-list filter.** Add the filter with attention-priority sort; leave `All/Live/Up next/Final` behavior unchanged.
- *AC:* Selecting `Attention` lists needs-score + needs-review + resolve-dispute + waiting items, priority-ordered. Selecting any other tab preserves today's newest-first sort.

**P0-7 — Current-user-aware labels.** Matches-list labels reflect whose turn it is (`Needs score`, `Needs your review`, `Waiting on opponent`, `Resolve dispute`); reuse `Awaiting confirmation` only where the actor is unambiguous.
- *AC:* For the same `in_progress`+signed match, the poster sees `Waiting on opponent` and the reviewer sees `Needs your review`.

**P0-8 — Review-required match-detail context.** *(Shipped; reconciled to
two-verb — see §8.)* Match detail for a match awaiting the viewer's response
states it is the opponent's posted result, the rated stakes, the full board (and
the correction diff on a `corrected` result), and offers **Accept** / **Suggest
correction**. The accidental-accept guard is the shipped stale-result 409 →
reload prompt (#726), not a "dispute confirmation step."
- *AC:* as restated in §8.

**P0-9 — Result retirement (auto-accept on lapse).** *(Net-new — the one
unbuilt area.)* A per-match **retirement window** after which an un-answered
standing result **auto-accepts** through the existing accept path, so rated
matches stop stalling and ratings settle. Window lives on `match_settings`
(nullable `Interval`, default 7 days, `NULL` disables), overridable by a
tournament/club template. The countdown is surfaced wherever the match needs the
viewer (match detail, the dashboard attention row, the `Attention` list row);
the retired party is notified on lapse and reminded as the deadline nears. Full
spec in §14. See ADR 0008.
- *AC:* Given a rated standing result the opponent hasn't answered and a non-null
  window, when the window elapses the standing result is accepted, the match
  completes, ratings apply, and the retired party receives a "finalized because
  you didn't respond" notification.
- *AC:* Given the opponent counters before the window elapses, the window resets
  against the *other* side (the new standing result's clock); the prior deadline
  no longer fires.
- *AC:* Given `retirement_window IS NULL`, no auto-acceptance ever occurs and no
  countdown is shown (plain never-auto-resolving negotiation).

### Nice-to-have (P1)

- **P1-1 — Empty/all-caught-up state polish** beyond the basic P0 placeholder.
- **P1-2 — Aging / countdown cue** on rows. Superseded in substance by §14.3:
  once retirement lands, the cue is the real countdown to the retirement
  deadline, not an `updated_at` stand-in.
- **P1-3 — In-app badge/count** on the Matches nav reflecting attention count.

### Future considerations (P2)

- **P2-1 — Deadline-aware sorting** — order `Attention` rows *by* time left on
  the retirement window. Now unblocked by §14 (the window field exists); deferred
  only as a sort-behavior change, not for lack of data.
- **P2-2 — Tournament/league priority tier** — restore the full 6-tier ranking once a league/match type field exists (D2).
- **P2-3 — Auto-resolution/escalation** — *promoted into P0-9 / §14 (retirement).*
  Escalation *beyond* a single auto-accept (e.g. multi-stage nudges, admin
  review) remains future.

---

## 11. Success metrics

**Leading (days–weeks)**
- Median time from result-posted → confirmed for rated matches drops (target: −40% vs. pre-launch baseline).
- Share of rated results confirmed in-app (panel/`Attention` filter) vs. via push, climbs (target: ≥50% of confirmations originate in-app within 30 days).
- Dashboard → scoring/detail click-through rate from the panel (target: ≥60% of sessions with an actionable item act on it).

**Lagging (weeks–months)**
- Reduction in rated matches stuck `in_progress` with ≥1 signature older than 7 days (target: −50%).
- Reduction in "where do I confirm a result?" support/feedback volume.
- No regression in dashboard load time or matches-list query latency from the new BFF work.

*Measurement note:* baselines to be pulled from current `MatchSignature` timestamps and dashboard analytics before launch; evaluate at 1 week, 1 month, 1 quarter.

---

## 12. Open questions

- **O1 (eng/product):** ~~dispute actor~~ **Resolved / moot.** The two-verb model
  has no dispute; disagreement is a counter-proposal by whichever side owes the
  review. No owner to designate.
- **O2 (eng):** ~~`disputed` enum targeting~~ **Resolved / moot.** Nothing sets
  `MatchStatus.disputed`; the `Attention` query targets `in_progress` (with the
  standing-result split doing the review/score/waiting work). A separate in-flight
  PR removes the enum value.
- **O3 (product):** Do pending/scheduled matches that need the *current user* to accept/start count as an actionable row, or only ever as `waiting on others`? D4 puts pending in the footer, but an "accept this match" action may deserve a row. *Non-blocking; default to footer for v1.*
- **O4 (design):** Empty-state copy and treatment for the panel when nothing needs attention.
- **O5 (design):** Re-cut the mockup to reflect D1 (review-needed ranked above score-needed, review may be primary) — current PDF shows the opposite emphasis.
- **O6 (data):** ~~Confirm no existing per-match SLA/deadline~~ **Resolved.**
  Verified none exists (2026-07-08); §14 introduces `retirement_window` as the
  first per-match deadline.
- **O7 (retirement, product):** Default window = **7 days**, `NULL` disables
  (§14.2) — confirmed. Open sub-questions: exact reminder cadence before the
  deadline (one warning? escalating?), and whether the *waiting* side also sees an
  "auto-accepts on X" reassurance line or only the owing side sees "respond by X."
  *Non-blocking for the model; design detail.*
- **O8 (retirement, eng):** Job mechanism — per-deadline scheduled RQ job vs. a
  periodic sweep that scans for lapsed windows. Sweep is simpler and idempotent;
  per-deadline is timelier. *Eng call at build time; either satisfies §14.*

---

## 13. Timeline & dependencies

- **Dependency — OpenAPI regen.** Any change to `/v1/dashboard`, `/v1/matches`, or new attention fields requires `mise run regen-api-types` and committing `web-client/src/api/schema.d.ts` in the same PR (per repo `CLAUDE.md`).
- **Dependency — BFF current-user awareness.** P0-2 and P0-7 both hinge on computing labels/classification relative to the requesting user; build that classification once (server-side) and reuse it for the dashboard panel, the `Attention` filter, and list labels.
- **Suggested phasing:**
  1. **Phase 1 (P0-2, P0-7):** server-side attention classification + current-user-aware labels (no UI yet).
  2. **Phase 2 (P0-1, P0-3, P0-4, P0-5):** dashboard panel replacing score banners.
  3. **Phase 3 (P0-6, P0-8):** `Attention` matches-list filter + match-detail review copy.
- No hard external deadline identified.

---

## 14. Result retirement (P0-9) — the net-new area

Retirement closes the one hole the two-verb model left open on purpose: a rated
**standing result** the opponent never answers stalls forever, so ratings never
settle — exactly the "stuck `in_progress` >7 days" the success metrics target.
See **ADR 0008** for the decision and the tension it accepts; **`CONTEXT.md`**
for the canonical definitions of **Retirement** and **Retirement window**.

### 14.1 Behavior

- **At the deadline, the standing result auto-accepts.** It runs the *existing*
  accept path — the match completes and ratings apply exactly as a manual accept
  would. Silence from the owing side is treated as consent-by-lapse.
- **The clock belongs to the standing result and resets on every supersede.**
  The window is measured from when the current standing result was proposed. A
  first post, a self-edit, or a **correction** each start a fresh window against
  whichever side then owes the review. Retirement can therefore only ever
  auto-accept a result the owing side has had the *full* window to see. The fired
  acceptance binds to that specific `result_id` (ADR 0007), so a result
  superseded inside the window never auto-accepts.
- **Rated-with-opponent only, by construction.** The window only has meaning
  when the match owes a second-party acceptance (`verification_policy ∈
  {opponent_confirms, all_players_confirm}`). Solo/`self_report`/unrated matches
  finalize at post — there is no standing result to time out, so the field is
  inert on them.
- **Never silent.** The retired party is notified that the match was finalized
  because they didn't respond in time, and a reminder fires as the deadline
  nears. (No-silent-outcome, per ADR 0007.)

### 14.2 Configuration — `match_settings.retirement_window`

A new **nullable `Interval`** column on `match_settings`:

| Value | Meaning |
|---|---|
| `7 days` *(default)* | Normal match — auto-accept a week after the standing result is proposed. |
| a shorter/longer interval | A tournament or club **template** tightens or loosens the window; copied onto the match's settings row at creation (the copy-from-template path `match_settings` already documents). |
| `NULL` | **Retirement disabled** — plain never-auto-resolving negotiation. |

This makes the amendment to "a match can never get stuck" **opt-out per match**:
a match only auto-resolves where the global default or a template explicitly set
a window. `NULL` restores the original two-verb behavior verbatim.

### 14.3 The countdown (the UI ask)

Surface *time remaining on the standing result's window* wherever the match is
asking for the viewer's move:

- **Match detail** — on the review/`corrected` callout ("N days left to
  respond"), escalating in tone as it nears zero.
- **Dashboard attention row** and **`Attention` list row** — a compact aging /
  countdown cue (this is P1-2 made concrete and load-bearing rather than a
  cosmetic "waiting 3 days").
- **Reuse the existing derive-now-during-render countdown pattern**
  (`login-screens.tsx`'s `ExpiresCountdown`) rather than a new ticking store.
- Show it to *both* sides where useful: the owing side sees "respond by X"; the
  waiting side may see "auto-accepts on X" for reassurance. When
  `retirement_window IS NULL`, show no countdown.

### 14.4 Server work

- **Column + migration** on `match_settings` (nullable `Interval`, default
  `7 days`; timezone-safe per `api/CLAUDE.md`).
- **A scheduled job** (RQ) that fires at each standing result's deadline and, if
  that result is still the un-accepted head, drives the accept path; recomputed
  whenever the result chain's head changes (post / self-edit / correction).
- **BFF exposure** — the dashboard, match-detail, and match-list BFFs carry the
  standing result's deadline (or remaining interval) so the front-end renders the
  countdown without knowing the rules.
- **Two notifications** — deadline-nearing reminder, and retired-on-lapse notice
  to the party who didn't respond.
- **OpenAPI regen** for any new response fields (`schema.d.ts` + iOS
  `Types.swift`, per the root `CLAUDE.md` invariant).
