"""Retained assertions that administrator voids passed event result reconciliation.

A receipt binds one void action to the final event snapshot in its transaction.
It records the caller's explicit result projection assertion; SQL does not run
or duplicate the sporting strategy. Deferred enforcement rejects bare SQL voids.
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


class EventVoidReconciliation(Base):
    __tablename__ = "tournament_event_void_reconciliations"

    void_action_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("match_void_actions.id", ondelete="RESTRICT"), primary_key=True
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tournament_events.id", ondelete="RESTRICT")
    )
    lifecycle_state: Mapped[str] = mapped_column(String)
    lifecycle_version: Mapped[int] = mapped_column(Integer)
    transaction_id: Mapped[int] = mapped_column(BigInteger)


VOID_RECONCILIATION_DDL = (
    """
    CREATE FUNCTION preserve_event_void_reconciliation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND
            (OLD.transaction_id <> pg_current_xact_id()::text::bigint OR
             NEW.void_action_id <> OLD.void_action_id OR NEW.event_id <> OLD.event_id))
        THEN
            RAISE EXCEPTION 'void reconciliation receipts are retained'
                USING ERRCODE='23514';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM match_void_actions v
            JOIN tournament_fixtures f ON f.match_id=v.match_id
            JOIN tournament_events e ON e.id=f.scope_event_id
            WHERE v.id=NEW.void_action_id AND e.id=NEW.event_id
              AND e.lifecycle_state::text=NEW.lifecycle_state
              AND e.lifecycle_version=NEW.lifecycle_version
        ) THEN
            RAISE EXCEPTION 'void reconciliation must name the current event snapshot'
                USING ERRCODE='23514';
        END IF;
        NEW.transaction_id := pg_current_xact_id()::text::bigint;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_event_void_reconciliation
    BEFORE INSERT OR UPDATE OR DELETE ON tournament_event_void_reconciliations
    FOR EACH ROW EXECUTE FUNCTION preserve_event_void_reconciliation()
    """,
    """
    CREATE FUNCTION require_void_event_reconciliation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF EXISTS (
            SELECT 1 FROM tournament_fixtures f
            JOIN tournament_events e ON e.id=f.scope_event_id
            WHERE f.match_id=NEW.match_id AND NOT EXISTS (
                SELECT 1 FROM tournament_event_void_reconciliations r
                WHERE r.void_action_id=NEW.id AND r.event_id=e.id
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
)


def install_void_reconciliation(
    metadata: MetaData, connection: Connection, **kwargs: object
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in VOID_RECONCILIATION_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_void_reconciliation)
