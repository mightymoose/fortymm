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
    """
    CREATE FUNCTION preserve_archived_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'UPDATE' AND NEW.tournament_id = OLD.tournament_id THEN
            RETURN NEW;
        END IF;
        PERFORM id FROM tournaments WHERE id=OLD.tournament_id FOR SHARE NOWAIT;
        IF EXISTS (SELECT 1 FROM tournament_archive_history
            WHERE tournament_id=OLD.tournament_id) THEN
            RAISE EXCEPTION 'archive history must preserve its events'
                USING ERRCODE='23514';
        END IF;
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'event removal requires archive parent lock; retry'
            USING ERRCODE='40001';
    END $$
    """,
    """
    CREATE TRIGGER preserve_archived_event BEFORE DELETE OR UPDATE OF tournament_id
    ON tournament_events FOR EACH ROW EXECUTE FUNCTION preserve_archived_event()
    """,
)


def install_archive_integrity(
    metadata: MetaData, connection: Connection, **kwargs: object
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in ARCHIVE_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_archive_integrity)
