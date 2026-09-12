"""Preserve sporting participation and draw history, including SQL writes."""

from typing import Any

from sqlalchemy import MetaData, event
from sqlalchemy.engine import Connection

from app.db import Base

PARTICIPATION_INTEGRITY_DDL = (
    """
        CREATE FUNCTION seat_participation(entry_uuid uuid, stage_uuid uuid, group_uuid
        uuid)
        RETURNS uuid LANGUAGE plpgsql AS $$
        DECLARE participation_uuid uuid; event_uuid uuid; prior_group_uuid uuid;
        BEGIN
        IF entry_uuid IS NULL THEN RETURN NULL; END IF;
        SELECT event_id INTO event_uuid FROM tournament_event_stages WHERE id =
        stage_uuid;
        SELECT id, group_id INTO participation_uuid, prior_group_uuid
        FROM tournament_entry_participations
        WHERE entry_id = entry_uuid AND stage_id = stage_uuid AND ended_at IS NULL;
        IF participation_uuid IS NOT NULL AND prior_group_uuid <> group_uuid THEN
        UPDATE tournament_entry_participations
        SET ended_at=clock_timestamp(), end_reason= 'group_changed'
        WHERE id=participation_uuid;
        participation_uuid := NULL;
        END IF;
        IF participation_uuid IS NULL THEN
        INSERT INTO tournament_entry_participations(event_id, entry_id, stage_id,
        group_id)
        VALUES (event_uuid, entry_uuid, stage_uuid, group_uuid)
        RETURNING id INTO participation_uuid;
        END IF;
        RETURN participation_uuid;
        END $$
        """,
    """
        CREATE FUNCTION fixture_participation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
        IF NEW.entry_a_id IS NULL THEN
        NEW.participation_a_id := NULL;
        ELSIF NEW.participation_a_id IS NULL OR (TG_OP= 'UPDATE'
        AND NEW.participation_a_id IS NOT DISTINCT FROM OLD.participation_a_id
        AND (NEW.entry_a_id,NEW.stage_id,NEW.group_id,NEW.draw_revision_id)
        IS DISTINCT FROM
        (OLD.entry_a_id,OLD.stage_id,OLD.group_id,OLD.draw_revision_id))
        THEN
        NEW.participation_a_id := seat_participation(NEW.entry_a_id, NEW.stage_id,
        NEW.group_id);
        END IF;
        IF NEW.entry_b_id IS NULL THEN
        NEW.participation_b_id := NULL;
        ELSIF NEW.participation_b_id IS NULL OR (TG_OP= 'UPDATE'
        AND NEW.participation_b_id IS NOT DISTINCT FROM OLD.participation_b_id
        AND (NEW.entry_b_id,NEW.stage_id,NEW.group_id,NEW.draw_revision_id)
        IS DISTINCT FROM
        (OLD.entry_b_id,OLD.stage_id,OLD.group_id,OLD.draw_revision_id))
        THEN
        NEW.participation_b_id := seat_participation(NEW.entry_b_id, NEW.stage_id,
        NEW.group_id);
        END IF;
        RETURN NEW;
        END $$
        """,
    """
        CREATE TRIGGER fixture_participation BEFORE INSERT OR UPDATE ON
        tournament_fixtures
        FOR EACH ROW EXECUTE FUNCTION fixture_participation()
        """,
)


@event.listens_for(Base.metadata, "after_create")
def install_participation_integrity(
    metadata: MetaData, connection: Connection, **kwargs: Any
) -> None:
    for statement in PARTICIPATION_INTEGRITY_DDL:
        connection.exec_driver_sql(statement)


DRAW_REVISION_INTEGRITY_DDL = (
    """
        CREATE FUNCTION fixture_draw_revision() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
        IF NEW.draw_revision_id IS NULL THEN
        SELECT id INTO NEW.draw_revision_id FROM tournament_draw_revisions
        WHERE event_id = NEW.scope_event_id AND retired_at IS NULL;
        IF NEW.draw_revision_id IS NULL THEN
        INSERT INTO tournament_draw_revisions(event_id) VALUES (NEW.scope_event_id)
        RETURNING id INTO NEW.draw_revision_id;
        END IF;
        END IF;
        RETURN NEW;
        END $$
        """,
    """
        CREATE TRIGGER fixture_z_draw_revision BEFORE INSERT ON tournament_fixtures
        FOR EACH ROW EXECUTE FUNCTION fixture_draw_revision()
        """,
)


