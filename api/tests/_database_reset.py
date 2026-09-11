"""Reset only the named tables in a disposable test database."""

from collections.abc import Sequence

from sqlalchemy import Table, text
from sqlalchemy.ext.asyncio import AsyncEngine


async def reset_database(engine: AsyncEngine, tables: Sequence[Table]) -> None:
    """Delete committed test data without rewriting every table and index.

    Retained history forbids ordinary DELETE. Bypass those triggers only on
    this cleanup connection and only for this transaction: SET LOCAL restores
    foreign keys and retention triggers on both commit and rollback, before
    the pooled connection can be used by another test. Other connections keep
    enforcing the real migrated schema throughout.
    """
    async with engine.begin() as connection:
        await connection.execute(text("SET LOCAL session_replication_role = replica"))
        for table in reversed(tables):
            await connection.execute(table.delete())
