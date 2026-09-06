"""A fresh Alembic install must match the ORM, without legacy backfills."""

import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.account_merge import merge_user
from app.db import Base
from app.models import Account, LoginIdentity, Player
from app.player_accounts import primary_player_id, require_player


async def test_fresh_alembic_install_has_schema_parity(postgres_url):
    database = "fortymm_migration_test_" + uuid.uuid4().hex
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    migration_url = make_url(postgres_url).set(database=database)
    migrated = create_async_engine(migration_url)
    async with admin.connect() as connection:
        await connection.execute(text(f'CREATE DATABASE "{database}"'))
    try:
        result = subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=Path(__file__).parents[1],
            env={
                **os.environ,
                "DATABASE_URL": migration_url.render_as_string(hide_password=False),
            },
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode == 0, result.stderr
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
    finally:
        await migrated.dispose()
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE "{database}" WITH (FORCE)'))
        await admin.dispose()
