"""Database history invariants; the baseline retains a frozen copy."""

from typing import Any

from sqlalchemy import MetaData, event
from sqlalchemy.engine import Connection

from app.db import Base

ADVANCEMENT_INTEGRITY_DDL = (
    """
    CREATE FUNCTION preserve_advancement() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        RAISE EXCEPTION 'advancement history is immutable' USING ERRCODE = '23514';
    END $$
    """,
    """
    CREATE TRIGGER preserve_advancement BEFORE UPDATE OR DELETE ON
        fixture_advancement_decisions
    FOR EACH ROW EXECUTE FUNCTION preserve_advancement()
    """,
    """
    CREATE TRIGGER preserve_advancement_evidence BEFORE UPDATE OR DELETE ON
        advancement_decision_evidence
    FOR EACH ROW EXECUTE FUNCTION preserve_advancement()
    """,
    """
    CREATE FUNCTION check_advancement() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE decision fixture_advancement_decisions; target tournament_fixtures;
    BEGIN
        IF TG_TABLE_NAME = 'fixture_advancement_decisions' THEN
            SELECT * INTO decision FROM fixture_advancement_decisions WHERE id = NEW.id;
        ELSE
            SELECT * INTO decision FROM fixture_advancement_decisions WHERE id =
                NEW.decision_id;
        END IF;
        SELECT * INTO target FROM tournament_fixtures WHERE id = decision.fixture_id;
        IF NOT EXISTS (SELECT 1 FROM tournament_entries e WHERE e.id = decision.entry_id
            AND e.event_id = target.scope_event_id) THEN
            RAISE EXCEPTION 'advancement entry must belong to its target event' USING
                ERRCODE = '23514' ;
        END IF;
        IF decision.source_fixture_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM tournament_fixtures f WHERE f.id = decision.source_fixture_id
                AND f.scope_event_id = target.scope_event_id AND f.stage_id =
                    target.stage_id
        ) OR decision.source_group_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM tournament_event_stage_groups g JOIN tournament_event_stages s
                ON s.id = g.stage_id
            WHERE g.id = decision.source_group_id AND s.event_id = target.scope_event_id
        ) THEN RAISE EXCEPTION 'advancement source must belong to target event' USING
            ERRCODE = '23514' ;
        END IF;
        IF EXISTS (
            SELECT 1 FROM advancement_decision_evidence e
            WHERE e.decision_id = decision.id AND NOT EXISTS (
                SELECT 1 FROM tournament_fixtures f WHERE f.match_id = e.match_id
                    AND (f.id = decision.source_fixture_id OR f.group_id =
                        decision.source_group_id)
            )
        ) THEN RAISE EXCEPTION 'advancement evidence must belong to its source' USING
            ERRCODE = '23514' ;
        END IF;
        IF decision.unknown_reason IS NULL AND (
            EXISTS (
                SELECT 1 FROM tournament_fixtures f LEFT JOIN matches m ON m.id =
                    f.match_id
                WHERE (f.id = decision.source_fixture_id OR f.group_id =
                    decision.source_group_id)
                  AND (m.status IS NULL OR m.status <> 'voided')
                  AND (m.status <> 'completed' OR m.status IS NULL OR NOT EXISTS (
                      SELECT 1 FROM advancement_decision_evidence e WHERE e.decision_id
                          = decision.id
                          AND e.match_id = m.id AND e.official_result_id =
                              m.current_official_result_id
                  ))
            ) OR EXISTS (
                SELECT 1 FROM advancement_decision_evidence e JOIN matches m ON m.id =
                    e.match_id
                WHERE e.decision_id = decision.id
                    AND (m.status <> 'completed' OR m.current_official_result_id IS
                        DISTINCT FROM e.official_result_id)
            )
        ) THEN RAISE EXCEPTION 'advancement requires complete current source evidence'
            USING ERRCODE = '23514' ;
        END IF;
        IF decision.evidence_count <> (SELECT count(*) FROM
            advancement_decision_evidence WHERE decision_id = decision.id)
            OR (decision.unknown_reason IS NULL AND decision.evidence_count = 0) THEN
            RAISE EXCEPTION 'advancement requires complete evidence' USING ERRCODE =
                '23514' ;
        END IF;
        RETURN NULL;
    END $$
    """,
    """
    CREATE CONSTRAINT TRIGGER check_advancement AFTER INSERT ON
        fixture_advancement_decisions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_advancement()
    """,
    """
    CREATE CONSTRAINT TRIGGER check_advancement_evidence AFTER INSERT ON
        advancement_decision_evidence
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_advancement()
    """,
    """
    CREATE FUNCTION guard_advancement_seat() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_uuid uuid;
    BEGIN
        IF TG_TABLE_NAME = 'tournament_fixtures' THEN target_uuid := NEW.id;
        ELSE target_uuid := NEW.fixture_id;
        END IF;
        IF EXISTS (
            SELECT 1 FROM fixture_advancement_decisions d
            JOIN tournament_fixtures f ON f.id = d.fixture_id
            WHERE d.fixture_id = target_uuid
              AND NOT EXISTS (SELECT 1 FROM fixture_advancement_decisions next WHERE
                  next.predecessor_id = d.id)
              AND d.entry_id IS DISTINCT FROM CASE WHEN d.side = 'a' THEN f.entry_a_id
                  ELSE f.entry_b_id END
        ) THEN RAISE EXCEPTION 'current advancement must govern its seat' USING ERRCODE
            = '23514' ;
        END IF;
        RETURN NULL;
    END $$
    """,
    """
    CREATE CONSTRAINT TRIGGER guard_advancement_seat AFTER INSERT ON
        fixture_advancement_decisions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_advancement_seat()
    """,
    """
    CREATE CONSTRAINT TRIGGER guard_fixture_advancement AFTER UPDATE ON
        tournament_fixtures
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_advancement_seat()
    """,
    """
    CREATE FUNCTION append_advancement() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE previous fixture_advancement_decisions;
    BEGIN
        BEGIN
            PERFORM id FROM tournament_fixtures WHERE id = NEW.fixture_id FOR UPDATE
                NOWAIT;
        EXCEPTION WHEN lock_not_available THEN
            RAISE EXCEPTION 'advancement seat is changing; retry' USING ERRCODE =
                '40001' ;
        END;
        IF NEW.predecessor_id IS NOT NULL THEN
            SELECT * INTO previous FROM fixture_advancement_decisions WHERE id =
                NEW.predecessor_id;
            IF NOT FOUND OR NEW.revision <> previous.revision + 1 THEN
                RAISE EXCEPTION 'advancement replacement must follow current revision'
                    USING ERRCODE = '23514' ;
            END IF;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER append_advancement BEFORE INSERT ON fixture_advancement_decisions
    FOR EACH ROW EXECUTE FUNCTION append_advancement()
    """,
    """
    CREATE FUNCTION preserve_advancement_ownership() RETURNS trigger LANGUAGE plpgsql AS
        $$
    BEGIN
        IF (NEW.stage_id, NEW.group_id, NEW.round, NEW.position, NEW.scope_event_id,
            NEW.scope_tournament_id)
            IS DISTINCT FROM (OLD.stage_id, OLD.group_id, OLD.round, OLD.position,
                OLD.scope_event_id, OLD.scope_tournament_id)
            AND EXISTS (SELECT 1 FROM fixture_advancement_decisions d
                WHERE d.fixture_id = OLD.id OR d.source_fixture_id = OLD.id OR
                    d.source_group_id = OLD.group_id)
        THEN RAISE EXCEPTION 'advancement fixture ownership must be retained' USING
            ERRCODE = '23514' ;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_advancement_ownership BEFORE UPDATE ON tournament_fixtures
    FOR EACH ROW EXECUTE FUNCTION preserve_advancement_ownership()
    """,
)


def install_advancement_integrity(
    metadata: MetaData, connection: Connection, **kwargs: Any
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in ADVANCEMENT_INTEGRITY_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_advancement_integrity)
