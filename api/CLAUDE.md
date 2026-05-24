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

## Datetimes are timezone-aware, always

- **Migrations:** every `sa.Column(..., sa.DateTime(...), ...)` must use
  `sa.DateTime(timezone=True)`. Bare `sa.DateTime()` is forbidden.
- **Models:** every `Mapped[datetime]` column must explicitly pass
  `DateTime(timezone=True)` to `mapped_column(...)`. Import `DateTime` from
  `sqlalchemy`. SQLAlchemy's default is naïve — do not rely on it.
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

## New `users.id` foreign keys must update the account-merge service

When you add a model (or column) with a foreign key to `users.id`, also update
the ephemeral→verified account-merge logic to handle the new FK — re-point it
to the surviving user, or rely on `ON DELETE CASCADE` and let the ephemeral
user's deletion clean it up. Grep for `merge_user` to find it.

Skipping this means a merged user silently leaves orphan rows, or a `RESTRICT`
FK blocks the final ephemeral-user delete and the whole merge transaction
fails.

## Pre-deploy: edit migrations in place

Until the first production deploy, fix schema mistakes by editing the
existing migration file rather than adding an "alter" migration. Obliterate
and re-run alembic against a fresh database to test.

- **Revision ids (`0001`, `0002`, ...) and `down_revision` chains stay
  frozen.** Filenames carry the revision id as a prefix — keep the prefix,
  only change the descriptive suffix when a migration is renamed.
- Renaming a table touches: the model's `__tablename__`, the migration's
  create/drop/FK/index/constraint names, the migration filename and
  docstring, and any hardcoded references in app or test code.

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
