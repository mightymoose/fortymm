# Design: the two-verb match-result negotiation model

**Status:** accepted · **Audience:** the engineer/agent implementing the
negotiation epic · **Scope:** `api/` core + the `web-client/` match surfaces.

> This document is the spec for the **two-verb propose/accept** epic. It
> **replaces** the earlier "first-class `MatchResult` + confirm/dispute
> responses" design (the `MatchResultResponse` table and the
> `signatures[]` / `disputed_by_user_id` BFF shim). The repo is **undeployed**,
> so this is a hard replacement: no backward-compat shims, migrations flattened
> in place. The closed dispute-cluster bugs #359 / #360 / #361 / #366 were fixed
> under the old dispute model that this work removes; they do not survive.

## 1. Why

A finished table-tennis match has exactly one social problem: the two players
have to **agree on the score**. Everything the old model carried — post,
confirm, dispute, withdraw, "who disputed", `match_signatures`, a denormalized
`disputed_by_user_id` — was machinery around that one negotiation. It modelled
the *mechanism* (sign-offs, dispute flags, reopen-and-rescore) instead of the
*conversation* (one side claims a score, the other agrees or proposes a
correction).

Collapse it to the conversation and the machinery disappears:

- **There are only two things a participant ever does to a result:** *propose*
  one (a claim about how the match went) or *accept* the one on the table.
  "First post", "edit my own post", and "counter with a correction" are all the
  same act — propose a result that supersedes the standing one.
- **Disagreement isn't a special state.** It's just the other side proposing a
  different result instead of accepting. There is nothing to "dispute" and
  nothing to "reopen", because a still-negotiating match was never closed.
- **A match can never get stuck**, so there is no *withdraw* or *void*. A result
  is only ever minted from a **decided board** (a board with a victor). Before
  that, the match is a live scratchpad that either participant can edit; there
  is simply no result to be stuck on. After the first proposal the negotiation
  is always advanceable by *someone* (accept, or counter), so it can't deadlock.

The model that falls out is **one table and two verbs**. The supersede chain is
the entire history; consent is two columns.

## 2. Goals / non-goals

**Goals**
- One `match_results` table: proposer, optional acceptor, an optional
  `supersedes_result_id` self-link, and an immutable `games` snapshot. No
  responses table, no `disputed_by_user_id`.
- Two endpoints: `propose` (`POST /matches/{id}/results`, covers first-post =
  self-edit = counter) and `accept`
  (`POST /matches/{id}/results/{result_id}/acceptance`).
- The BFF (`MatchDetails` / `MatchListRow`) speaks the negotiation natively: a
  `negotiation` block with a **viewer-relative** state, turn flag, the standing
  result, the viewer's own prior proposal, and a **server-computed, viewer-
  relative diff**. The front-end renders it dumb.
- Make illegal states unrepresentable (per `api/CLAUDE.md`): a result's role
  (standing / accepted / superseded) is **derived from columns**, not stored in
  a drift-prone status enum.

**Non-goals**
- Cryptographic signatures (the old `match_signatures.signature` blob is gone;
  resurrect via a new migration if real signing ever lands).
- Changing the rating pipeline or the solver. `accept` reuses today's finalize
  path verbatim.
- A general result-history UI. The supersede chain *enables* one; building a
  dedicated history view is out of scope (the `corrected` diff is the only
  history surface this epic ships).

## 3. Current state (what we are flattening)

The phase-1 dispute model is **already in `main`** and is what this epic
rewrites. Inventory (`api/app/`):

- **Models:** `models/match_result.py` — `MatchResult` (`match_results`:
  `id, match_id→matches CASCADE, submitted_by_user_id→users RESTRICT,
  submitted_at, outcome (result_outcome enum: pending|confirmed|disputed|
  superseded), games jsonb`); `models/match_result_response.py` —
  `MatchResultResponse` (`match_result_responses`: `id, result_id→match_results
  CASCADE, user_id→users RESTRICT, kind (result_response_kind: confirm|dispute),
  created_at`, `uq_match_result_responses_result_id_user_id`).
  `models/match.py` — `Match.results` relationship + the `disputed_by_user_id`
  column.
- **Endpoints (`matches.py`):** `post_match_result` (`POST /results`),
  `confirm_match_result` (`POST /confirmation`), `dispute_match_result`
  (`POST /dispute`), `withdraw_match_result` (`POST /withdrawal`), and the
  score-write `POST/PUT/DELETE .../games/{n}/scores`.
