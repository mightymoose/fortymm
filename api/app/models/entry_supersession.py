"""Preserve the reconciliation link on a durable event entry."""

from typing import Any

from sqlalchemy import Connection, MetaData, event

from app.db import Base

ENTRY_SUPERSESSION_DDL = (
    """
    CREATE OR REPLACE FUNCTION preserve_entry_supersession() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'UPDATE' AND OLD.superseded_by_entry_id IS NOT NULL AND
           NEW.superseded_by_entry_id IS DISTINCT FROM OLD.superseded_by_entry_id THEN
            RAISE EXCEPTION 'Entry supersession is permanent'
                USING ERRCODE = '23514', CONSTRAINT = 'ck_entry_supersession_permanent';
        END IF;
        IF NEW.superseded_by_entry_id IS NOT NULL THEN
            -- Entry writers take their event lock before the child row. A direct
            -- writer that encounters contention retries in that parent-first order.
            BEGIN
                PERFORM id FROM tournament_events WHERE id = NEW.event_id
                    FOR UPDATE NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION 'Retry entry supersession with the event locked'
                    USING ERRCODE = '40001';
            END;
            IF EXISTS (
                WITH RECURSIVE chain(id, next_id) AS (
                    SELECT id, superseded_by_entry_id FROM tournament_entries
                    WHERE id = NEW.superseded_by_entry_id
                    UNION
                    SELECT e.id, e.superseded_by_entry_id FROM tournament_entries e
                    JOIN chain c ON e.id = c.next_id
                ) SELECT 1 FROM chain WHERE id = NEW.id OR next_id = NEW.id
            ) THEN
                RAISE EXCEPTION 'Entry supersession cannot form a cycle'
                    USING ERRCODE = '23514', CONSTRAINT = 'ck_entry_supersession_cycle';
            END IF;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_entry_supersession
    BEFORE INSERT OR UPDATE OF superseded_by_entry_id ON tournament_entries
    FOR EACH ROW EXECUTE FUNCTION preserve_entry_supersession()
    """,
)


def install_entry_supersession(
    metadata: MetaData, connection: Connection, **kwargs: Any
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in ENTRY_SUPERSESSION_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_entry_supersession)
