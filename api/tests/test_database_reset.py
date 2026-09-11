"""Cleanup clears committed history without weakening subsequent tests."""

import pytest
from sqlalchemy import Column, ForeignKey, Integer, MetaData, Table, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from tests._database_reset import reset_database
from tests._migration_database import empty_database


@pytest.fixture
async def reset_schema(postgres_server_url):
    async with empty_database(postgres_server_url) as database:
        # One pooled connection makes the setting-restoration assertion exercise
        # the very connection used by cleanup, including its failure path.
        engine = create_async_engine(database.url, pool_size=1, max_overflow=0)
        metadata = MetaData()
        parent = Table(
            "reset parent", metadata, Column("id", Integer, primary_key=True)
        )
        history = Table(
            "reset history",
            metadata,
            Column("id", Integer, primary_key=True),
            Column("parent_id", ForeignKey(parent.c.id)),
        )
        async with engine.begin() as connection:
            await connection.run_sync(metadata.create_all)
            await connection.execute(text("CREATE TABLE unrelated (id integer)"))
            await connection.execute(text("INSERT INTO unrelated VALUES (1)"))
            await connection.execute(
                text("""
                CREATE FUNCTION retain_history() RETURNS trigger AS $$
                BEGIN
                    RAISE EXCEPTION 'history is immutable';
                END;
                $$ LANGUAGE plpgsql
            """)
            )
            await connection.execute(
                text("""
                CREATE TRIGGER retain_history BEFORE DELETE ON "reset history"
                FOR EACH ROW EXECUTE FUNCTION retain_history()
            """)
            )
            await connection.execute(parent.insert().values(id=1))
            await connection.execute(history.insert().values(id=1, parent_id=1))
        try:
            yield engine, metadata, parent, history
        finally:
            await engine.dispose()


async def test_reset_preserves_storage_and_restores_integrity(reset_schema):
    engine, metadata, parent, history = reset_schema
    storage = text("""
        SELECT oid, relfilenode FROM pg_class
        WHERE relname IN ('reset parent', 'reset history') ORDER BY oid
    """)
    async with engine.connect() as connection:
        before = (await connection.execute(storage)).all()

    await reset_database(engine, metadata.sorted_tables)

    async with engine.begin() as connection:
        assert (await connection.execute(storage)).all() == before
        assert not (await connection.execute(parent.select())).all()
        assert not (await connection.execute(history.select())).all()
        assert await connection.scalar(text("SELECT count(*) FROM unrelated")) == 1
        assert (
            await connection.scalar(text("SHOW session_replication_role")) == "origin"
        )
        await connection.execute(parent.insert().values(id=2))
        await connection.execute(history.insert().values(id=2, parent_id=2))

    with pytest.raises(DBAPIError, match="history is immutable"):
        async with engine.begin() as connection:
            await connection.execute(history.delete())
    with pytest.raises(IntegrityError):
        async with engine.begin() as connection:
            await connection.execute(history.insert().values(id=3, parent_id=999))


async def test_failed_reset_rolls_back_and_restores_integrity(reset_schema):
    engine, metadata, parent, history = reset_schema
    missing = Table("missing", MetaData(), Column("id", Integer))
    with pytest.raises(DBAPIError):
        # Reverse deletion visits the existing tables before the missing table.
        await reset_database(engine, [missing, *metadata.sorted_tables])

    async with engine.connect() as connection:
        assert (
            await connection.scalar(text("SHOW session_replication_role")) == "origin"
        )
        assert (await connection.execute(parent.select())).all() == [(1,)]
        assert (await connection.execute(history.select())).all() == [(1, 1)]
    with pytest.raises(DBAPIError, match="history is immutable"):
        async with engine.begin() as connection:
            await connection.execute(history.delete())