- **Helpers (`matches.py`):** the signature/response machinery —
  `_add_signature_or_409` / response inserts, `_can_confirm`,
  `_enforce_confirmable`, `_all_sides_responded_confirm`, `_is_scorable`
  (gates on "no pending result"), `_can_finalize`, `_status_label`,
  `_posted_decided_side`, `_set_side_won`, `_apply_rating_update`,
  `disputer_of` / `submitter_of`, `_serialize_details`.
- **Schemas (`schemas/match.py`):** `MatchSignatureView`, and `MatchDetails` /
  `MatchListRow` carrying `signatures` + `disputed_by_user_id` + `can_confirm` /
  `can_finalize` / `status_label`.
- **Account merge (`account_merge.py`):** repoints `match_result_responses` and
  `match_results.submitted_by_user_id`, and the `matches.disputed_by_user_id`
  column.
- **FE (`web-client/src`):** `mocks/match-store.ts` (results + responses seed,
  `projectMatchDetails`, `projectListRow`); the match-details quartets
  (`confirmation-callout`, `dispute-notice`, `finalize-callout`, `score-cta`,
  `scoreboard`); the result hooks (`useFinalizeMatch`, `useConfirmMatch`,
  `useDisputeMatch`, `useWithdrawMatch`); `src/api/schema.d.ts` (generated).

## 4. The model

One table. No responses table, no `disputed_by_user_id`.

```
MatchResult                         # match_results — one row per proposal
  id                   uuid pk
  match_id             uuid -> matches.id           ON DELETE CASCADE
  submitted_by_user_id uuid -> users.id             ON DELETE RESTRICT   (repointed on merge)
  submitted_at         timestamptz not null default now()
  supersedes_result_id uuid -> match_results.id     ON DELETE CASCADE, NULL   (self-link, the chain)
  accepted_by_user_id  uuid -> users.id             ON DELETE RESTRICT, NULL  (repointed on merge)
  accepted_at          timestamptz NULL
  games                jsonb not null               # immutable snapshot of the claimed (decided) board
```

- **No `outcome` enum.** A row's role is derived, so it can't drift:
  - **accepted** ⟺ `accepted_by_user_id IS NOT NULL` (⟹ the match is `completed`).
  - **superseded** ⟺ some other row has `supersedes_result_id = this.id`.
  - **standing** ⟺ neither accepted nor superseded — the live head of the chain,
    the one thing a participant can accept or counter.
- **`supersedes_result_id` is the version history.** First-post → `NULL`. Every
  self-edit or counter → a new row pointing at the row it replaces. The chain is
  linear (see invariants); walking `supersedes_result_id` back to `NULL` is the
  full negotiation transcript.
- **Consent is two columns, not a collection.** The proposing side consents by
  the row's mere existence (`submitted_by_user_id`). The other side consents
  with a single `accepted_by_user_id` — **per side, one acceptor suffices** (for
  doubles, either opponent accepting binds the side). There is no "both must
  sign" set to accumulate.
- **`games` is immutable.** Frozen at propose time; a correction never mutates a
  snapshot, it mints a new row. This is what preserves the "what changed"
  history for the `corrected` diff.

**Relationships:** `Match.results: list[MatchResult]` (cascade
`all, delete-orphan`, ordered by `submitted_at`). `MatchResult.submitted_by` /
`MatchResult.accepted_by` → `User`. `MatchResult.supersedes` /
`MatchResult.superseded_by` self-relationship (optional; or just query the
column).

