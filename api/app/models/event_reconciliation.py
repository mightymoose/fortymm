"""Retained assertions of event result reconciliation.

A receipt binds an event to its final snapshot in the current transaction.
It records the caller's explicit result projection assertion; SQL does not run
or duplicate the sporting strategy. Deferred enforcement covers voids and
terminal match status and fixture changes.
"""

import uuid

from sqlalchemy import (
    BigInteger,
    Boolean,
    Connection,
    ForeignKey,
    Integer,
    MetaData,
    String,
    event,
    text,
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
    reconciled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )


RECONCILIATION_DDL = (
    """
    CREATE FUNCTION preserve_event_reconciliation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
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
    CREATE FUNCTION invalidate_event_reconciliation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE affected_events uuid[] := '{}';
    BEGIN
        IF TG_TABLE_NAME = 'match_void_actions' THEN
            SELECT ARRAY[scope_event_id] INTO affected_events FROM tournament_fixtures
                WHERE match_id=NEW.match_id;
        ELSIF TG_TABLE_NAME = 'matches' THEN
            IF NEW.status IS NOT DISTINCT FROM OLD.status OR
                (NEW.status NOT IN ('completed','voided') AND
                 OLD.status NOT IN ('completed','voided')) THEN
                RETURN NULL;
            END IF;
            SELECT ARRAY[scope_event_id] INTO affected_events FROM tournament_fixtures
                WHERE match_id=NEW.id;
        ELSIF TG_TABLE_NAME = 'tournament_entries' THEN
            IF TG_OP = 'UPDATE' AND ROW(NEW.status, NEW.event_id)
                IS NOT DISTINCT FROM ROW(OLD.status, OLD.event_id) THEN
                RETURN NULL;
            END IF;
            IF TG_OP <> 'DELETE' AND NEW.status='entered' THEN
                affected_events := array_append(affected_events, NEW.event_id);
            END IF;
            IF TG_OP <> 'INSERT' AND OLD.status='entered' THEN
                affected_events := array_append(affected_events, OLD.event_id);
            END IF;
            SELECT array_agg(e.id) INTO affected_events FROM tournament_events e
            WHERE e.id=ANY(affected_events) AND (
                e.lifecycle_version>0 OR EXISTS (
                    SELECT 1 FROM tournament_fixtures f
                    JOIN matches m ON m.id=f.match_id
                    WHERE f.scope_event_id=e.id AND m.status IN ('completed','voided')
                )
            );
        ELSE
            IF TG_OP = 'UPDATE' AND
                ROW(NEW.match_id, NEW.scope_event_id, NEW.retired_at,
                    NEW.entry_a_id, NEW.entry_b_id, NEW.stage_id,
                    NEW.group_id, NEW.round)
                IS NOT DISTINCT FROM
                ROW(OLD.match_id, OLD.scope_event_id, OLD.retired_at,
                    OLD.entry_a_id, OLD.entry_b_id, OLD.stage_id,
                    OLD.group_id, OLD.round)
            THEN
                RETURN NULL;
            END IF;
            IF TG_OP <> 'DELETE' AND EXISTS (SELECT 1 FROM matches
                WHERE id=NEW.match_id AND status IN ('completed','voided')) THEN
                affected_events := array_append(affected_events, NEW.scope_event_id);
            END IF;
            IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM matches
                WHERE id=OLD.match_id AND status IN ('completed','voided')) THEN
                affected_events := array_append(affected_events, OLD.scope_event_id);
            END IF;
        END IF;
        IF COALESCE(cardinality(affected_events), 0) = 0 THEN
            RETURN NULL;
        END IF;
        INSERT INTO tournament_event_reconciliations
            (event_id, transaction_id, lifecycle_state, lifecycle_version, reconciled)
        SELECT id, pg_current_xact_id()::text::bigint,
            lifecycle_state::text, lifecycle_version, false
        FROM tournament_events WHERE id=ANY(affected_events)
        ON CONFLICT (event_id, transaction_id) DO UPDATE SET
            lifecycle_state=EXCLUDED.lifecycle_state,
            lifecycle_version=EXCLUDED.lifecycle_version,
            reconciled=false;
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
    AFTER INSERT OR UPDATE OF match_id, scope_event_id, retired_at,
        entry_a_id, entry_b_id, stage_id, group_id, round OR DELETE
    ON tournament_fixtures
    FOR EACH ROW EXECUTE FUNCTION invalidate_event_reconciliation()
    """,
    """
    CREATE TRIGGER invalidate_entry_event_reconciliation
    AFTER INSERT OR UPDATE OF status, event_id OR DELETE ON tournament_entries
    FOR EACH ROW EXECUTE FUNCTION invalidate_event_reconciliation()
    """,
    """
    CREATE TRIGGER invalidate_status_event_reconciliation
    AFTER UPDATE OF status ON matches
    FOR EACH ROW EXECUTE FUNCTION invalidate_event_reconciliation()
    """,
    """
    CREATE FUNCTION require_event_reconciliation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM tournament_event_reconciliations r
            JOIN tournament_events e ON e.id=r.event_id
            WHERE r.event_id=NEW.event_id AND r.transaction_id=NEW.transaction_id
              AND r.reconciled
              AND r.lifecycle_state=e.lifecycle_state::text
              AND r.lifecycle_version=e.lifecycle_version
        ) THEN
            RAISE EXCEPTION 'event mutation requires event reconciliation'
                USING ERRCODE='23514';
        END IF;
        RETURN NULL;
    END $$
    """,
    """
    CREATE CONSTRAINT TRIGGER require_event_reconciliation
    AFTER INSERT OR UPDATE ON tournament_event_reconciliations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION require_event_reconciliation()
    """,
)


def install_event_reconciliation(
    metadata: MetaData, connection: Connection, **kwargs: object
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in RECONCILIATION_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_event_reconciliation)
