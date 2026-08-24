"""QA-only seed script: three sign-in-able identities converging to an exact
role set on every run.

`default_league` and `default_role` are autouse fixtures (see
`tests/conftest.py`), so the default league and the default `User` role exist
for every test here. `Administrator` / `Beta tester` still need `seed_rbac`.
"""

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import League, LeagueMembership, Role, User, UserRole
from scripts import seed_qa_identities, seed_rbac


async def _role_names_for(db: AsyncSession, user_id: uuid.UUID) -> set[str]:
    names = (
        (
            await db.execute(
                select(Role.name)
                .join(UserRole, UserRole.role_id == Role.id)
                .where(UserRole.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )
    return set(names)


async def _seed_rbac_prereqs(db: AsyncSession) -> None:
    """Everything `upsert_qa_identities` depends on existing already: the
    opt-in roles it grants. The default role/league come from autouse
    fixtures."""
    await seed_rbac.upsert_rbac(db)
    await db.commit()


async def test_seed_creates_the_exact_roster_role_sets(
    db_session: AsyncSession, default_league: League
):
    await _seed_rbac_prereqs(db_session)

    await seed_qa_identities.upsert_qa_identities(db_session)
    await db_session.commit()

    for email, expected_roles in [
        ("qa-admin@example.com", {"Administrator", "User"}),
        ("qa-director@example.com", {"Beta tester", "User"}),
        ("qa-player@example.com", {"User"}),
    ]:
        user = (
            await db_session.execute(select(User).where(User.email == email))
        ).scalar_one()
        assert await _role_names_for(db_session, user.id) == expected_roles
        assert user.confirmed_at is not None
        assert user.username

        membership = (
            await db_session.execute(
                select(LeagueMembership).where(
                    LeagueMembership.league_id == default_league.id,
                    LeagueMembership.user_id == user.id,
                )
            )
        ).scalar_one_or_none()
        assert membership is not None


async def test_seed_is_idempotent(db_session: AsyncSession):
    await _seed_rbac_prereqs(db_session)

    first = await seed_qa_identities.upsert_qa_identities(db_session)
    await db_session.commit()
    assert first.users_created == 3

    second = await seed_qa_identities.upsert_qa_identities(db_session)
    await db_session.commit()
    assert second == seed_qa_identities.SeedCounts(
        users_created=0,
        roles_granted=0,
        roles_revoked=0,
        identities_skipped_tombstoned=0,
    )

    users = (
        (
            await db_session.execute(
                select(User).where(
                    User.email.in_(
                        [email for email, _ in seed_qa_identities.IDENTITIES]
                    )
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(users) == 3

    admin = (
        await db_session.execute(
            select(User).where(User.email == "qa-admin@example.com")
        )
    ).scalar_one()
    admin_role_rows = (
        (await db_session.execute(select(UserRole).where(UserRole.user_id == admin.id)))
        .scalars()
        .all()
    )
    assert len(admin_role_rows) == 2  # Administrator + User, no duplicates


async def test_seed_converges_a_drifted_role_grant_back_to_the_roster(
    db_session: AsyncSession,
):
    await _seed_rbac_prereqs(db_session)
    await seed_qa_identities.upsert_qa_identities(db_session)
    await db_session.commit()

    admin = (
        await db_session.execute(
            select(User).where(User.email == "qa-admin@example.com")
        )
    ).scalar_one()

    # Simulate a QA pass drifting the grant: hand-add Beta tester on top of
    # Administrator.
    beta_tester = (
        await db_session.execute(select(Role).where(Role.name == "Beta tester"))
    ).scalar_one()
    db_session.add(UserRole(user_id=admin.id, role_id=beta_tester.id))
    await db_session.commit()
    assert await _role_names_for(db_session, admin.id) == {
        "Administrator",
        "Beta tester",
        "User",
    }

    await seed_qa_identities.upsert_qa_identities(db_session)
    await db_session.commit()

    assert await _role_names_for(db_session, admin.id) == {"Administrator", "User"}


async def test_seed_excludes_a_tombstoned_identity(db_session: AsyncSession):
    await _seed_rbac_prereqs(db_session)
    await seed_qa_identities.upsert_qa_identities(db_session)
    await db_session.commit()

    admin = (
        await db_session.execute(
            select(User).where(User.email == "qa-admin@example.com")
        )
    ).scalar_one()
    other_user = (
        await db_session.execute(
            select(User).where(User.email == "qa-director@example.com")
        )
    ).scalar_one()

    # Tombstone qa-admin the way account_merge.merge_user would, without
    # calling the real merge function.
    admin.merged_into_user_id = other_user.id
    await db_session.commit()

    counts = await seed_qa_identities.upsert_qa_identities(db_session)
    await db_session.commit()

    assert counts.identities_skipped_tombstoned == 1

    admins = (
        (
            await db_session.execute(
                select(User).where(User.email == "qa-admin@example.com")
            )
        )
        .scalars()
        .all()
    )
    assert len(admins) == 1  # no new row was created for the tombstoned email

    # The tombstoned row's roles/membership are untouched.
    assert await _role_names_for(db_session, admin.id) == {"Administrator", "User"}


def test_require_qa_env_refuses_without_the_env_var(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv(seed_qa_identities.QA_SEED_ENV_VAR, raising=False)
    with pytest.raises(SystemExit) as exc_info:
        seed_qa_identities._require_qa_env()
    assert exc_info.value.code == 1


def test_require_qa_env_allows_with_the_env_var_set(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(seed_qa_identities.QA_SEED_ENV_VAR, "1")
    seed_qa_identities._require_qa_env()  # does not raise