**Invariants (and how they're enforced):**
- **≤ 1 standing result per match.** Enforced procedurally by `propose`
  (first-post requires zero results; a counter requires its
  `supersedes_result_id` to be the current standing) under the existing NOWAIT
  row-lock. Optionally hardened with a `UNIQUE` on `supersedes_result_id` (a
  given row can be superseded by at most one successor ⟹ the chain stays
  linear; two concurrent counters to the same parent ⟹ one 409s on the unique
  violation rather than forking the chain).
- **A `games` snapshot is always a decided board** (a victor under `best_of`).
  Enforced at propose time (§6).
- **Accepted ⟹ terminal.** Once `accepted_by_user_id` is set, the match is
  `completed` and nothing supersedes it; `propose`/`accept` both reject against a
  completed match.

## 5. Where the scores live (scratchpad vs. snapshot)

Unchanged in spirit from the live board; the freeze rule is new.

1. **Working scores — the scratchpad.** Relational `match_games` +
   `match_game_scores` on the `Match`, edited one game at a time via
   `.../games/{n}/scores` with the optimistic-concurrency `version` token.
   **This is the pre-result board.** Two changes (#715):
   - **Either participant may edit it**, not just the creator. (Concurrent edits
     still serialize via `MatchGameScoreConflict` → 409.)
   - **It freezes the instant the first result is posted.** `_is_scorable` ⟺
     "no result row exists yet". Once a proposal stands, the scratchpad is
     read-only for the rest of the match; corrections seed from
     `standing_result.games`, **not** from `match_games`.
2. **A proposed result's scores — an immutable claim.** A JSONB snapshot on
   `match_results.games`, frozen at propose time. Shape (decode into a typed
   Pydantic model at read, per "parse, don't validate"):

   ```jsonc
   [{ "game_number": 1, "side_1_points": 11, "side_2_points": 4 },
    { "game_number": 2, "side_1_points": 11, "side_2_points": 5 }]
   ```

Because the scratchpad freezes at first post, there is no "re-open and mutate
the live board" path anymore — the negotiation happens entirely in the
immutable supersede chain. That is what makes every proposal's `games`
trustworthy as diff input.

## 6. The two verbs

Keep the existing row-lock + `nowait` semantics and the reason-specific 4xx
status codes. On any 409, return the current `negotiation` state in the body
(mirror `MatchGameScoreConflict`) so the client can re-render without a refetch.

### `propose` — `POST /matches/{id}/results`

Body: `{ games: [...], supersedes_result_id?: uuid }`. Covers **first-post**,
**self-edit**, and **counter/correction** — one endpoint.

1. **Decided-board hard gate.** Reject unless `games` constitute a victor under
   the match's `best_of` (promote the old `_can_finalize` "decided match" check
   to a strict precondition). An undecided/still-live board can never become a
   result → **422**. (A result *means* "this is how the match ended"; there is
   no such thing as a result for a live match.)
2. **`supersedes_result_id` is `null` → first-post.** Require **zero** existing
   results for the match; otherwise **409** with the current negotiation state.
3. **`supersedes_result_id` is set → self-edit or counter.** Require the
   referenced row to be the **standing** result (not accepted, not already
   superseded); otherwise **409** with the negotiation state (the client's token
   is stale — someone moved first).
4. Mint a new `match_results` row: snapshot `games`, set `submitted_by_user_id =
   current_user`, set `supersedes_result_id` from the body. **Do not** copy
   `accepted_*` — a fresh proposal is unaccepted by construction.
5. Solo/unrated short-circuit (`not _requires_confirmation`): there is no second
   party to accept, so a first-post finalizes immediately — stamp the proposal
   accepted (by the proposer, or leave `accepted_by` null and treat solo as
   self-accepting; pick one and document), set match `completed`, `_set_side_won`,
   `_apply_rating_update`. Same as today's solo finalize.

"Self-edit" vs. "counter" is **not** a field the endpoint branches on — both set
`supersedes_result_id` to the standing row. The only difference is *who* submits
relative to the chain, which the BFF derives for the viewer (§8). The endpoint
treats them identically.

### `accept` — `POST /matches/{id}/results/{result_id}/acceptance`

1. **`result_id` in the path is the concurrency token.** It must be the standing
   result. If it was superseded (someone countered first) or doesn't exist →
   **409 / 404** with the current negotiation state.
2. Caller must be a participant on the **opposing** side — the proposing side
   already consented by proposing. The proposer **cannot accept their own**
   standing proposal → 4xx.
3. On success: stamp `accepted_by_user_id = current_user` + `accepted_at = now()`
   on the standing row, mark the match `completed`, stamp `side.won`, and apply
   the rating update — **reuse today's confirmation finalize path verbatim**.

There is no separate "confirm". Accept *is* the confirmation, and it's the only
consent the opposing side ever gives.

### Deleted

`POST /confirmation`, `POST /dispute`, `POST /withdrawal` and every helper that
served them (`_add_signature_or_409`, `_enforce_confirmable`,
`_all_sides_responded_confirm`, `disputer_of`, the dispute/superseded `outcome`
branches, `_signature_views`) are removed. Nothing in the FE calls them after
the hook collapse (#716), so they delete cleanly.

## 7. BFF — the `negotiation` block

`MatchDetails` and `MatchListRow` **drop** `signatures[]` and
`disputed_by_user_id` and **gain** one `negotiation` block. Everything in it is
**viewer-relative** (computed for the current user) so the FE renders without
any client-side derivation.

```jsonc
negotiation: {
  viewer_state: "live" | "awaiting" | "review" | "corrected" | "final",
  your_turn: boolean,                 // drives the list badge
  standing_result:                    // the row the viewer can accept/counter; null when live
    { id: uuid, games: [...], submitted_by: uuid, submitted_at: datetime } | null,
  prior_result:                       // the viewer's OWN most recent proposal in the chain; the diff baseline
    { id: uuid, games: [...], submitted_at: datetime } | null,
  diff:                               // server-computed, viewer-relative; null when there's nothing to compare
    { game_number: int, old: { side_1_points, side_2_points } | null,
      new: { side_1_points, side_2_points } }[] | null
}
```

**`viewer_state`** (the match-detail callout selector):

| state       | when                                                                                         |
|-------------|----------------------------------------------------------------------------------------------|
| `live`      | no result row exists yet — the shared scratchpad (scoring).                                   |
| `awaiting`  | the **viewer's own side** submitted the standing result — waiting on the opponent.            |
| `review`    | the **opponent** submitted the standing result and the viewer has **no** prior proposal in the chain. |
| `corrected` | the **opponent** submitted the standing result and the viewer **has** a prior proposal in the chain (it's a counter to something the viewer proposed). |
| `final`     | the standing result is accepted (`accepted_by` set) — the match is completed.                 |

**`your_turn`** → the `Your turn / Waiting / Live / Final` list badge:
`live` → "Live", `awaiting` → "Waiting", `review` / `corrected` → "Your turn",
`final` → "Final". (`your_turn = viewer_state ∈ {review, corrected}`.)

**The viewer-relative diff (the load-bearing rule).** The baseline is **the most
recent proposal in the chain made by the viewer's own side** — *not* the row
immediately superseded. Walk the chain back from `standing_result` to the
newest row whose `submitted_by` is on the viewer's side; that's `prior_result`.
The diff is `prior_result.games` → `standing_result.games`, emitting only
changed game numbers with old→new points. This **collapses the opponent's
intermediate self-edits**: the viewer sees "what changed since I last spoke",
not the opponent's churn. `diff` is `null` when `prior_result` is `null`
(the viewer has nothing of their own to compare — e.g. `review`).

Worked cases (chain written oldest→newest; `A`/`B` = who proposed):

- **live** — no rows. `standing_result` null, `prior_result` null, `diff` null.
- **first proposal, opponent's turn** — `[R1·A]`. Viewer **B**: `review`,
  `prior_result` null, `diff` null (first thing B sees). Viewer **A**:
  `awaiting`.
- **self-edit before opponent saw it** — `[R1·A, R2·A]`. Viewer **B**: still
  `review`, `prior_result` null, `diff` null — B never saw R1, so R2 is just
  "the proposal". A's churn is collapsed away.
- **counter** — `[R1·A, R2·B]`. Viewer **A**: `corrected`, `prior_result = R1`,
  `diff = R1→R2`. Viewer **B**: `awaiting`.
- **opponent flip-flop then the viewer reads** — `[R1·A, R2·B, R3·B]`. Viewer
  **A**: `corrected`, `prior_result = R1`, `diff = R1→R3` — collapses B's R2/R3
  self-edits to a single "since you proposed R1" diff.
- **final** — standing row accepted. `viewer_state = final` for both;
  `standing_result` is the accepted row; the FE shows "confirmed" or "agreed
  after N corrections" (N = chain length − 1).

Regenerate `openapi.json` here; `schema.d.ts` regen lands in #716.

## 8. Migration (in-place flatten, undeployed)

fortymm is undeployed — **edit the existing migrations in place**, keep revision
ids + the `down_revision` chain frozen, and wipe + `alembic upgrade head` on a
throwaway DB to test (the suite also builds via `Base.metadata.create_all`).

- **`match_results` migration:** add `supersedes_result_id` (self-FK,
  `ON DELETE CASCADE`, nullable, optionally `UNIQUE`), `accepted_by_user_id`
  (`→ users`, `RESTRICT`, nullable), `accepted_at` (`timestamptz`, nullable).
  **Drop** the `outcome` column and the `result_outcome` enum type.
- **Delete the `match_result_responses` migration** (table + `result_response_kind`
  enum) entirely — the table is gone. Re-point the `down_revision` chain across
  the removed revision so it stays linear.
- **`matches` migration:** drop the `disputed_by_user_id` column + its FK.
- Update `app/models/__init__.py` re-exports (drop `MatchResultResponse` /
  `ResultResponseKind`; `match_results` discovery unchanged).
- No data backfill — there is no production data.

Every `DateTime` column stays `timezone=True` (model **and** migration), per
`api/CLAUDE.md`.

## 9. Account merge (#714)

`merge_user` tombstones the ephemeral user, so every owned FK is repointed by an
explicit statement (no CASCADE fires). Update `account_merge.py`:
- Replace the `match_result_responses` repoint with repointing
  **`match_results.accepted_by_user_id`** from the ephemeral to the surviving
  user.
- Keep the existing `match_results.submitted_by_user_id` repoint.
- **Remove** the `matches.disputed_by_user_id` repoint (column gone).
Both ownership columns are `RESTRICT`, so missing either leaves a result pointing
at a tombstoned ghost — the merge tests must cover both.

## 10. Test plan

**Backend (`api/tests/test_matches.py` is the bulk).** Delete the
confirm/dispute/withdraw tests outright; replace with the negotiation surface:
- `propose`: first-post requires zero results; undecided board → 422; self-edit
  chains; counter chains; stale `supersedes_result_id` → 409 carrying
  negotiation state; concurrent-propose conflict (NOWAIT) → 409.
- `accept`: accepting the standing result finalizes + applies ratings exactly
  once; accepting a superseded `result_id` → 409 with negotiation state;
  proposer can't accept their own standing proposal; wrong-side rejection.
- `negotiation` BFF: assert `viewer_state` + the **viewer-relative** diff for
  every §7 worked case (live, review-first, review-after-self-edit-no-diff,
  corrected-counter, corrected-collapses-flip-flop, final). The
  baseline-is-the-viewer's-own-last-proposal rule is the thing to pin.
- scratchpad (#715): either participant edits pre-first-post; concurrent edits
  409 cleanly; score endpoints reject once a result exists.
- `test_account_merge.py`: repoint `submitted_by` **and** `accepted_by`; drop
  the disputer-column test.

**Frontend.** MSW `match-store.ts` mirrors the new model: a `results` list with
the supersede chain + `accepted_by`, no signatures/responses; `projectMatchDetails`
/ `projectListRow` compute the `negotiation` block (the viewer-relative diff
included) the same way the server does. Hooks collapse to `useProposeResult` +
`useAcceptResult` (#716); vitest green; `mise run regen-api-types` produces a
**real** `schema.d.ts` diff and the `openapi-schema` CI job is green on the
committed file.

**Definition of done (per landing unit):** `cd api` → `ruff check`,
`ruff format --check`, `mypy`, `pytest` green; `cd web-client` → `npm run lint`,
`npm run build`, `npm run test:run` green; `schema.d.ts` committed and matching
`openapi.json`; `alembic upgrade head` clean on a fresh DB. Then verify in the
real QA stack with two guest sessions: score a decided board → propose →
counter → accept, and confirm the `corrected` diff renders the viewer-relative
change.

## 11. Decisions for the implementer

1. **No `outcome` enum** (recommended): derive standing/accepted/superseded from
   the columns. The alternative — a stored status — re-introduces exactly the
   drift `api/CLAUDE.md` warns against. If a denormalized "is there a standing
   result" flag is needed for an index, derive it in the loader, don't store it.
2. **`UNIQUE(supersedes_result_id)`** to make "the chain is linear / at most one
   standing result" a DB invariant rather than only a procedural one
   (recommended; mirrors the partial-unique hardening landed for #180).
3. **Solo/unrated finalize:** stamp `accepted_by = submitter` on the first post,
   or leave `accepted_by` null and special-case solo as self-accepting. Pick one
   and document it where `_requires_confirmation` is read.
4. **Diff shape:** emit `old`/`new` per changed game (this doc's shape) so the FE
   renders strikethrough-old / emphasized-new with zero logic (#720). `old` is
   `null` for a game that didn't exist in the baseline.

## 12. Landing units (PR sequence)

This epic is a **hard replacement with no shims**, so most tickets are not
independently green — deleting `MatchResultResponse` + `disputed_by_user_id`
breaks every consumer until the new endpoints + BFF replace them, and the BFF
shape change forces a `schema.d.ts` regen that drags the FE build into the same
merge gate. The realistic green landing points are three:

1. **Docs (#708)** — this rewrite, alone.
2. **Backend + minimum FE (#709–#715, #712, #714, #716, and the *rewire* slice
   of #719)** — the flattened schema, both endpoints, the BFF negotiation block,
   the scratchpad freeze, the merge repoint, the legacy-endpoint deletion, the
   regenerated `schema.d.ts`, the collapsed hooks, and just enough FE to compile
   green against the new contract (gut old-field consumers, update MSW). One
   atomic green PR.
3. **Rich FE (#717 ‖ #720 → #718 → #719)** — the shared score-entry component,
   the diff component, the `matches.$matchId.correct` proposal-authoring route,
   and the full `viewer_state` callouts + list badges. Additive, green throughout.
