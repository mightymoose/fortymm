# Design: first-class `MatchResult` (posted-result) model

**Status:** proposed · **Audience:** the engineer/agent implementing it · **Scope:** `api/` core, with a deliberately small `web-client/` footprint in phase 1.

## 1. Why

Today "a result was posted" is **implicit** — it's smeared across `match.status`,
the mutable `match_games` board, and the `match_signatures` rows that hang off the
`Match`. Three consequences:

- **Dispute discards history.** `POST /dispute` does `match.signatures.clear()` and
  re-opens the same `match_games` for editing (`api/app/matches.py` ~1991–2040). The
  exact board that was rejected is then mutated in place on re-score, so *what was
  disputed* is gone. Issue **#366** (surface invariant violations / recover past the
  decider) needs that history.
- **"Who disputed" has no natural home.** We just bolted a denormalized
  `matches.disputed_by_user_id` column on for the #360 banner. It works, but it can
  drift (`status != disputed` yet column set) and it only remembers the *latest*
  disputer.
- **The whole dispute/sign-off cluster** (#359 disputer ack, #360 submitter notice,
  #361 edit/withdraw during awaiting-confirmation, #366 recovery) keeps reaching for
  data that isn't modeled: who submitted, who responded, when, and what the responded-to
  board actually was.

Make the posted result a **first-class row** and all of that falls out. A
`MatchSignature` stops being "an attestation floating on the match" and becomes "a
response (confirm | dispute) to a specific posted result."

This refactor is the **foundation for the dispute cluster**, not a fix for any single
issue. #360 already shipped a stopgap (the `disputed_by_user_id` column + the
`DisputeNotice` banner); this design **subsumes and removes** that column.

## 2. Goals / non-goals

**Goals**
- A `MatchResult` entity: one row per posting, carrying who submitted, when, the
  immutable snapshot of the claimed board, and its outcome.
- Confirm/dispute become **responses to a result**, with full per-result history.
- Derive "who disputed / who submitted / awaiting-confirmation" from the model instead
  of denormalized flags. Remove `matches.disputed_by_user_id`.
- **Keep the `MatchDetails` / `MatchListRow` BFF contract stable in phase 1** so the
  front-end (the confirmation callout, the new dispute notice, the finalize callout, the
  matches list, the dashboard) is essentially untouched. The model changes *behind* the
  serializer.

