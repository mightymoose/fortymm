"""Runs the migrations, one API instance at a time."""

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import Connection, MetaData, text

from fortymm_api.database import create_database_engine
from fortymm_api.models import Base

# Any constant works, as long as every instance takes the same one.
MIGRATION_LOCK_KEY = 4040

config = context.config
# Only the CLI sets up logging, so the API keeps uvicorn's.
if config.cmd_opts is not None and config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata: MetaData = config.attributes.get("target_metadata", Base.metadata)


def run_migrations(connection: Connection) -> None:
    # Another instance that's migrating holds the lock, so this waits for it,
    # then finds nothing left to apply.
    connection.execute(
        text("SELECT pg_advisory_lock(:key)"), {"key": MIGRATION_LOCK_KEY}
    )
    # The SELECT began a transaction, which would make Alembic's a no-op that
    # never commits. The lock is the session's, so it outlives the commit.
    connection.commit()
    try:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
    finally:
        connection.execute(
            text("SELECT pg_advisory_unlock(:key)"), {"key": MIGRATION_LOCK_KEY}
        )
        connection.commit()


if context.is_offline_mode():
    raise SystemExit("The migrations run against a database: --sql isn't supported")

given: Connection | None = config.attributes.get("connection")
if given is not None:
    run_migrations(given)
else:
    engine = create_database_engine(os.environ["DATABASE_URL"])
    try:
        with engine.connect() as connection:
            run_migrations(connection)
    finally:
        engine.dispose()
