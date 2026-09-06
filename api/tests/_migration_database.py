"""Install the real Alembic baseline in an isolated, disposable database."""

import os
import subprocess
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine


@asynccontextmanager
async def empty_database(postgres_url):
    database = "fortymm_migration_test_" + uuid.uuid4().hex
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    migration_url = make_url(postgres_url).set(database=database)
    migrated = create_async_engine(migration_url)
    async with admin.connect() as connection:
        await connection.execute(text(f'CREATE DATABASE "{database}"'))
    try:
        yield migrated
    finally:
        await migrated.dispose()
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE "{database}" WITH (FORCE)'))
        await admin.dispose()


@asynccontextmanager
async def migrated_database(postgres_url):
    async with empty_database(postgres_url) as migrated:
        run_alembic(migrated.url, "upgrade", "head")
        yield migrated


def run_alembic(url, command, revision):
    result = subprocess.run(
        [sys.executable, "-m", "alembic", command, revision],
        cwd=Path(__file__).parents[1],
        env={**os.environ, "DATABASE_URL": url.render_as_string(hide_password=False)},
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
