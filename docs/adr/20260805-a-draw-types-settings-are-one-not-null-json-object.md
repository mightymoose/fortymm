# A draw type's settings are one NOT NULL JSON object

Date: 2026-08-05

## Status

Accepted

## Context

`tournament_event_draw_settings` joins an event to its draw type. It carries the
draw type key and one settings column, `qualifiers_per_pool`. That column is the
**K** of "the top K from each pool advance". Only `rr-then-ko` uses it.

A `CASE` check constraint keeps the column and the draw type in step. The column
is NOT NULL and at least 1 when the row names `rr-then-ko`. It is NULL for every
other draw type.

That shape does not scale. Swiss needs a round count. A future double-elimination
draw may need a grand-final reset flag. Each new setting under the current shape
costs a new nullable column, a new arm in the `CASE` constraint, and a migration.
The constraint grows one branch per draw type per setting. Every draw type also
pays for every other draw type's columns by carrying a NULL.

The wider problem is that the table describes a **union**. Which settings exist
depends entirely on the draw type. Modelling a union as a wide row of nullable
columns is what forces the check constraint to exist at all.

## Decision

### One `settings` JSON column, NOT NULL, defaulting to an empty object

`tournament_event_draw_settings` carries a single `settings` JSONB column. It is
NOT NULL with a server default of `{}`.

A draw type that takes no configuration stores `{}`. It does not store NULL.
`round-robin` and `single-elim` store `{}` today. `rr-then-ko` stores
`{"qualifiers_per_pool": 2}`. Swiss stores `{"rounds": 5}`.

An empty object and a NULL would mean the same thing to a reader, so only one of
them may be representable. The empty object wins because it is the shape every
reader already expects. Nothing has to test for absence before it reads.

`qualifiers_per_pool` is dropped as a column. fortymm is pre-deploy, so migration
`0010` is edited in place rather than chained with an `ALTER`.

### The column is the serialized form of a union that already exists

`app.schemas.tournament` already holds `DrawSettingsWriteArm`, a Pydantic
discriminated union over `draw_type`. This column stores exactly that arm.

The blob is decoded into that union **at read time**, at the boundary. Nothing
below the boundary holds a `dict[str, Any]`. This is the rule `api/CLAUDE.md`
states for JSONB columns, and the union it asks for is already written.

### The wire shape does not change

Settings stay **flat beside `draw_type`** on the request and response schemas,
which is where `qualifiers_per_pool` already sits. Only storage changes.

Keeping the wire flat means the event editor and both generated clients are
untouched by the storage move. It also preserves the whole point of the change:
a new draw type's settings need no migration.

## Consequences

Adding a draw type's settings is now a Pydantic arm and nothing else. No column,
no constraint branch, no migration.

**The database stops enforcing which settings belong to which draw type.** The
`CASE` constraint went away with the column it guarded. A weaker check remains,
that `settings` is a JSON object. The real enforcement moves to the discriminated
union, which refuses a qualifier count on a round-robin event with a 422 at the
request boundary.

This is a genuine loss and it is accepted deliberately. The constraint protected
against a writer that bypasses the schema. There is one writer, it parses through
the union, and a test pins that a mismatched pair is refused.

Reading a settings value now costs a parse rather than a column read. The parse is
the point. It is what keeps the untyped blob from leaking inward.
