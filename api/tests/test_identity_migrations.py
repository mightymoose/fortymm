"""A fresh Alembic install must match the ORM, without legacy backfills."""

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.account_merge import merge_user
from app.db import Base
from app.models import Account, LoginIdentity, Player
from app.player_accounts import primary_player_id, require_player
from tests._migration_database import migrated_database, run_alembic


async def test_fresh_alembic_install_has_schema_parity(postgres_url):
    async with migrated_database(postgres_url) as migrated:
        async with migrated.connect() as connection:
            differences = await connection.run_sync(
                lambda conn: compare_metadata(
                    MigrationContext.configure(conn), Base.metadata
                )
            )
            assert differences == []
            assert (
                await connection.scalar(text("SELECT count(*) FROM rating_strategies"))
                > 0
            )
            assert (
                await connection.scalar(text("SELECT count(*) FROM notification_types"))
                > 0
            )
            assert await connection.scalar(text("SELECT count(*) FROM draw_types")) > 0
        async with async_sessionmaker(migrated, expire_on_commit=False)() as session:
            guest = Account(username="migrated-guest")
            normal = Account(username="migrated-normal", email="normal@example.com")
            destination = Account(email="destination@example.com")
            unclaimed = Player(username="migrated-unclaimed")
            normal.login_identities.append(
                LoginIdentity(issuer="test", provider="auth0", subject="normal")
            )
            session.add_all([guest, normal, destination, unclaimed])
            await session.commit()
            sporting_id = guest.player_id
            assert (
                await require_player(session, guest.id, sporting_id)
            ).id == sporting_id
            await merge_user(session, from_user_id=guest.id, to_user_id=destination.id)
            await session.commit()
            assert await primary_player_id(session, guest.id) is None
            assert await primary_player_id(session, destination.id) == sporting_id
            assert unclaimed.username == "migrated-unclaimed"
            with pytest.raises(IntegrityError):
                async with session.begin_nested():
                    await session.execute(
                        text("UPDATE accounts SET merged_at = NULL WHERE id = :id"),
                        {"id": guest.id},
                    )


async def test_disposable_baseline_can_be_downgraded_and_reinstalled(postgres_url):
    async with migrated_database(postgres_url) as migrated:
        run_alembic(migrated.url, "downgrade", "base")
        async with migrated.connect() as connection:
            for function in ("check_match_lineup()", "fixture_scope()"):
                assert (
                    await connection.scalar(
                        text("SELECT to_regprocedure(:function)"),
                        {"function": function},
                    )
                    is None
                )
        run_alembic(migrated.url, "upgrade", "head")
        async with migrated.connect() as connection:
            assert (
                await connection.scalar(text("SELECT version_num FROM alembic_version"))
                == "0001"
            )
