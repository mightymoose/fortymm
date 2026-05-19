# api/CLAUDE.md

Schema conventions for the FastAPI service. See the root `CLAUDE.md` for repo
layout, commands, and architecture.

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
