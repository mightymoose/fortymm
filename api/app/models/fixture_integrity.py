"""Fixture ownership enforcement for all database writers.

Keep the baseline's frozen DDL copy in sync when changing the pre-beta schema.
"""

from typing import Any

from sqlalchemy import MetaData, event
from sqlalchemy.engine import Connection

from app.db import Base

FIXTURE_INTEGRITY_DDL = (
    """
    CREATE OR REPLACE FUNCTION fixture_scope() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE event_uuid uuid; tournament_uuid uuid;
    BEGIN
        SELECT event_id INTO event_uuid FROM tournament_event_stages
        WHERE id = NEW.stage_id;
        IF NEW.scope_event_id IS NULL OR (TG_OP = 'UPDATE'
            AND NEW.stage_id IS DISTINCT FROM OLD.stage_id
            AND NEW.scope_event_id IS NOT DISTINCT FROM OLD.scope_event_id) THEN
            NEW.scope_event_id := event_uuid;
        END IF;
        SELECT tournament_id INTO tournament_uuid FROM tournament_events
        WHERE id = NEW.scope_event_id;
        IF NEW.scope_tournament_id IS NULL OR (TG_OP = 'UPDATE'
            AND NEW.scope_event_id IS DISTINCT FROM OLD.scope_event_id
            AND NEW.scope_tournament_id IS NOT DISTINCT FROM OLD.scope_tournament_id)
        THEN
            NEW.scope_tournament_id := tournament_uuid;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER fixture_scope BEFORE INSERT OR UPDATE ON tournament_fixtures
    FOR EACH ROW EXECUTE FUNCTION fixture_scope()
    """,
)


def install_fixture_integrity(
    metadata: MetaData, connection: Connection, **kwargs: Any
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in FIXTURE_INTEGRITY_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_fixture_integrity)