@event.listens_for(Base.metadata, "after_create")
def install_draw_revision_integrity(
    metadata: MetaData, connection: Connection, **kwargs: Any
) -> None:
    for statement in DRAW_REVISION_INTEGRITY_DDL:
        connection.exec_driver_sql(statement)


REGISTRATION_HISTORY_DDL = (
    """
        CREATE FUNCTION preserve_registration_history() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM tournament_entries WHERE id = OLD.entry_id) THEN
        RAISE EXCEPTION 'registration history cannot be deleted'
        USING ERRCODE = '23514' ;
        END IF;
        RETURN OLD;
        END IF;
        IF (NEW.id, NEW.entry_id, NEW.registered_at, NEW.registered_by_account_id)
        IS DISTINCT FROM
        (OLD.id, OLD.entry_id, OLD.registered_at, OLD.registered_by_account_id)
        OR (OLD.withdrawn_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
        THEN
        RAISE EXCEPTION 'registration history is immutable'
        USING ERRCODE = '23514' ;
        END IF;
        RETURN NEW;
        END $$
        """,
    """
        CREATE TRIGGER preserve_registration_history BEFORE UPDATE OR DELETE
        ON tournament_entry_registrations
        FOR EACH ROW EXECUTE FUNCTION preserve_registration_history()
        """,
)


@event.listens_for(Base.metadata, "after_create")
def install_registration_history(
    metadata: MetaData, connection: Connection, **kwargs: Any
) -> None:
    for statement in REGISTRATION_HISTORY_DDL:
        connection.exec_driver_sql(statement)


PARTICIPATION_ELIGIBILITY_DDL = (
    """
        CREATE FUNCTION check_participation_eligibility() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF NEW.ended_at IS NOT NULL THEN RETURN NEW; END IF;
        PERFORM id FROM tournament_events WHERE id = NEW.event_id FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM tournament_entries
        WHERE id = NEW.entry_id AND event_id = NEW.event_id)
        THEN
        RAISE EXCEPTION 'fixture entries must belong to its event'
        USING ERRCODE = '23514' ;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM tournament_entries
        WHERE id = NEW.entry_id AND event_id = NEW.event_id
        AND status = 'entered' AND superseded_by_entry_id IS NULL)
        OR EXISTS (SELECT 1 FROM tournament_entry_withdrawals
        WHERE entry_id = NEW.entry_id AND restored_at IS NULL
        AND (stage_id IS NULL OR stage_id = NEW.stage_id))
        THEN
        RAISE EXCEPTION 'withdrawn entry cannot participate'
        USING ERRCODE = '23514' ;
        END IF;
        RETURN NEW;
        END $$
        """,
    """
        CREATE TRIGGER check_participation_eligibility BEFORE INSERT
        ON tournament_entry_participations
        FOR EACH ROW EXECUTE FUNCTION check_participation_eligibility()
        """,
)


@event.listens_for(Base.metadata, "after_create")
def install_participation_eligibility(
    metadata: MetaData, connection: Connection, **kwargs: Any
) -> None:
    for statement in PARTICIPATION_ELIGIBILITY_DDL:
        connection.exec_driver_sql(statement)


