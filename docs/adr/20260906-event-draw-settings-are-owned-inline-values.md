# Event draw settings are owned inline values

Date: 2026-09-06

## Status

Accepted for #1678. Supersedes the separate settings-row ownership and storage
choice in `20260726-an-events-draw-configuration-is-a-row-not-a-column.md`.

The JSON representation and validation split from
`20260805-a-draw-types-settings-are-one-not-null-json-object.md` remain accepted;
only the table and column location change. The surrogate draw-type ID decision
from `20260815-an-events-stages-are-rows-and-a-composite-draw-type-is-a-template.md`
also remains in force.

## Context

Draw settings have no independent lifecycle. They are neither reusable presets
nor retained configuration after an event is deleted. The old mandatory FK from
event to settings permitted multiple events to reference one mutable settings row.
SQLAlchemy's single_parent guard did not enforce exclusive ownership in PostgreSQL,
and database event deletion could leave settings orphaned.

## Decision

Store `draw_type_id` and `draw_settings` on `tournament_events`. The former is a
NOT NULL FK to `draw_types.id` with ON DELETE RESTRICT. The latter is NOT NULL
JSONB, defaults to `{}`, and checks `jsonb_typeof(draw_settings) = 'object'`.
There is no settings table, settings ID, separate timestamp, or cleanup operation.
SQL updates and copies affect only the event whose row is written; deleting an
event also removes its configuration, including tournament cascades.

Keep type-specific validation in the existing discriminated union. PostgreSQL
does not enforce rules such as Swiss requiring rounds or the qualifier floor.
Application writes encode a complete parsed arm and replace both columns together.
The existing `event.draw_settings` accessor exposes a detached storage value;
assignment copies its JSON so two event instances cannot share mutable settings.
Callers parse that value through `draw_settings_of` as before.

Requests, responses, optimistic concurrency, draw-edit restrictions, stages,
groups, and retained match history keep their existing behavior.

## Migration and verification

Rewrite the disposable pre-beta Alembic baseline, preserving its other constraints
and catalogue seeds. No legacy backfill or populated-database upgrade path is
needed before #1670 freezes the baseline. This change does not reset a development,
QA, UAT, or production database; tests use disposable PostgreSQL databases.

Verify SQL ownership, object and FK constraints, event/tournament deletion by SQL
and API, all supported settings arms, isolated edits, fresh schema parity, and
baseline downgrade/reinstall. Existing backend regressions verify draw restrictions
and supported API behavior.
