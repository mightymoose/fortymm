# api/CLAUDE.md

Conventions for the FastAPI service. See the root `CLAUDE.md` for repo layout,
commands, and architecture.

The two guiding principles for new code: **make illegal states
unrepresentable**, and **type the I/O boundaries so errors are caught by the
type checker, not at runtime**. The rules below are how those principles cash
out in this codebase.

## Verification

`app/` is type-checked under `mypy --strict` and linted + formatted with
`ruff`; CI (`.github/workflows/api.yml`) gates on all of them. After every
change, run from `api/`:

1. `ruff check app tests` — lint (auto-fix the trivial ones with `--fix`)
2. `ruff format app tests` — format (CI runs `ruff format --check`)
3. `mypy` — strict type check; settings live in `pyproject.toml`
4. `pytest` — tests (needs Docker for testcontainers)

## Architecture

**Solver health is a real round-trip.** `GET /v1/health` enqueues a job on the
`solver` RQ queue and waits up to 10s for a worker to solve a tiny CP-SAT
problem (`app/solver.py:solve_hello_world`). With no worker running, health
fails. Tests sidestep this by replacing the queue with `fakeredis` +
synchronous RQ in `tests/conftest.py` (`fake_solver_queue` autouse fixture).

**Ephemeral, cookie-based sessions.** `GET /v1/session` creates an Account, primary Player and grant, plus
a `UserToken` (sha256-hashed) on first hit and sets an HTTP-only `session`
cookie; subsequent hits resolve the user from that cookie. Tokens are
namespaced by `context` so a single user table can back multiple credential
types later. `SESSION_COOKIE_SECURE` defaults true; set to `false` for local
non-HTTPS dev (compose already does this).

**Alembic discovers models via `app.models` import.** `migrations/env.py` and
`tests/conftest.py` both import `app.models` for the side effect of
registering on `Base.metadata`. New model files must be re-exported from
`app/models/__init__.py` or autogenerate will miss them.

**Tests** use async pytest (`asyncio_mode = "auto"`, session-scoped loop) and
the `db_session` fixture, which truncates all tables after each test.

## Datetimes are timezone-aware, always

- **Migrations:** every `sa.Column(..., sa.DateTime(...), ...)` must use
  `sa.DateTime(timezone=True)`. Bare `sa.DateTime()` is forbidden.
- **Models:** every `Mapped[datetime]` column must explicitly pass
  `DateTime(timezone=True)` to `mapped_column(...)`. Import `DateTime` from
  `sqlalchemy`. SQLAlchemy's default is naïve — do not rely on it.