**Non-goals (explicitly out of scope for the first PR)**
- New FE surfaces for result history / recovery (#366, #359, #361). The model *enables*
  them; building them is follow-up work.
- Changing the optimistic-concurrency score-write endpoints (`.../games/{n}/scores`),
  the rating pipeline, or the solver.
- Cryptographic signatures (the existing `match_signatures.signature` blob is already an
  unused placeholder; carry it forward unused or drop it — see §11).

## 3. Current state (read this first)

Precise inventory the implementer must work against. All `api/app/`.

- **Models:** `models/match.py` (`Match`, `MatchStatus`, the `signatures`/`games`/`sides`
  relationships, and the `disputed_by_user_id` column added for #360);
  `models/match_signature.py` (`match_signatures`: `id, match_id→matches CASCADE,
  user_id→users RESTRICT, signature(bytes,null), signed_at`; `uq_match_signatures_match_id_user_id`);
  `models/match_game.py` (`match_games`: `match_id→matches CASCADE, game_number`,
  `uq_match_games_match_id_game_number`); `models/match_game_score.py`
  (`match_game_scores`: `match_game_id→match_games CASCADE, side_1_points, side_2_points,
  version` (optimistic token, starts 1), `uq_match_game_scores_match_game_id`).
- **Endpoints (`matches.py`):** `post_match_result` /results (1858–1955),
  `confirm_match_result` /confirmation (1958–1988), `dispute_match_result` /dispute
  (1991–2040), score-write POST/PUT/DELETE `.../games/{n}/scores` (1714–1855).
- **Helpers (`matches.py`):** `_commit_canonical_games` (1565–1599, replaces
  `match.games` with the posted payload, updates denormalized `side.score`),
  `_validate_finalize_games` (1489–1526), `_add_signature_or_409` (971–994),
  `_requires_confirmation` (1611–1617, `affects_rating AND both sides have players`),
  `_all_sides_signed` (194–199), `_can_confirm` (997–1013), `_enforce_confirmable`
  (948–968), `_can_finalize` (1543–1562), `_is_scorable` (899–916, **gates on "no
  signatures"**), `_enforce_scorable` (919–945), `_set_side_won` (1602–1608),
  `_posted_decided_side` (1620–1631), `side_win_counts` (278–285), `current_game_number`
  (288–316), `_status_label` (202–220, `in_progress + signatures → "Awaiting
  confirmation"`), `_serialize_details` (319–399), `_apply_rating_update`,
  `_notify_result_posted` (1080+).
- **Domain/view:** `domain/match/models.py` `MatchModel.from_row` (id+status only);
  `mappers/match_details_mapper.py` `serialize_match_details` → `schemas/view/match_details.py`
  (`Scoreboard.status` only; `disputed/voided → final`).
- **Consumers of `match.signatures` / `match.status`:** `attention.py`
  `list_attention_kind` (46–73); the matches-list BFF + `MatchListFilter`
  (`schemas/match.py` 13–28, splits `in_progress` into `live` vs `awaiting_confirmation`
  on signature presence); `_status_label`; `dashboard.py`.
- **Schemas (`schemas/match.py`):** `MatchSignatureView` (169–175), `MatchDetails`
  (178–219: `signatures`, `disputed_by_user_id`, `can_confirm`, `can_finalize`,
  `status_label`, `data`), `MatchListRow` (225–252: `attention`, `can_confirm`).
- **Account merge:** `account_merge.py` `merge_user` re-points `match_signatures`
  (`_repoint_match_signatures`) and the `matches.disputed_by_user_id` column.
- **FE (`web-client/src`):** `mocks/match-store.ts` (`finalizeSeed`, `confirmSeed`,
  `disputeSeed`, `projectMatchDetails`, `projectListRow`, `listAttentionKind`,
  `canConfirmSeed`, `canFinalizeSeed`, `seedStatusLabel`); the match-details quartets
  (`confirmation-callout`, `dispute-notice`, `finalize-callout`, `score-cta`,
  `scoreboard`); `src/api/schema.d.ts` (generated).
- **Tests:** `api/tests/test_matches.py` is the big one — see the table in §10. Plus
  `api/tests/test_account_merge.py` and the FE quartet tests.

## 4. Proposed model

```
MatchResult                       # one row per POST /results — the "claim"
  id                  uuid pk
  match_id            uuid  -> matches.id            ON DELETE CASCADE
  submitted_by_user_id uuid -> users.id              ON DELETE RESTRICT   (re-pointed on merge)
  submitted_at        timestamptz  not null  default now()
  outcome             enum result_outcome  not null  default 'pending'
                        # pending | confirmed | disputed | superseded
  games               jsonb  not null        # immutable snapshot of the claimed board (see §5)
  # exactly one row per match has outcome='pending' OR the latest is terminal — see invariants

MatchResultResponse               # was: match_signatures. Confirm/dispute against a result.
  id                  uuid pk
  result_id           uuid  -> match_results.id      ON DELETE CASCADE
  user_id             uuid  -> users.id              ON DELETE RESTRICT   (re-pointed on merge)
  kind                enum result_response_kind  not null   # confirm | dispute
  created_at          timestamptz  not null  default now()
  UNIQUE (result_id, user_id)     # a participant responds to a given result at most once
```

Relationships: `Match.results: list[MatchResult]` (cascade `all, delete-orphan`);
`MatchResult.responses: list[MatchResultResponse]` (cascade `all, delete-orphan`);
`MatchResult.submitted_by` / `MatchResultResponse.user` → `User`.

**Lifecycle**

- `POST /results` → create a `MatchResult` (outcome `pending`), snapshot the validated
  games into `MatchResult.games`, and insert the submitter's `confirm` response (mirrors
  today's "poster's signature recorded on post"). Solo/unrated short-circuit: the result
  is created already `confirmed` and the match completes immediately (no second party).
- `POST /confirmation` → insert a `confirm` response on the current pending result. When
  every side has a `confirm` response → result `confirmed`, match `completed`, stamp
  `side.won`, run the rating update (exactly once, unchanged).
- `POST /dispute` → insert a `dispute` response on the current pending result; set that
  result `outcome = disputed`; match → `disputed`; re-open scoring. The disputed result
  **stays as history** (its `games` snapshot is the board that was rejected).
- `POST /results` again (re-score) → the prior result is already terminal
  (`disputed`); create a **new** `MatchResult`. (If you ever allow re-posting over a
  still-`pending` result, mark the old one `superseded` first.)

"Latest result" = the most recent `MatchResult` by `submitted_at` (or a
`matches.current_result_id` pointer — see §8 open question). Everything the BFF needs
derives from it + its responses.

## 5. Where do the scores attach? (the load-bearing decision)

Games exist **before** any result is posted — the live board is a mutable scratchpad
edited one game at a time via `.../games/{n}/scores` with the `version` token. So scores
split into two genuinely different things that today share one table:

1. **Working scores** — the scratchpad. **Stays exactly where it is:** relational
   `match_games` + `match_game_scores` on the `Match`. The score-write endpoints and
   their optimistic concurrency are **unchanged**. Zero churn on the hot path.
2. **A posted result's scores** — an immutable claim. Lives on `MatchResult` as a
   **JSONB snapshot** (`MatchResult.games`), frozen at post time.

**Recommended representation of the snapshot:** JSONB, decoded into a typed Pydantic
model at read (parse-don't-validate, exactly like `rating_state` does — see
`api/CLAUDE.md` "Type the I/O boundaries"). Shape:

```jsonc
// MatchResult.games
[{ "game_number": 1, "side_1_points": 11, "side_2_points": 4 },
 { "game_number": 2, "side_1_points": 11, "side_2_points": 5 }]
```

Write-once history is the textbook case for a blob; it avoids standing up a second set
of game/score tables and keeps the snapshot trivially diffable for #366.

`POST /results` therefore: validate the payload (`_validate_finalize_games`), write it
to `MatchResult.games`, **and** keep the working `match_games` in sync with the payload
so the displayed board equals the posted board (this is what `_commit_canonical_games`
already does — keep that call; just also snapshot). On dispute, working `match_games`
stay editable (reopened) while the disputed `MatchResult.games` snapshot preserves the
rejected board.

**Rejected alternative — `match_games.result_id`** (tag every game row with its result,
draft = null): keeps things relational/queryable but pushes the change into the
score-write path (every PUT must target "the current draft's games") and multiplies game
rows per posting. More invasive for no benefit the JSONB snapshot doesn't give. Note it
in the PR description as considered-and-rejected.

**Rejected alternative — the scratchpad *is* a `draft` MatchResult** (games always
belong to a result): most elegant on paper, most invasive in practice (the entire
scoring flow now mutates a result and you manage "which result is current" on every
keystroke). Not worth it.

## 6. Behavior changes, endpoint by endpoint (`api/app/matches.py`)

Keep the row-lock + `nowait` semantics on `/results`, blocking locks on
`/confirmation` + `/dispute`, and all the 409/422 reason-specific status codes.

- **`post_match_result` (/results):**
  - After `_validate_finalize_games` + `_commit_canonical_games` (keep both), create a
    `MatchResult(match, submitted_by=current_user, games=<snapshot>, outcome=pending)`.
  - Replace `_add_signature_or_409(...)` with inserting a `confirm` response on that
    result (reuse the same unique-violation → 409 mapping).
  - Solo/unrated (`not _requires_confirmation`): create the result `confirmed`, set match
    `completed`, `_set_side_won`, `_apply_rating_update` — as today.
  - **Delete** the `match.disputed_by_user_id = None` line (column is gone).
  - Notification (`_notify_result_posted`) unchanged.
- **`confirm_match_result` (/confirmation):** `_enforce_confirmable` (see below) →
  insert a `confirm` response on the current pending result → if `_all_sides_responded_confirm`
  then result `confirmed`, match `completed`, `_set_side_won(_posted_decided_side)`,
  `_apply_rating_update`.
- **`dispute_match_result` (/dispute):** `_enforce_confirmable` → insert a `dispute`
  response on the current pending result → result `outcome = disputed`, match `disputed`,
  reset `side.won = None` + `side.score = 0` (keep). **Drop** `match.signatures.clear()`
  and `match.disputed_by_user_id = ...`. The disputed result + its responses persist as
  history.
- **Score-write endpoints:** unchanged, but their gate changes (see `_is_scorable`).

## 7. Helper changes

- `_is_scorable`: "no signatures" → **"no pending posted result"** (the latest result,
  if any, is terminal — `confirmed`/`disputed`/`superseded`). After a dispute the latest
  result is `disputed`, so the board is scorable again — same outcome as today, derived
  differently.
- `_can_confirm` / `_enforce_confirmable`: "signatures exist + caller hasn't signed" →
  "there is a `pending` result + caller has no response on it." Same 409 reasons.
- `_all_sides_signed` → `_all_sides_responded_confirm`: every side has ≥1 `confirm`
  response on the current pending result.
- `_can_finalize`: "no signatures" → "no pending result" (board not currently posted).
- `_status_label`: `in_progress` + pending result → "Awaiting confirmation". Same string.
- `_requires_confirmation`, `_validate_finalize_games`, `_set_side_won`,
  `_posted_decided_side`, `side_win_counts`, `current_game_number`: unchanged logic; just
  stop reading `match.signatures`.
- New small helpers: `latest_result(match) -> MatchResult | None`,
  `pending_result(match) -> MatchResult | None`, `disputer_of(match) -> uuid | None`
  (the `dispute` response's user on the latest disputed result), `submitter_of(match)`.

## 8. Serialization — keep the BFF contract stable

This is the phasing lever. `_serialize_details` and the list serializer keep emitting the
**same `MatchDetails` / `MatchListRow` fields**, now derived from the new model:

- `signatures: list[MatchSignatureView]` → derive from the current pending result's
  `confirm` responses (`user_id`, `created_at`→`signed_at`). FE confirmation-callout
  unchanged.
- `disputed_by_user_id` → `disputer_of(match)` (latest disputed result's dispute
  response). **The #360 `DisputeNotice` FE keeps working with no change**, because the
  field is still present — it's just derived now instead of stored.
- `can_confirm` / `can_finalize` / `status_label` / `status` / `can_score` → from the new
  helpers. Same values.
- `MatchListRow.attention` / `MatchListFilter` (`live` vs `awaiting_confirmation`) →
  derive the "has a pending posted result" split from `pending_result(match)` instead of
  `match.signatures`.

Net: **front-end and the generated `schema.d.ts` are unchanged in phase 1** (the
`MatchDetails` shape is identical). Run `mise run regen-api-types` anyway and confirm a
**no-op diff** — that's the proof the contract held. New `data`-view fields exposing
result history are a *follow-up* PR (#366), additive.

> **Decision to make:** whether to add a `matches.current_result_id` FK pointer (fast
> "the live result" lookup + a clean place to enforce "≤1 pending") or always compute
> "latest" by ordering `results` by `submitted_at`. Recommendation: add the pointer — it
> makes the common path a single load and the invariant explicit. If you do, re-point it
> in `merge_user` is unnecessary (it points at a result, not a user), but eager-load it
> in the match loaders.

## 9. Migration (pre-deploy: edit in place, wipe, re-run)

fortymm is **undeployed**; per `api/CLAUDE.md` and team convention, do **not** chain an
"alter" migration — edit the originals in place and obliterate+recreate the DB to test
(`alembic downgrade base && alembic upgrade head` against a throwaway Postgres; the test
suite builds via `Base.metadata.create_all`, so also just running it exercises the
models).

- **Revision `0004` (`..._create_match_tables.py`):** **remove** the
  `disputed_by_user_id` column + its FK (added for #360). Add the `match_results` table
  and the `result_outcome` enum here (matches/results are the same domain). Keep revision
  ids and the `down_revision` chain frozen.
- **Revision `0007` (`..._create_match_signatures_table.py`):** rename
  `match_signatures` → `match_result_responses`; swap `match_id→matches` for
  `result_id→match_results` (CASCADE); add the `kind` column + `result_response_kind`
  enum; change the unique constraint to `(result_id, user_id)`. Rename the file's
  descriptive suffix (keep the `0007` prefix), its docstring, and constraint/index names
  (`uq_match_result_responses_result_id_user_id`, `ix_match_result_responses_result_id`).
- Update `app/models/__init__.py` re-exports (autogenerate/`create_all` discovery).
- No data backfill — there's no production data. (If that ever changes: one `MatchResult`
  per match that has games, `submitted_by` = the existing signer / `created_by`, existing
  signatures → `confirm` responses, disputed matches → a synthesized `dispute` response.
  Out of scope now.)

## 10. Test plan

`api/tests/test_matches.py` is where most of the change lands. Rewrite these to assert
the new model while preserving the **observable** behavior (status codes, `MatchDetails`
fields):

- Keep asserting via the API surface where possible (the `MatchDetails` contract is
  stable), so many assertions don't change at all.
- Tests that poke `match.signatures` directly or assert `disputed_by_user_id` as a stored
  column must move to the new model: `test_dispute_clears_signatures_and_moves_to_disputed`,
  `test_dispute_records_disputer_and_repost_clears_it`,
  `test_dispute_then_repost_finalizes_with_fresh_signatures`,
  `test_results_post_commits_canon_and_records_first_signature`,
  `test_confirmation_finalizes_and_lands_second_signature`,
  `test_signature_unique_violation_returns_409_not_500`,
  `test_signer_cannot_confirm_or_dispute_their_own_post`,
  `test_concurrent_confirm_and_dispute_serialize`,
  `test_score_endpoints_409_once_result_is_posted`,
  `test_list_live_filter_excludes_awaiting_confirmation`,
  `test_list_status_label_reflects_awaiting_confirmation`,
  `test_results_on_solo_finalizes_with_no_signature_row`,
  `test_unrated_result_*`, `test_dispute_zeros_side_score_to_match_won_reset`.
- **New tests the model unlocks:** a re-posted match keeps its prior disputed result as
  history (snapshot intact); a match accumulates N results across dispute→repost cycles;
  `outcome` transitions are correct; the disputed result's `games` snapshot ≠ the
  re-scored working board.
- `api/tests/test_account_merge.py`: update `_repoint_match_signatures` →
  responses + `MatchResult.submitted_by_user_id`. Replace
  `test_merge_repoints_match_disputer` (the column is gone) with a test that re-points a
  `submitted_by` / response `user_id`.
- **FE:** the BFF contract is stable, so the quartet tests and the `dispute-notice`
  quartet should pass **unchanged**. The MSW dev store (`match-store.ts`) must mirror the
  new derivation: `SeedMatch` gains a `results` list (each with `submitted_by`, `outcome`,
  `games` snapshot, `responses`), and `finalizeSeed`/`confirmSeed`/`disputeSeed` mutate
  *results* instead of `signatures`/`disputed_by_user_id`; `projectMatchDetails` derives
  the same `signatures`/`disputed_by_user_id`/`can_*` fields from them. Remove the
  `disputed_by_user_id` seed plumbing added for #360. `seedScoreboardStatus`,
  `listAttentionKind`, `seedStatusLabel` re-derive from results.

**Definition of done:** `cd api` → `ruff check`, `ruff format --check`, `mypy`, `pytest`
all green; `cd web-client` → `npm run lint`, `npm run build`, `npm run test:run` green;
`mise run regen-api-types` produces a **no-op** `schema.d.ts` diff (the contract held);
`alembic upgrade head` clean on a fresh DB. Then verify in the real QA stack exactly like
#360 was verified (two guest sessions, post→dispute→repost, see history preserved) — see
`/tmp/dispute-flow.sh` and `docs/designs/` for the harness pattern, or
`scripts/qa-up.sh`.

## 11. Open decisions for the implementer

1. **`current_result_id` pointer on `matches`** vs. compute-latest-by-`submitted_at`
   (§8). Recommendation: add the pointer.
2. **JSONB snapshot** (recommended) vs. relational `match_games.result_id` (§5).
3. **Drop the unused `signature` blob** when renaming the table, or carry it forward.
   Recommendation: drop it — it's never read; resurrect via a new migration if real
   crypto signing ever lands.
4. **Enum naming:** `result_outcome {pending,confirmed,disputed,superseded}` and
   `result_response_kind {confirm,dispute}`. Confirm these read well in OpenAPI / the TS
   client before committing.
5. **Should `match.status` be derived from the latest result** rather than stored? Bigger
   change; recommend keeping `match.status` stored and in sync for now (the list/dashboard
   indexes depend on it).

## 12. Suggested PR sequence

1. **PR 1 (this design's core):** new tables/models + endpoint/helper rewrite + stable
   BFF derivation + MSW store mirror + test migration. No new FE surfaces. `schema.d.ts`
   no-op. This removes `matches.disputed_by_user_id` while the #360 banner keeps working.
2. **PR 2+ (follow-ups, separate):** expose result history on the `data` view and build
   #366 (recovery UI), #359 (disputer ack — now trivially "your dispute was recorded"),
   #361 (edit/withdraw a pending result — now "withdraw" = void the pending result).

The #360 banner currently in flight is the stopgap; it stays shipped and unchanged
through PR 1 (its `disputed_by_user_id` field survives as a *derived* value).
