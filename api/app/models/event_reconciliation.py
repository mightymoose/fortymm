"""Retained assertions of event result reconciliation.

A receipt binds an event to its final snapshot in the current transaction.
It records the caller's explicit result projection assertion; SQL does not run
or duplicate the sporting strategy. Deferred enforcement covers voids and
completed fixture attachments.
"""

import uuid

from sqlalchemy import (
    BigInteger,
    Connection,
    ForeignKey,
    Integer,
    MetaData,
    String,
    event,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class EventReconciliation(Base):
    __tablename__ = "tournament_event_reconciliations"

    event_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tournament_events.id", ondelete="RESTRICT"), primary_key=True
    )
    lifecycle_state: Mapped[str] = mapped_column(String)
    lifecycle_version: Mapped[int] = mapped_column(Integer)
    transaction_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)


RECONCILIATION_DDL = (
    """
    CREATE FUNCTION preserve_event_reconciliation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND
            OLD.transaction_id = pg_current_xact_id()::text::bigint THEN
            RETURN OLD;
        END IF;
        IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND
            (OLD.transaction_id <> pg_current_xact_id()::text::bigint OR
             NEW.transaction_id <> OLD.transaction_id OR NEW.event_id <> OLD.event_id))
        THEN
            RAISE EXCEPTION 'event reconciliation receipts are retained'
                USING ERRCODE='23514';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM tournament_events e WHERE e.id=NEW.event_id
              AND e.lifecycle_state::text=NEW.lifecycle_state
              AND e.lifecycle_version=NEW.lifecycle_version
        ) THEN
            RAISE EXCEPTION 'event reconciliation must name the current event snapshot'
                USING ERRCODE='23514';
        END IF;
        NEW.transaction_id := pg_current_xact_id()::text::bigint;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_event_reconciliation
    BEFORE INSERT OR UPDATE OR DELETE ON tournament_event_reconciliations
    FOR EACH ROW EXECUTE FUNCTION preserve_event_reconciliation()
    """,
    """
    CREATE FUNCTION require_void_event_reconciliation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF EXISTS (
            SELECT 1 FROM tournament_fixtures f
            JOIN tournament_events e ON e.id=f.scope_event_id
            WHERE f.match_id=NEW.match_id AND NOT EXISTS (
                SELECT 1 FROM tournament_event_reconciliations r
                WHERE r.event_id=e.id
                  AND r.lifecycle_state=e.lifecycle_state::text
                  AND r.lifecycle_version=e.lifecycle_version
                  AND r.transaction_id=pg_current_xact_id()::text::bigint
            )
        ) THEN
            RAISE EXCEPTION 'administrator void requires event reconciliation'
                USING ERRCODE='23514';
        END IF;
        RETURN NULL;
    END $$
    """,
    """
    CREATE CONSTRAINT TRIGGER require_void_event_reconciliation
    AFTER INSERT ON match_void_actions DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION require_void_event_reconciliation()
    """,
    """
    CREATE FUNCTION invalidate_event_reconciliation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE affected_events uuid[] := '{}';
    BEGIN
        IF TG_TABLE_NAME = 'match_void_actions' THEN
            SELECT ARRAY[scope_event_id] INTO affected_events FROM tournament_fixtures
                WHERE match_id=NEW.match_id;
        ELSE
            IF TG_OP = 'UPDATE' AND NEW.match_id IS NOT DISTINCT FROM OLD.match_id
                AND NEW.scope_event_id=OLD.scope_event_id THEN
                RETURN NULL;
            END IF;
            IF TG_OP <> 'DELETE' AND EXISTS (SELECT 1 FROM matches
                WHERE id=NEW.match_id AND status='completed') THEN
                affected_events := array_append(affected_events, NEW.scope_event_id);
            END IF;
            IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM matches
                WHERE id=OLD.match_id AND status='completed') THEN
                affected_events := array_append(affected_events, OLD.scope_event_id);
            END IF;
        END IF;
        DELETE FROM tournament_event_reconciliations
            WHERE event_id=ANY(affected_events)
              AND transaction_id=pg_current_xact_id()::text::bigint;
        RETURN NULL;
    END $$
    """,
    """
    CREATE TRIGGER invalidate_void_event_reconciliation
    AFTER INSERT ON match_void_actions
    FOR EACH ROW EXECUTE FUNCTION invalidate_event_reconciliation()
    """,
    """
    CREATE TRIGGER invalidate_attachment_event_reconciliation
    AFTER INSERT OR UPDATE OF match_id, scope_event_id OR DELETE ON tournament_fixtures
    FOR EACH ROW EXECUTE FUNCTION invalidate_event_reconciliation()
    """,
    """
    CREATE FUNCTION require_attachment_event_reconciliation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE affected_events uuid[] := '{}';
    BEGIN
        IF TG_OP = 'UPDATE' AND NEW.match_id IS NOT DISTINCT FROM OLD.match_id
            AND NEW.scope_event_id=OLD.scope_event_id THEN
            RETURN NULL;
        END IF;
        IF TG_OP <> 'DELETE' AND EXISTS (SELECT 1 FROM matches
            WHERE id=NEW.match_id AND status='completed') THEN
            affected_events := array_append(affected_events, NEW.scope_event_id);
        END IF;
        IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM matches
            WHERE id=OLD.match_id AND status='completed') THEN
            affected_events := array_append(affected_events, OLD.scope_event_id);
        END IF;
        IF EXISTS (
            SELECT 1 FROM tournament_events e WHERE e.id=ANY(affected_events)
              AND NOT EXISTS (
                SELECT 1 FROM tournament_event_reconciliations r
                WHERE r.event_id=e.id
                  AND r.lifecycle_state=e.lifecycle_state::text
                  AND r.lifecycle_version=e.lifecycle_version
                  AND r.transaction_id=pg_current_xact_id()::text::bigint
            )
        ) THEN
            RAISE EXCEPTION 'completed attachment requires event reconciliation'
                USING ERRCODE='23514';
        END IF;
        RETURN NULL;
    END $$
    """,
    """
    CREATE CONSTRAINT TRIGGER require_attachment_event_reconciliation
    AFTER INSERT OR UPDATE OF match_id, scope_event_id OR DELETE ON tournament_fixtures
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION require_attachment_event_reconciliation()
    """,
)


def install_event_reconciliation(
    metadata: MetaData, connection: Connection, **kwargs: object
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in RECONCILIATION_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_event_reconciliation)