- **Test seeds too, not just columns.** `tournament_fixtures.scheduled_start` /
  `pinned_at` are `timestamptz` (since #1152); a naïve `datetime` seeded by a test
  reads back in the *session* timezone, so it passes on a Central-time dev box and
  fails in UTC CI. Seed aware — `datetime.now(UTC)`, `tzinfo=UTC`.
- Pydantic / response schemas are exempt unless they emit a naïve datetime.

## Table naming: `<singular_parent>_<plural_child>`

- Use `user_tokens`, `user_roles`, `role_permissions`, `match_settings`,
  `match_sides`, `match_side_players`, `match_games`.
- Not `users_tokens`, `users_roles`, `roles_permissions`.
- Class names stay singular and unchanged (`UserToken`, `UserRole`,
  `RolePermission`).
- Index / constraint names mirror the table name with the prefix scheme the
  codebase already uses: `ix_`, `uq_`, `ck_`, `fk_`. So
  `ix_user_tokens_user_id`, not `ix_users_tokens_user_id`.

## Classify identity foreign keys

Sporting participation, entries, membership and ratings reference `players.id`.
Authentication and historical actors reference `accounts.id`. Never repoint a
historical creator, submitter, acceptor or entry-adder during an Account merge.
Current tournament ownership has its own `owner_account_id`. `User` remains a
compatibility alias for Account; a legacy `user_id` name does not identify its domain.

Authorize sporting actions through explicit AccountPlayer grants and live identities.
The primary grant is optional and unique; never infer it from equal IDs or pick an
arbitrary secondary Player. See [the identity ADR](../docs/adr/20260905-accounts-authorize-durable-players.md)
for the complete FK classification and merge rules. New owned state must specify its
Account-transfer or Player-merge policy; historical actors must remain preserved.

## Pre-deploy: edit migrations in place

Until the first production deploy, fix schema mistakes by editing the
existing migration file rather than adding an "alter" migration. Obliterate
and re-run alembic against a fresh database to test.

- Until #1670 freezes the beta baseline, rewriting or consolidating migrations is
  permitted. #1671 replaces the old chain with `0001_pre_beta_baseline`.
- Keep the baseline self-contained and in dependency order, with catalogue seeds.
  Do not build legacy backfills for disposable pre-beta data.
- After #1670, use forward, data-preserving migrations; routine resets stop.
- **Deleting a revision invalidates every database that applied it.** Alembic
  refuses outright — `Can't locate revision identified by '00NN'` — it does not
  degrade. So a roll-up means wiping UAT, local dev databases, and any live QA stack
  volume, not just re-running migrations. That is affordable pre-deploy and will
  stop being affordable the day it isn't.
- **A test may load a migration by filename.** `tests/test_match_calls_notifications.py`
  reads its seed constant straight out of a migration module, so deleting or renaming
  one turns that test into a `FileNotFoundError`. Grep the suite for the filename
  before you delete a revision.

**Route/schema/docstring changes regenerate `openapi.json`.** A FastAPI route
**docstring** becomes the OpenAPI description, so even a docstring edit drifts the
generated clients. After changing any route, Pydantic request/response schema, or
docstring, the generated types need regenerating: `mise run regen-api-types`
(`web-client/src/api/schema.d.ts`) and `mise run regen-ios-api-types`
(`ios/Fortymm/Generated/Types.swift`), committed in the same change — the
`openapi-schema` CI job fails on drift. (See the root `CLAUDE.md` for the full
invariant.) This regen is the main session's job, not the `api` domain-expert
subagent's — if you're that subagent, flag it in your summary instead of
running it yourself (see `.claude/agents/api.md`).

The regen boots its own throwaway API: `scripts/ensure-api-up.sh` binds a
fresh ephemeral port every time and reuses nothing already listening, even on
`:8000` — a listener there is not proof it came from this working tree (see
`.claude/rules/verify-the-artifact-under-test.md`). `.githooks/pre-push` skips
its drift check with a warning, rather than regenerating, whenever `api/` has
uncommitted changes — booting from a dirty working tree would judge drift
against code the push doesn't carry.

## Testing gotchas

**Backend fixtures run the actual Alembic baseline in a fresh named database.**
This includes the proposal-history triggers, which `Base.metadata.create_all`
cannot install. `TEST_DATABASE_URL` selects the server on which to create that
disposable database; the supplied database is not reset. Between tests, TRUNCATE
resets the disposable database and fixtures restore representative seeds.
`tests/test_identity_migrations.py` additionally checks untouched catalogue seeds,
schema parity and baseline reinstall. Run it for every schema or migration change.

**A race test written the obvious way passes against a broken implementation.**
`asyncio.Barrier` + `asyncio.gather` over two sessions both hitting the endpoint only
reds when the scheduler happens to interleave the damning way: with the capacity
`COUNT(*)` hoisted above the tournament row lock — a genuinely broken guard that lets
two entrants take the same last slot — the gather-based version stayed green. **Stage
the contention instead of hoping for it:** a gatekeeper session takes the row lock and
holds it, both contenders are launched into the handler, the test asserts they *block*
(`pytest.fail` if either finished — an unlocked read never waits), then the gatekeeper
releases. Now a count above the lock necessarily reds. Copy the harness in
`tests/test_tournament_entries.py` —
`test_two_entrants_racing_for_the_last_slot_yield_exactly_one_entry`, plus
`_hold_the_go_live_lock` beside it for the ADR-0017 go-live races. Why the lock is the
whole enforcement: capacity is a count on one table compared against a column on
another, so unlike the duplicate-entry partial unique index it *cannot* be a database
constraint — nothing underneath catches a loser that slipped through.

Concurrency is where the repo-wide "a test you have not seen fail is not evidence"
corollary bites hardest — **run the falsification**: hoist the count above the lock,
confirm the test reds *for the stated reason*, put it back. See
`.claude/rules/verify-the-artifact-under-test.md`.

**Some display strings are DB seed data, not app code.** Notification category and
channel display names are seed rows: the pre-beta baseline inserts them,
`tests/conftest.py` re-seeds them by hand
(`NOTIFICATION_TYPE_LABELS` / `NOTIFICATION_CHANNEL_LABELS`, after each test reset),
and `web-client/src/test/factories.ts` mirrors them for MSW.
Three places that must change together — and a copy/wording sweep that greps `app/`
finds none of them.

## Make illegal states unrepresentable

The goal is that a value that compiles/validates cannot be in a contradictory
state. Reach for the type system before reaching for a runtime check.

- **No tri-state booleans for what is really a sum type.** `bool | None` to mean
  {yes, no, unknown} — or two parallel `won: bool | None` flags that could both
  be `True` — lets contradictions exist. Model the outcome once, as a closed
  set of cases (an `Enum`, or a discriminated union of Pydantic models), so
  "both sides won" can't be constructed. (Existing `MatchSide.won` is the
  pattern we're moving away from, not toward.)

- **Don't carry a field and its own derivation in the same model.** If
  `status_label` is a pure function of `status`, don't store both on the
  schema where they can drift — expose the derived value with a Pydantic
  `@computed_field`, or send only the source and derive client-side. Never
  hand-map with a raw dict index (`STATUS_LABELS[status]`): a missing key is a
  runtime `KeyError`. If you must map an enum, do it in one place with an
  exhaustive `match` that has no catch-all, so adding an enum member is a type
  error until you handle it.

- **Use `Literal` / `Enum` for small closed domains, not `int`/`str`.**
  `best_of: Literal[1, 3, 5, 7]` beats `best_of: int` + a hand-written
  validator: it self-documents in OpenAPI and is checked statically.
  `side_number: Literal[1, 2]` beats `int`. Reserve `int`/`str` for genuinely
  open domains.

- **Distinct ID types, not bare `uuid.UUID` everywhere.** Define
  `UserId = NewType("UserId", uuid.UUID)`, `MatchId`, etc., so the type checker
  rejects passing a match id where a user id is expected. They are
  interchangeable today and that is a latent class of bug.

- **Prefer total functions; don't index into possibly-empty collections.**
  `side.players[0]` assumes "singles" — an empty or doubles side is a
  representable DB row that will `IndexError`. Either model the invariant
  (`SinglesSide` vs `DoublesSide`, or a non-empty list) or handle the empty
  case explicitly and return early.

- **Solo matches carry a player-less sentinel side — never bulk-delete "empty"
  sides.** A solo match's side 2 legitimately has zero `match_side_players`. A
  cleanup like `delete(MatchSide).where(~MatchSide.players.any())` will wipe
  every solo match's side 2 platform-wide. "Has no players" is a valid state,
  not orphaned data — scope any such delete to the specific match/rows you mean.

## Type the I/O boundaries

Every edge where data enters or leaves the process — request bodies, response
bodies, the database, JSONB columns, queue payloads — gets a precise type. The
interior should never traffic in `Any` or untyped `dict`.

- **`response_model` (or a typed return) on every route.** No endpoint returns
  a bare `dict`. A handler that returns `{"email": ...}` needs a response model
  (`class LoginAccepted(BaseModel): email: EmailStr`) so the generated TS client
  gets a real shape.

- **Request models reject the unexpected.** New request schemas set
  `model_config = ConfigDict(extra="forbid")` — an unknown key is a client bug
  worth a 422, not something to silently drop. Consider `strict=True` for
  inbound types to disable lax coercion.

- **Parse, don't validate — turn untyped blobs into typed objects at the
  boundary.** JSONB columns are the main offender. `rating_state` flows around
  as `dict[str, Any]` and is read with stringly-keyed access (`state["rating"]`,
  `state.get("rd")`); a malformed row only fails deep in the call stack. Decode
  JSONB into a Pydantic model (a discriminated union over the strategy key)
  at read time, so the rest of the code holds a `Glicko2State` /`ManualState`
  with real fields and `KeyError` is impossible. New code must not introduce
  another `dict[str, Any]` that crosses more than one function.

- **An optional field on a *write* schema takes `X | None = None`, never a
  non-null default.** The two look equally optional in Python and generate
  opposite contracts. `openapi-typescript` promotes any property carrying a
  **non-null** default to **required** in the generated TypeScript, so
  `position: int = 0` and `unplace_fixtures_on_removed_tables: bool = False`
  both arrive in the client as fields every caller must send — while
  `description: str | None = None` generates the `field?:` you wanted. On a
  PATCH body, where omitting a key means "unchanged", that is simply wrong: it
  compels a rename to send a whole table catalogue, or an unrelated edit to
  restate a destructive opt-in.

  It is not caught by anything local. `mypy` is happy, `pytest` is happy, and
  the damage only appears after `mise run regen-api-types` when the web client
  stops compiling — which is a chore or two later, in someone else's diff.
  #1226 hit it twice in two slices before it was named.

  If a field is genuinely server-assigned, the stronger move is to keep it off
  the write schema altogether — a read model that extends the write model
  (`class Reservation(ReservationWrite)`) makes "the client cannot send this" a fact of the
  schema rather than a promise in a docstring, and `extra="forbid"` turns an
  attempt into a 422 naming the field.

  **`default_factory` is not the same trap** — Pydantic emits no `default` key
  into the JSON schema for one, so `table_catalogue: list[TableWrite] =
  Field(default_factory=list)` already generates as `table_catalogue?:`. The
  rule is about the *default's* nullness in the emitted document, so read the
  document, not the Python, when you're unsure: no `default` key, or a `null`
  one, means optional.

- **Collapse a nullable wire field to a total value at the boundary.** Making a
  write field optional buys the client a third value it did not have, and
  `bool | None` reaching the interior is exactly the tri-state boolean the rule
  above forbids. Answer the question once, on the schema, and let the interior
  hold the real type:

  ```python
  unplace_fixtures_on_removed_tables: bool | None = None

  @property
  def unplacing_is_confirmed(self) -> bool:
      return self.unplace_fixtures_on_removed_tables is True
  ```

  Omitted, `false` and `null` are one answer — nobody opted in — and they are
  merged where they arrive, so no caller downstream can ask and get three.
  `RoundRobinDrawSettingsWrite.qualifiers_per_group` is the same shape. Optional
  on the wire, total inside.

- **Don't use `assert x is not None` as control flow after a DB load.** A
  loader typed `-> Match | None` forces the caller to handle the `None`; an
  `assert` is stripped under `python -O` and is not a guarantee. If a path
  genuinely cannot return `None` (you just committed the row), give it a
  loader that returns a non-optional type and raises on absence, rather than
  re-fetching and asserting.

- **A `DateTime(timezone=True)` column should yield an aware datetime — don't
  re-defend at every read.** If you find yourself writing
  `if dt.tzinfo is None: dt = dt.replace(tzinfo=utc)`, the boundary contract is
  wrong; fix it at the loader, not the call site.

- **Annotate internal seams too.** Helper functions that take SQLAlchemy
  constructs (`def participant_filter(query, current_user_id)`,
  `name_taken(db, id_col, name_col, ...)`) still get full annotations. `mypy
  --strict` should have nothing to infer.

## Error handling

- **Catch the specific exception, never a bare `except Exception`.** A blanket
  catch swallows the `KeyError` / `AttributeError` bugs you'd rather see crash
  loudly. Name what you expect (`IntegrityError`, `httpx.HTTPError`) and let the
  rest propagate to the handler / middleware layer.
- **Route handlers are `async def` by default.** The whole stack is async
  (async SQLAlchemy, async deps); a sync handler blocks the event loop. Drop to
  plain `def` only for genuinely CPU-bound work you've deliberately chosen to
  offload.

## Static checking is the enforcement

The rules above are only real if a checker runs them. All of `app/` passes
`mypy --strict` in CI today — keep it that way, with no `# type: ignore` unless
the suppression carries a comment explaining why. If you reach for `Any`,
`cast`, or `# type: ignore`, treat it as a smell to justify in review, not a
default.

## Module layout for new code

- **Separate the HTTP layer from domain/data logic.** A route handler should
  parse the request, call a service/query function, and shape the response —
  not contain raw SQLAlchemy queries, serializers, and domain rules inline.
  New domains get their query + domain logic in their own module rather than
  growing a 900-line router.
- **Don't import another router's internals.** Shared query/domain helpers
  (e.g. participant filters, win-count helpers) belong in a service/domain
  module that both routers import — routers should not depend on each other.
- **Reusable dependencies** (`get_session`, `get_current_user`,
  `require_permission`) and **configuration** (a single `pydantic-settings`
  `Settings`, instead of scattered `os.environ.get(...)`) belong in shared
  modules, not wherever they were first needed.

## Service layer and dependency injection

When a service has collaborators worth injecting, keep three layers distinct.

- **Handler** declares what it needs and knows nothing about construction:
  `service: MatchService = Depends(get_match_service)`. Never instantiate a
  service in the handler body — that loses `app.dependency_overrides` for tests
  and repeats the wiring in every handler.
- **Provider** (`<domain>/dependencies.py`) is the single place that knows the
  wiring. It takes collaborators as `Depends` and constructor-injects them;
  service-to-service deps are just more `Depends` args here, and FastAPI
  resolves the whole tree per request:

  ```python
  def get_match_service(
      db: AsyncSession = Depends(get_session),
      ratings: RatingCalculator = Depends(get_rating_calculator),
  ) -> MatchService:
      return MatchService(db, ratings)
  ```

- **Service** is a plain class with a plain `__init__` — no FastAPI imports, no
  `Depends` in the constructor. Type collaborators as `Protocol` (like the
  existing `RatingCalculator`), not concrete classes, so the seam is
  substitutable and the checker verifies the wiring.

Rules of thumb:

- **Stateless service → just a module-level function** taking `db` as a param
  (as `resolve_league` / `name_taken` already do). Reach for the
  class-plus-provider only when there's a collaborator worth injecting.
- **Never a module-level singleton** for anything holding the `AsyncSession`:
  the session is request-scoped, so the service must be too.
- **No two services may `Depends`/import each other.** A cycle means the shared
  logic wants to be a third module.

Because services are plain classes wired by a thin provider, they must be
constructible without FastAPI anywhere — REPL, `scripts/`, tests. Outside a
request you own the session lifecycle yourself (`get_session` only
yields/closes it inside one):

```python
async with sessionmaker() as db:
    service = MatchService(db, Glicko2Calculator())
    ...
```

Unit-test services by constructing them with fakes directly; use
`app.dependency_overrides[get_match_service]` for endpoint tests. If you can't
build a service in the console without FastAPI running, something leaked — a
`Depends` in the constructor, or a session-holding singleton.
