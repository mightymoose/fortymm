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
        CREATE TRIGGER fixture_participation BEFORE INSERT OR UPDATE OF
        entry_a_id, entry_b_id, participation_a_id, participation_b_id,
        stage_id, group_id, draw_revision_id ON tournament_fixtures
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
        IF (NEW.id, NEW.event_id, NEW.created_at, NEW.configuration,
            NEW.created_by_account_id, NEW.match_rules, NEW.format_rules)
        IS DISTINCT FROM (OLD.id, OLD.event_id, OLD.created_at, OLD.configuration,
            OLD.created_by_account_id, OLD.match_rules, OLD.format_rules)
        OR (OLD.retired_at IS NOT NULL AND
        (to_jsonb(NEW) - 'retained_fixture_count') IS DISTINCT FROM
        (to_jsonb(OLD) - 'retained_fixture_count'))
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
        IF TG_OP = 'UPDATE' AND OLD.retired_at IS NULL
        AND NEW.retired_at IS NOT NULL AND
        (to_jsonb(NEW) - 'retired_at') IS DISTINCT FROM
        (to_jsonb(OLD) - 'retired_at') THEN
        RAISE EXCEPTION 'retired fixture history is immutable'
        USING ERRCODE = '23514';
        END IF;
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
        DECLARE retirement_invalid boolean; stage_invalid boolean;
        archived_stage_invalid boolean; fixture_current boolean;
        BEGIN
        -- Deferred events carry old snapshots; validate each row's final state.
        IF TG_TABLE_NAME = 'tournament_fixtures' THEN
        SELECT r.id IS NOT NULL AND
        (f.retired_at IS NULL) IS DISTINCT FROM (r.retired_at IS NULL),
        f.retired_at IS NULL AND s.retired_at IS NOT NULL,
        f.retired_at IS NOT NULL AND s.id IS NOT NULL AND s.retired_at IS NULL
        INTO retirement_invalid, stage_invalid, archived_stage_invalid
        FROM tournament_fixtures f
        LEFT JOIN tournament_draw_revisions r ON r.id = f.draw_revision_id
        LEFT JOIN tournament_event_stages s ON s.id = f.stage_id
        WHERE f.id = NEW.id;
        IF retirement_invalid THEN
        RAISE EXCEPTION 'draw retirement must be consistent' USING ERRCODE = '23514';
        END IF;
        IF stage_invalid THEN
        RAISE EXCEPTION 'current fixture requires current stage'
        USING ERRCODE = '23514';
        END IF;
        IF archived_stage_invalid THEN
        RAISE EXCEPTION 'retired fixture requires retired stage'
        USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
        END IF;
        IF TG_TABLE_NAME = 'tournament_entry_participations' THEN
        IF EXISTS (
        SELECT 1 FROM tournament_entry_participations p
        JOIN tournament_draw_revisions r ON r.id = p.draw_revision_id
        JOIN tournament_event_stages s ON s.id = p.stage_id
        WHERE p.id = NEW.id AND p.ended_at IS NULL
        AND (r.retired_at IS NOT NULL OR s.retired_at IS NOT NULL)
        ) THEN
        RAISE EXCEPTION 'active participation requires current draw configuration'
        USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
        END IF;
        IF TG_TABLE_NAME = 'tournament_draw_revisions' THEN
        IF EXISTS (
        SELECT 1 FROM tournament_fixtures f
        JOIN tournament_draw_revisions r ON r.id = f.draw_revision_id
        WHERE r.id = NEW.id
        AND (f.retired_at IS NULL) IS DISTINCT FROM (r.retired_at IS NULL)
        ) THEN
        RAISE EXCEPTION 'draw retirement must be consistent' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
        SELECT 1 FROM tournament_entry_participations p
        JOIN tournament_draw_revisions r ON r.id = p.draw_revision_id
        WHERE r.id = NEW.id AND p.ended_at IS NULL AND r.retired_at IS NOT NULL
        ) THEN
        RAISE EXCEPTION 'active participation requires current draw configuration'
        USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
        END IF;
        IF EXISTS (
        SELECT 1 FROM tournament_entry_participations p
        JOIN tournament_event_stages s ON s.id = p.stage_id
        WHERE s.id = NEW.id AND p.ended_at IS NULL AND s.retired_at IS NOT NULL
        ) THEN
        RAISE EXCEPTION 'active participation requires current draw configuration'
        USING ERRCODE = '23514';
        END IF;
        SELECT f.retired_at IS NULL INTO fixture_current
        FROM tournament_fixtures f
        JOIN tournament_event_stages s ON s.id = f.stage_id
        WHERE s.id = NEW.id
        AND (f.retired_at IS NULL) IS DISTINCT FROM (s.retired_at IS NULL)
        LIMIT 1;
        IF FOUND THEN
        IF fixture_current THEN
        RAISE EXCEPTION 'current fixture requires current stage'
        USING ERRCODE = '23514';
        ELSE
        RAISE EXCEPTION 'retired fixture requires retired stage'
        USING ERRCODE = '23514';
        END IF;
        END IF;
        RETURN NULL;
        END $$
        """,
    """
        CREATE CONSTRAINT TRIGGER check_fixture_draw_retirement
        AFTER INSERT OR UPDATE OF stage_id, draw_revision_id, retired_at
        ON tournament_fixtures
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION
        check_draw_retirement()
        """,
    """
        CREATE CONSTRAINT TRIGGER check_revision_draw_retirement
        AFTER INSERT OR UPDATE OF retired_at ON tournament_draw_revisions
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
        CREATE TRIGGER validate_new_fixture_seats AFTER UPDATE OF
        entry_a_id, entry_b_id, participation_a_id, participation_b_id,
        stage_id, group_id, draw_revision_id ON tournament_fixtures
        FOR EACH ROW EXECUTE FUNCTION
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
        CREATE TRIGGER a_lock_draw_history_parent BEFORE INSERT OR DELETE
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
    """
        CREATE FUNCTION preserve_retired_stage_history() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF TG_OP = 'UPDATE' AND OLD.retired_at IS NULL
        AND NEW.retired_at IS NOT NULL AND
        (to_jsonb(NEW) - 'retired_at') IS DISTINCT FROM
        (to_jsonb(OLD) - 'retired_at') THEN
        RAISE EXCEPTION 'retired stage history is immutable'
        USING ERRCODE = '23514';
        END IF;
        IF OLD.retired_at IS NOT NULL THEN
        IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM tournament_events WHERE id = OLD.event_id) THEN
        RAISE EXCEPTION 'retired stage history is immutable'
        USING ERRCODE = '23514';
        END IF;
        ELSIF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'retired stage history is immutable'
        USING ERRCODE = '23514';
        END IF;
        END IF;
        RETURN COALESCE(NEW, OLD);
        END $$
        """,
    """
        CREATE TRIGGER a_preserve_retired_stage_history BEFORE UPDATE OR DELETE
        ON tournament_event_stages FOR EACH ROW
        EXECUTE FUNCTION preserve_retired_stage_history()
        """,
    """
        CREATE FUNCTION preserve_retired_table_history() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF TG_OP = 'UPDATE' AND OLD.retired_at IS NULL
        AND NEW.retired_at IS NOT NULL AND
        (to_jsonb(NEW) - ARRAY['retired_at', 'position']) IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['retired_at', 'position']) THEN
        RAISE EXCEPTION 'retired table history is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.retired_at IS NOT NULL THEN
        IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM tournaments WHERE id = OLD.tournament_id)
        AND EXISTS (SELECT 1 FROM tournament_fixtures WHERE table_id = OLD.id) THEN
        RAISE EXCEPTION 'retired table history is immutable' USING ERRCODE = '23514';
        END IF;
        ELSIF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'retired table history is immutable' USING ERRCODE = '23514';
        END IF;
        END IF;
        RETURN COALESCE(NEW, OLD);
        END $$
        """,
    """
        CREATE TRIGGER preserve_retired_table_history BEFORE UPDATE OR DELETE
        ON tournament_tables FOR EACH ROW
        EXECUTE FUNCTION preserve_retired_table_history()
        """,
    """
        CREATE FUNCTION preserve_table_call_history() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF TG_OP = 'DELETE' THEN
        IF pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION 'table call history is append-only' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
        END IF;
        IF (to_jsonb(NEW) - 'fixture_id') IS DISTINCT FROM
        (to_jsonb(OLD) - 'fixture_id') OR
        (NEW.fixture_id IS DISTINCT FROM OLD.fixture_id AND
        (OLD.fixture_id IS NULL OR NEW.fixture_id IS NOT NULL OR
        pg_trigger_depth() <= 1)) THEN
        RAISE EXCEPTION 'table call history is append-only' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
        END $$
        """,
    """
        CREATE TRIGGER preserve_table_call_history BEFORE UPDATE OR DELETE
        ON tournament_table_call_history FOR EACH ROW
        EXECUTE FUNCTION preserve_table_call_history()
        """,
    """
        CREATE FUNCTION preserve_archived_group_history() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF EXISTS (SELECT 1 FROM tournament_event_stages
        WHERE id IN (OLD.stage_id, NEW.stage_id) AND retired_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM tournament_events
        WHERE id = tournament_event_stages.event_id)) THEN
        IF TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'archived group history is immutable' USING ERRCODE = '23514';
        END IF;
        END IF;
        RETURN COALESCE(NEW, OLD);
        END $$
        """,
    """
        CREATE TRIGGER preserve_archived_group_history
        BEFORE INSERT OR UPDATE OR DELETE ON tournament_event_stage_groups
        FOR EACH ROW EXECUTE FUNCTION preserve_archived_group_history()
        """,
    """
        CREATE FUNCTION preserve_archived_group_mapping() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM tournament_event_reservations
        WHERE event_id = OLD.event_id AND id = OLD.reservation_id) THEN
        -- The immutable revision snapshot owns cut-time reservation values and links.
        RETURN OLD;
        END IF;
        IF EXISTS (SELECT 1 FROM tournament_event_stages
        WHERE id IN (OLD.stage_id, NEW.stage_id) AND retired_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM tournament_events
        WHERE id = tournament_event_stages.event_id)) THEN
        IF TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'archived group mapping is immutable' USING ERRCODE = '23514';
        END IF;
        END IF;
        RETURN COALESCE(NEW, OLD);
        END $$
        """,
    """
        CREATE TRIGGER preserve_archived_group_mapping
        BEFORE INSERT OR UPDATE OR DELETE ON tournament_event_group_reservations
        FOR EACH ROW EXECUTE FUNCTION preserve_archived_group_mapping()
        """,
    """
        CREATE FUNCTION validate_fixture_insert_batch() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        PERFORM t.id FROM tournaments t WHERE t.id IN (
        SELECT e.tournament_id FROM tournament_events e
        JOIN tournament_event_stages s ON s.event_id = e.id
        JOIN inserted_fixtures f ON f.stage_id = s.id
        ) ORDER BY t.id FOR SHARE NOWAIT;
        PERFORM e.id FROM tournament_events e WHERE e.id IN (
        SELECT s.event_id FROM tournament_event_stages s
        JOIN inserted_fixtures f ON f.stage_id = s.id
        ) ORDER BY e.id FOR UPDATE NOWAIT;
        IF EXISTS (
        SELECT 1 FROM inserted_fixtures f
        LEFT JOIN tournament_event_stages s ON s.id = f.stage_id
        LEFT JOIN tournament_draw_revisions r ON r.id = f.draw_revision_id
        AND r.event_id = s.event_id
        WHERE s.id IS NULL OR r.id IS NULL
        OR s.retired_at IS NOT NULL OR r.retired_at IS NOT NULL
        ) THEN
        RAISE EXCEPTION 'new fixture requires a current stage and revision'
        USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
        SELECT 1 FROM inserted_fixtures f
        LEFT JOIN tournament_entry_participations a ON a.id = f.participation_a_id
        LEFT JOIN tournament_entry_participations b ON b.id = f.participation_b_id
        WHERE (f.entry_a_id IS NOT NULL AND (a.id IS NULL OR a.ended_at IS NOT NULL))
        OR (f.entry_b_id IS NOT NULL AND (b.id IS NULL OR b.ended_at IS NOT NULL))
        ) THEN
        RAISE EXCEPTION 'new fixture seat requires active participation'
        USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
        EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'draw history requires parent locks before write; retry'
        USING ERRCODE = '40001';
        END $$
        """,
    """
        CREATE TRIGGER validate_fixture_insert_batch AFTER INSERT ON tournament_fixtures
        REFERENCING NEW TABLE AS inserted_fixtures FOR EACH STATEMENT
        EXECUTE FUNCTION validate_fixture_insert_batch()
        """,
    """
        CREATE FUNCTION check_withdrawal_participation() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        -- Re-read final state after restoration or parent deletion.
        IF EXISTS (
        SELECT 1 FROM tournament_entry_withdrawals w
        JOIN tournament_entry_participations p
        ON p.event_id = w.event_id AND p.entry_id = w.entry_id
        WHERE w.id = NEW.id AND w.restored_at IS NULL AND p.ended_at IS NULL
        AND (w.stage_id IS NULL OR w.stage_id = p.stage_id)
        ) THEN
        RAISE EXCEPTION 'withdrawal requires participation to end'
        USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
        END $$
        """,
    """
        CREATE CONSTRAINT TRIGGER check_withdrawal_participation
        AFTER INSERT OR UPDATE ON tournament_entry_withdrawals
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION check_withdrawal_participation()
        """,
    """
        CREATE FUNCTION lock_fixture_write_batch() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE affected_events uuid[];
        BEGIN
        IF TG_OP = 'UPDATE' THEN
        SELECT array_agg(DISTINCT s.event_id) INTO affected_events
        FROM tournament_event_stages s JOIN (
        SELECT o.stage_id FROM old_fixtures o FULL JOIN new_fixtures n ON n.id=o.id
        WHERE o.match_id IS NOT DISTINCT FROM n.match_id OR
              (to_jsonb(o) - ARRAY['match_id','updated_at']) IS DISTINCT FROM
              (to_jsonb(n) - ARRAY['match_id','updated_at'])
        UNION
        SELECT n.stage_id FROM old_fixtures o FULL JOIN new_fixtures n ON n.id=o.id
        WHERE o.match_id IS NOT DISTINCT FROM n.match_id OR
              (to_jsonb(o) - ARRAY['match_id','updated_at']) IS DISTINCT FROM
              (to_jsonb(n) - ARRAY['match_id','updated_at'])
        ) f ON f.stage_id = s.id;
        ELSE
        SELECT array_agg(DISTINCT s.event_id) INTO affected_events
        FROM tournament_event_stages s JOIN old_fixtures f ON f.stage_id = s.id;
        END IF;
        IF affected_events IS NULL THEN RETURN NULL; END IF;
        PERFORM t.id FROM tournaments t WHERE t.id IN (
        SELECT e.tournament_id FROM tournament_events e
        WHERE e.id = ANY(affected_events)
        ) ORDER BY t.id FOR SHARE NOWAIT;
        PERFORM e.id FROM tournament_events e WHERE e.id = ANY(affected_events)
        ORDER BY e.id FOR UPDATE NOWAIT;
        RETURN NULL;
        EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'draw history requires parent locks before write; retry'
        USING ERRCODE = '40001';
        END $$
        """,
    """
        CREATE TRIGGER lock_fixture_update_batch AFTER UPDATE ON tournament_fixtures
        REFERENCING OLD TABLE AS old_fixtures NEW TABLE AS new_fixtures
        FOR EACH STATEMENT EXECUTE FUNCTION lock_fixture_write_batch()
        """,
    """
        CREATE TRIGGER lock_fixture_delete_batch AFTER DELETE ON tournament_fixtures
        REFERENCING OLD TABLE AS old_fixtures
        FOR EACH STATEMENT EXECUTE FUNCTION lock_fixture_write_batch()
        """,
    """
        CREATE FUNCTION check_entry_lifecycle() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE entry_uuid uuid;
        BEGIN
        IF TG_TABLE_NAME = 'tournament_entries' THEN entry_uuid := NEW.id;
        ELSE entry_uuid := NEW.entry_id;
        END IF;
        IF EXISTS (
        SELECT 1 FROM tournament_entries e WHERE e.id = entry_uuid
        AND (e.status = 'withdrawn' OR e.superseded_by_entry_id IS NOT NULL)
        AND (EXISTS (SELECT 1 FROM tournament_entry_participations p
        WHERE p.entry_id = e.id AND p.ended_at IS NULL)
        OR EXISTS (SELECT 1 FROM tournament_entry_registrations r
        WHERE r.entry_id = e.id AND r.withdrawn_at IS NULL))
        ) THEN
        RAISE EXCEPTION 'withdrawn entry requires closed registration and participation'
        USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
        SELECT 1 FROM tournament_entries e WHERE e.id = entry_uuid
        AND e.status = 'entered' AND e.superseded_by_entry_id IS NULL
        AND EXISTS (SELECT 1 FROM tournament_entry_registrations r
        WHERE r.entry_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM tournament_entry_registrations r
        WHERE r.entry_id = e.id AND r.withdrawn_at IS NULL)
        ) THEN
        RAISE EXCEPTION 'entered entry requires current registration'
        USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
        END $$
        """,
    """
        CREATE CONSTRAINT TRIGGER check_entry_lifecycle
        AFTER INSERT OR UPDATE ON tournament_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION check_entry_lifecycle()
        """,
    """
        CREATE CONSTRAINT TRIGGER check_registration_entry_lifecycle
        AFTER INSERT OR UPDATE ON tournament_entry_registrations
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION check_entry_lifecycle()
        """,
    """
        CREATE FUNCTION lock_registration_parent() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE event_uuid uuid;
        BEGIN
        SELECT event_id INTO event_uuid FROM tournament_entries WHERE id = NEW.entry_id;
        PERFORM t.id FROM tournaments t
        JOIN tournament_events e ON e.tournament_id = t.id
        WHERE e.id = event_uuid FOR SHARE OF t NOWAIT;
        PERFORM id FROM tournament_events WHERE id = event_uuid FOR UPDATE NOWAIT;
        RETURN NEW;
        EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'registration requires parent locks before write; retry'
        USING ERRCODE = '40001';
        END $$
        """,
    """
        CREATE TRIGGER lock_registration_parent BEFORE INSERT OR UPDATE
        ON tournament_entry_registrations FOR EACH ROW
        EXECUTE FUNCTION lock_registration_parent()
        """,
    """
        CREATE FUNCTION guard_draw_fixture_count() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF (TG_OP = 'INSERT' AND NEW.retained_fixture_count <> 0)
        OR (TG_OP = 'UPDATE'
        AND NEW.retained_fixture_count <> OLD.retained_fixture_count
        AND pg_trigger_depth() < 2) THEN
        RAISE EXCEPTION 'draw fixture count is maintained by fixture writes'
        USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
        END $$
        """,
    """
        CREATE TRIGGER guard_draw_fixture_count
        BEFORE INSERT OR UPDATE OF retained_fixture_count ON tournament_draw_revisions
        FOR EACH ROW EXECUTE FUNCTION guard_draw_fixture_count()
        """,
    """
        CREATE FUNCTION update_draw_fixture_counts() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF TG_OP = 'INSERT' THEN
        UPDATE tournament_draw_revisions r
        SET retained_fixture_count = r.retained_fixture_count + counts.delta
        FROM (SELECT draw_revision_id, count(*) AS delta FROM new_counted_fixtures
        GROUP BY draw_revision_id) counts WHERE r.id = counts.draw_revision_id;
        ELSIF TG_OP = 'DELETE' THEN
        UPDATE tournament_draw_revisions r
        SET retained_fixture_count = r.retained_fixture_count - counts.delta
        FROM (SELECT draw_revision_id, count(*) AS delta FROM old_counted_fixtures
        GROUP BY draw_revision_id) counts WHERE r.id = counts.draw_revision_id;
        ELSIF TG_OP = 'UPDATE' THEN
        UPDATE tournament_draw_revisions r
        SET retained_fixture_count = r.retained_fixture_count +
        CASE WHEN r.id = NEW.draw_revision_id THEN 1 ELSE -1 END
        WHERE r.id IN (OLD.draw_revision_id, NEW.draw_revision_id);
        ELSE
        UPDATE tournament_draw_revisions SET retained_fixture_count = 0
        WHERE retained_fixture_count <> 0;
        END IF;
        RETURN NULL;
        END $$
        """,
    """
        CREATE TRIGGER z_count_inserted_draw_fixtures AFTER INSERT
        ON tournament_fixtures
        REFERENCING NEW TABLE AS new_counted_fixtures FOR EACH STATEMENT
        EXECUTE FUNCTION update_draw_fixture_counts()
        """,
    """
        CREATE TRIGGER a_lock_moved_fixture_revision
        BEFORE UPDATE OF draw_revision_id ON tournament_fixtures FOR EACH ROW
        WHEN (NEW.draw_revision_id IS DISTINCT FROM OLD.draw_revision_id)
        EXECUTE FUNCTION lock_draw_history_parent()
        """,
    """
        CREATE TRIGGER z_count_updated_draw_fixtures AFTER UPDATE OF draw_revision_id
        ON tournament_fixtures FOR EACH ROW
        WHEN (NEW.draw_revision_id IS DISTINCT FROM OLD.draw_revision_id)
        EXECUTE FUNCTION update_draw_fixture_counts()
        """,
    """
        CREATE TRIGGER z_count_deleted_draw_fixtures AFTER DELETE ON tournament_fixtures
        REFERENCING OLD TABLE AS old_counted_fixtures FOR EACH STATEMENT
        EXECUTE FUNCTION update_draw_fixture_counts()
        """,
    """
        CREATE TRIGGER z_count_truncated_draw_fixtures AFTER TRUNCATE
        ON tournament_fixtures
        FOR EACH STATEMENT EXECUTE FUNCTION update_draw_fixture_counts()
        """,
    """
        CREATE TRIGGER a_lock_draw_revision_update_parent
        BEFORE UPDATE ON tournament_draw_revisions FOR EACH ROW
        WHEN (NEW.retained_fixture_count = OLD.retained_fixture_count OR
        (to_jsonb(NEW) - 'retained_fixture_count') IS DISTINCT FROM
        (to_jsonb(OLD) - 'retained_fixture_count'))
        EXECUTE FUNCTION lock_draw_history_parent()
        """,
)


@event.listens_for(Base.metadata, "after_create")
def install_draw_history_integrity(
    metadata: MetaData, connection: Connection, **kwargs: Any
) -> None:
    for statement in DRAW_HISTORY_INTEGRITY_DDL:
        connection.exec_driver_sql(statement)