DRAW_HISTORY_INTEGRITY_DDL = (
    """
        CREATE FUNCTION preserve_participation_history() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM tournament_events WHERE id=OLD.event_id) THEN
        RAISE EXCEPTION 'history cannot be deleted' USING ERRCODE= '23514' ;
        END IF;
        RETURN OLD;
        END IF;
        IF (NEW.id, NEW.event_id, NEW.entry_id, NEW.stage_id, NEW.group_id,
        NEW.started_at, NEW.draw_revision_id)
        IS DISTINCT FROM
        (OLD.id, OLD.event_id, OLD.entry_id, OLD.stage_id, OLD.group_id, OLD.started_at,
        OLD.draw_revision_id)
        OR (OLD.ended_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
        THEN
        RAISE EXCEPTION 'participation history is immutable' USING ERRCODE = '23514' ;
        END IF;
        RETURN NEW;
        END $$
        """,
    """
        CREATE TRIGGER preserve_participation_history BEFORE UPDATE OR DELETE
        ON tournament_entry_participations FOR EACH ROW
        EXECUTE FUNCTION preserve_participation_history()
        """,
    """
        CREATE FUNCTION preserve_draw_revision_history() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM tournament_events WHERE id=OLD.event_id) THEN
        RAISE EXCEPTION 'history cannot be deleted' USING ERRCODE= '23514' ;
        END IF;
        RETURN OLD;
        END IF;
        IF (NEW.id, NEW.event_id, NEW.created_at, NEW.configuration)
        IS DISTINCT FROM (OLD.id, OLD.event_id, OLD.created_at, OLD.configuration)
        OR (OLD.retired_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
        THEN
        RAISE EXCEPTION 'draw revision history is immutable' USING ERRCODE = '23514' ;
        END IF;
        RETURN NEW;
        END $$
        """,
    """
        CREATE TRIGGER preserve_draw_revision_history BEFORE UPDATE OR DELETE
        ON tournament_draw_revisions FOR EACH ROW
        EXECUTE FUNCTION preserve_draw_revision_history()
        """,
    """
        CREATE FUNCTION assign_participation_revision() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        -- SQL writers can arrive after locking a child row. Never wait backwards.
        PERFORM t.id FROM tournaments t JOIN tournament_events e ON e.tournament_id =
        t.id
        WHERE e.id = NEW.event_id FOR SHARE OF t NOWAIT;
        PERFORM id FROM tournament_events WHERE id = NEW.event_id FOR UPDATE NOWAIT;
        IF NEW.draw_revision_id IS NULL THEN
        SELECT id INTO NEW.draw_revision_id FROM tournament_draw_revisions
        WHERE event_id = NEW.event_id AND retired_at IS NULL;
        IF NEW.draw_revision_id IS NULL THEN
        INSERT INTO tournament_draw_revisions(event_id) VALUES (NEW.event_id)
        RETURNING id INTO NEW.draw_revision_id;
        END IF;
        END IF;
        IF NEW.ended_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM tournament_event_stages s
        JOIN tournament_draw_revisions r ON r.event_id = s.event_id
        WHERE s.id = NEW.stage_id AND s.retired_at IS NULL
        AND r.id = NEW.draw_revision_id AND r.retired_at IS NULL
        ) THEN
        RAISE EXCEPTION 'participation requires a current stage and revision'
        USING ERRCODE = '23514' ;
        END IF;
        RETURN NEW;
        EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'participation requires parent locks before insert; retry'
        USING ERRCODE = '40001' ;
        END $$
        """,
    """
        CREATE TRIGGER a_assign_participation_revision BEFORE INSERT
        ON tournament_entry_participations FOR EACH ROW
        EXECUTE FUNCTION assign_participation_revision()
        """,
    """
        CREATE FUNCTION preserve_retired_fixture_history() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF OLD.retired_at IS NOT NULL THEN
        IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM tournament_events WHERE id = OLD.scope_event_id) THEN
        RAISE EXCEPTION 'retired fixture history is immutable' USING ERRCODE = '23514' ;
        END IF;
        ELSIF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'retired fixture history is immutable' USING ERRCODE = '23514' ;
        END IF;
        END IF;
        RETURN COALESCE(NEW, OLD);
        END $$
        """,
    """
        CREATE TRIGGER a_preserve_retired_fixture_history BEFORE UPDATE OR DELETE
        ON tournament_fixtures FOR EACH ROW
        EXECUTE FUNCTION preserve_retired_fixture_history()
        """,
    """
        CREATE FUNCTION check_draw_retirement() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE event_uuid uuid;
        BEGIN
        IF TG_TABLE_NAME = 'tournament_fixtures' THEN
        event_uuid := NEW.scope_event_id;
        ELSE
        event_uuid := NEW.event_id;
        END IF;
        IF EXISTS (
        SELECT 1 FROM tournament_fixtures f
        JOIN tournament_draw_revisions r ON r.id = f.draw_revision_id
        WHERE r.event_id = event_uuid
        AND (f.retired_at IS NULL) IS DISTINCT FROM (r.retired_at IS NULL)
        ) THEN
        RAISE EXCEPTION 'draw retirement must be consistent' USING ERRCODE = '23514' ;
        END IF;
        IF EXISTS (
        SELECT 1 FROM tournament_entry_participations p
        JOIN tournament_draw_revisions r ON r.id=p.draw_revision_id
        JOIN tournament_event_stages s ON s.id=p.stage_id
        WHERE p.event_id=event_uuid AND p.ended_at IS NULL
        AND (r.retired_at IS NOT NULL OR s.retired_at IS NOT NULL)
        ) THEN
        RAISE EXCEPTION 'active participation requires current draw configuration'
        USING ERRCODE = '23514' ;
        END IF;
        IF EXISTS (
        SELECT 1 FROM tournament_fixtures f
        JOIN tournament_event_stages s ON s.id=f.stage_id
        WHERE s.event_id=event_uuid AND f.retired_at IS NULL AND s.retired_at IS NOT
        NULL
        ) THEN
        RAISE EXCEPTION 'current fixture requires current stage' USING ERRCODE = '23514'
        ;
        END IF;
        RETURN NULL;
        END $$
        """,
    """
        CREATE CONSTRAINT TRIGGER check_fixture_draw_retirement
        AFTER INSERT OR UPDATE ON tournament_fixtures
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION
        check_draw_retirement()
        """,
    """
        CREATE CONSTRAINT TRIGGER check_revision_draw_retirement
        AFTER INSERT OR UPDATE ON tournament_draw_revisions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION
        check_draw_retirement()
        """,
    """
        CREATE FUNCTION validate_new_fixture_seats() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF TG_OP = 'INSERT' OR
        (NEW.stage_id, NEW.group_id, NEW.draw_revision_id) IS DISTINCT FROM
        (OLD.stage_id, OLD.group_id, OLD.draw_revision_id)
        THEN
        IF NOT EXISTS (
        SELECT 1 FROM tournament_event_stages s
        JOIN tournament_draw_revisions r ON r.event_id = s.event_id
        WHERE s.id = NEW.stage_id AND s.retired_at IS NULL
        AND r.id = NEW.draw_revision_id AND r.retired_at IS NULL
        ) THEN
        RAISE EXCEPTION 'new fixture requires a current stage and revision'
        USING ERRCODE = '23514' ;
        END IF;
        END IF;
        IF NEW.entry_a_id IS NOT NULL AND (TG_OP = 'INSERT' OR
        (NEW.entry_a_id, NEW.participation_a_id, NEW.stage_id, NEW.group_id,
        NEW.draw_revision_id)
        IS DISTINCT FROM
        (OLD.entry_a_id, OLD.participation_a_id, OLD.stage_id, OLD.group_id,
        OLD.draw_revision_id))
        AND NOT EXISTS (SELECT 1 FROM tournament_entry_participations
        WHERE id = NEW.participation_a_id AND ended_at IS NULL)
        THEN
        RAISE EXCEPTION 'new fixture seat requires active participation' USING ERRCODE =
        '23514' ;
        END IF;
        IF NEW.entry_b_id IS NOT NULL AND (TG_OP = 'INSERT' OR
        (NEW.entry_b_id, NEW.participation_b_id, NEW.stage_id, NEW.group_id,
        NEW.draw_revision_id)
        IS DISTINCT FROM
        (OLD.entry_b_id, OLD.participation_b_id, OLD.stage_id, OLD.group_id,
        OLD.draw_revision_id))
        AND NOT EXISTS (SELECT 1 FROM tournament_entry_participations
        WHERE id = NEW.participation_b_id AND ended_at IS NULL)
        THEN
        RAISE EXCEPTION 'new fixture seat requires active participation' USING ERRCODE =
        '23514' ;
        END IF;
        RETURN NULL;
        END $$
        """,
    """
        CREATE TRIGGER validate_new_fixture_seats AFTER INSERT OR UPDATE
        ON tournament_fixtures FOR EACH ROW EXECUTE FUNCTION
        validate_new_fixture_seats()
        """,
    """
        CREATE CONSTRAINT TRIGGER check_participation_draw_retirement
        AFTER INSERT OR UPDATE ON tournament_entry_participations
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION
        check_draw_retirement()
        """,
    """
        CREATE CONSTRAINT TRIGGER check_stage_draw_retirement
        AFTER UPDATE ON tournament_event_stages
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION
        check_draw_retirement()
        """,
    """
        CREATE FUNCTION lock_draw_history_parent() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE event_uuid uuid; previous_event_uuid uuid;
        BEGIN
        IF TG_TABLE_NAME = 'tournament_fixtures' THEN
        SELECT event_id INTO event_uuid FROM tournament_event_stages
        WHERE id=NEW.stage_id;
        SELECT event_id INTO previous_event_uuid FROM tournament_event_stages
        WHERE id=OLD.stage_id;
        ELSE
        event_uuid := NEW.event_id;
        previous_event_uuid := OLD.event_id;
        END IF;
        PERFORM t.id FROM tournaments t
        JOIN tournament_events e ON e.tournament_id=t.id
        WHERE e.id IN (event_uuid,previous_event_uuid)
        ORDER BY t.id FOR SHARE OF t NOWAIT;
        PERFORM id FROM tournament_events
        WHERE id IN (event_uuid,previous_event_uuid)
        ORDER BY id FOR UPDATE NOWAIT;
        RETURN COALESCE(NEW,OLD);
        EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'draw history requires parent locks before write; retry'
        USING ERRCODE= '40001' ;
        END $$
        """,
    """
        CREATE TRIGGER a_lock_draw_history_parent BEFORE INSERT OR UPDATE OR DELETE
        ON tournament_fixtures FOR EACH ROW EXECUTE FUNCTION lock_draw_history_parent()
        """,
    """
        CREATE TRIGGER a_lock_draw_history_parent BEFORE INSERT OR UPDATE OR DELETE
        ON tournament_draw_revisions FOR EACH ROW EXECUTE FUNCTION
        lock_draw_history_parent()
        """,
    """
        CREATE TRIGGER a_lock_draw_history_parent BEFORE INSERT OR UPDATE OR DELETE
        ON tournament_entry_participations FOR EACH ROW EXECUTE FUNCTION
        lock_draw_history_parent()
        """,
    """
        CREATE TRIGGER a_lock_draw_history_parent BEFORE INSERT OR UPDATE OR DELETE
        ON tournament_event_stages FOR EACH ROW EXECUTE FUNCTION
        lock_draw_history_parent()
        """,
    """
        CREATE TRIGGER a_lock_draw_history_parent BEFORE INSERT OR UPDATE OR DELETE
        ON tournament_entry_withdrawals FOR EACH ROW EXECUTE FUNCTION
        lock_draw_history_parent()
        """,
    """
        CREATE FUNCTION preserve_competition_withdrawal_history() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF TG_OP= 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM tournament_events WHERE id=OLD.event_id) THEN
        RAISE EXCEPTION 'withdrawal history is immutable' USING ERRCODE= '23514' ;
        END IF;
        RETURN OLD;
        END IF;
        IF (NEW.id,NEW.event_id,NEW.entry_id,NEW.stage_id,NEW.actor_account_id,
        NEW.reason,NEW.explanation,NEW.withdrawn_at) IS DISTINCT FROM
        (OLD.id,OLD.event_id,OLD.entry_id,OLD.stage_id,OLD.actor_account_id,
        OLD.reason,OLD.explanation,OLD.withdrawn_at)
        OR (OLD.restored_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
        THEN
        RAISE EXCEPTION 'withdrawal history is immutable' USING ERRCODE= '23514' ;
        END IF;
        RETURN NEW;
        END $$
        """,
    """
        CREATE TRIGGER preserve_competition_withdrawal_history BEFORE UPDATE OR DELETE
        ON tournament_entry_withdrawals FOR EACH ROW
        EXECUTE FUNCTION preserve_competition_withdrawal_history()
        """,
)


@event.listens_for(Base.metadata, "after_create")
def install_draw_history_integrity(
    metadata: MetaData, connection: Connection, **kwargs: Any
) -> None:
    for statement in DRAW_HISTORY_INTEGRITY_DDL:
        connection.exec_driver_sql(statement)
