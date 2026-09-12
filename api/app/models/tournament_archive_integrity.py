"""Archive history DDL; Alembic carries a frozen copy for fresh installations."""

from sqlalchemy import MetaData, event
from sqlalchemy.engine import Connection

from app.db import Base

ARCHIVE_DDL = (
    """
    CREATE FUNCTION record_tournament_archive() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'UPDATE' AND OLD.status = 'archived' AND
            (NEW.status, NEW.archive_observed_at, NEW.archived_at) IS DISTINCT FROM
            (OLD.status, OLD.archive_observed_at, OLD.archived_at) THEN
            RAISE EXCEPTION 'archive history must be preserved' USING ERRCODE='23514';
        END IF;
        IF NEW.status = 'archived' AND
            (TG_OP = 'INSERT' OR OLD.status <> 'archived') THEN
            NEW.archive_observed_at := clock_timestamp();
            IF TG_OP = 'UPDATE' AND NEW.archived_at IS NULL THEN
                NEW.archived_at := NEW.archive_observed_at;
            END IF;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER record_tournament_archive BEFORE INSERT OR UPDATE ON tournaments
    FOR EACH ROW EXECUTE FUNCTION record_tournament_archive()
    """,
    """
    CREATE FUNCTION append_tournament_archive() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF NEW.status = 'archived' AND
            (TG_OP = 'INSERT' OR OLD.status <> 'archived') THEN
            INSERT INTO tournament_archive_history(
                tournament_id, observed_at, occurred_at)
            VALUES (NEW.id, NEW.archive_observed_at, NEW.archived_at);
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER append_tournament_archive AFTER INSERT OR UPDATE ON tournaments
    FOR EACH ROW EXECUTE FUNCTION append_tournament_archive()
    """,
    """
    CREATE FUNCTION preserve_tournament_archive() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP <> 'INSERT' OR pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION 'archive history is immutable and database owned'
                USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_tournament_archive BEFORE INSERT OR UPDATE OR DELETE ON
        tournament_archive_history
    FOR EACH ROW EXECUTE FUNCTION preserve_tournament_archive()
    """,
)


def install_archive_integrity(
    metadata: MetaData, connection: Connection, **kwargs: object
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in ARCHIVE_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_archive_integrity)
