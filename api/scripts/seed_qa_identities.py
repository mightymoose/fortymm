"""Seed QA-only sign-in-able identities with a fixed, converging role set.

QA seeds RBAC roles (`seed_rbac.py`) but grants them to nobody, so every
gated feature is untestable on a fresh QA stack. This script mints three
identities and holds each one to an exact opt-in role set, re-converging on
every run so a QA pass that drifts a role grant (adds or removes one by hand
through the admin UI) gets undone on the next boot.

**QA-only, hard-gated.** Refuses to run unless `QA_SEED_IDENTITIES=1` is set
in the environment — never UAT, never production. Chained only from
`docker-compose.qa.yml`, which is the only place that sets the env var.

Idempotent and self-healing: re-runs create no duplicate users or role rows,
and a hand-edited role grant converges back to the roster below on the next
run. Mirrors `seed_rbac.py`'s shape — a pure `upsert_...` the caller commits,
plus a thin `seed()` wrapper with the env guard.
"""

import asyncio
import os
import sys
from datetime import UTC, datetime
from typing import NamedTuple

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db import get_engine
from app.leagues import add_user_to_default_league, get_default_league
from app.models import LeagueMembership, Role, User, UserRole
from app.roles import get_default_role, grant_default_role
from app.usernames import generate_username

QA_SEED_ENV_VAR = "QA_SEED_IDENTITIES"

# (email, opt-in role names). Every identity also holds the default `User`
# role, granted to every user platform-wide (ADR-0016) — not listed here,
# same convention `seed_rbac.ROLES` uses for its opt-in bundles.
IDENTITIES: list[tuple[str, list[str]]] = [
    ("qa-admin@example.com", ["Administrator"]),
    ("qa-director@example.com", ["Beta tester"]),
    ("qa-player@example.com", []),
]


class SeedCounts(NamedTuple):
    """How many rows a seed run actually changed. All zero on an unchanged
    re-run."""

    users_created: int
    roles_granted: int
    roles_revoked: int
    identities_skipped_tombstoned: int


def _require_qa_env() -> None:
    """Refuse to run unless `QA_SEED_IDENTITIES=1` is set.

    Split out from `seed()` so it's unit-testable without opening a DB
    connection. Fails loudly (stderr + `SystemExit(1)`) rather than silently
    no-oping — this script must never run against UAT or production, and a
    silent no-op on a missing env var would be indistinguishable from "ran and
    seeded nothing to do."
    """
    if os.environ.get(QA_SEED_ENV_VAR) != "1":
        print(
            f"Refusing to run: {QA_SEED_ENV_VAR}=1 is not set. "
            "This script is QA-only and must never run against UAT or "
            "production — see docker-compose.qa.yml.",
            file=sys.stderr,
        )
        raise SystemExit(1)


async def upsert_qa_identities(db: AsyncSession) -> SeedCounts:
    """Create/update the QA roster in `IDENTITIES`, converging each
    identity's opt-in roles to exactly the target set.

    Idempotent: an unchanged re-run creates no users and grants/revokes no
    roles. Self-healing: a hand-drifted role grant (added or removed since
    the last run) is corrected back to the roster on the next run, since the
    opt-in role set is computed as a diff against the target rather than
    merely inserted additively.

    A tombstoned identity (`merged_into_user_id is not None`, found by the
    by-email lookup since a merge does not null out `email`) is skipped
    entirely — mirrors the exclusion `app.roles.converge_default_role`
    applies, so a merged-away QA identity is never silently revived.

    Caller commits. Raises `RuntimeError` if the default role or default
    league is missing — a broken deployment should surface loudly, not
    soft-skip.
    """
    role_names = {name for _, names in IDENTITIES for name in names}
    roles_by_name: dict[str, Role] = {
        role.name: role
        for role in (await db.execute(select(Role).where(Role.name.in_(role_names))))
        .scalars()
        .all()
    }
    missing = role_names - roles_by_name.keys()
    if missing:
        raise RuntimeError(
            f"Missing seeded role(s) {sorted(missing)}. Run scripts/seed_rbac.py."
        )

    default_role = await get_default_role(db)
    if default_role is None:
        raise RuntimeError("No default User role to grant. Run scripts/seed_rbac.py.")

    default_league = await get_default_league(db)
    if default_league is None:
        raise RuntimeError("No default league configured. Run scripts/seed_leagues.py.")

    users_created = 0
    roles_granted = 0
    roles_revoked = 0
    identities_skipped_tombstoned = 0

    for email, opt_in_role_names in IDENTITIES:
        user = (
            await db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()

        if user is not None and user.merged_into_user_id is not None:
            identities_skipped_tombstoned += 1
            continue

        if user is None:
            user = User(username=await generate_username(db))
            db.add(user)
            await db.flush()
            # Email is only ever set alongside confirmed_at — mirrors every
            # other email-setting call site (see request_login_email's
            # docstring in app/sessions.py).
            user.email = email
            user.confirmed_at = datetime.now(UTC)
            users_created += 1

        existing_membership = (
            await db.execute(
                select(LeagueMembership).where(
                    LeagueMembership.league_id == default_league.id,
                    LeagueMembership.user_id == user.id,
                )
            )
        ).scalar_one_or_none()
        if existing_membership is None:
            await add_user_to_default_league(db, user.id)

        existing_default_grant = (
            await db.execute(
                select(UserRole).where(
                    UserRole.user_id == user.id,
                    UserRole.role_id == default_role.id,
                )
            )
        ).scalar_one_or_none()
        if existing_default_grant is None:
            await grant_default_role(db, user.id)

        target_role_ids = {roles_by_name[name].id for name in opt_in_role_names}
        existing_non_default_roles = (
            (
                await db.execute(
                    select(UserRole).where(
                        UserRole.user_id == user.id,
                        UserRole.role_id != default_role.id,
                    )
                )
            )
            .scalars()
            .all()
        )
        existing_role_ids = {ur.role_id for ur in existing_non_default_roles}

        stale_role_ids = existing_role_ids - target_role_ids
        if stale_role_ids:
            await db.execute(
                delete(UserRole).where(
                    UserRole.user_id == user.id,
                    UserRole.role_id.in_(stale_role_ids),
                )
            )
            roles_revoked += len(stale_role_ids)

        missing_role_ids = target_role_ids - existing_role_ids
        for role_id in missing_role_ids:
            db.add(UserRole(user_id=user.id, role_id=role_id))
            roles_granted += 1

    return SeedCounts(
        users_created=users_created,
        roles_granted=roles_granted,
        roles_revoked=roles_revoked,
        identities_skipped_tombstoned=identities_skipped_tombstoned,
    )


async def seed() -> None:
    _require_qa_env()
    engine = get_engine()
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as db:
        counts = await upsert_qa_identities(db)
        await db.commit()
        print(
            f"QA identity seed complete: +{counts.users_created} users, "
            f"+{counts.roles_granted} role grants, "
            f"-{counts.roles_revoked} role revokes, "
            f"{counts.identities_skipped_tombstoned} tombstoned identities skipped."
        )


if __name__ == "__main__":
    asyncio.run(seed())
