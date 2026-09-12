"""PostgreSQL enforcement for durable event lifecycle facts."""

from typing import Any

from sqlalchemy import Connection, MetaData, event

from app.db import Base

EVENT_LIFECYCLE_DDL = (
    """
    CREATE FUNCTION preserve_event_lifecycle() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'DELETE' THEN
            IF OLD.lifecycle_state <> 'unstarted'
                OR OLD.first_recorded_play_at IS NOT NULL THEN
                RAISE EXCEPTION 'event lifecycle history must be preserved'
                    USING ERRCODE='23514';
            END IF;
            RETURN OLD;
        END IF;
        IF TG_OP = 'INSERT' THEN
            IF NEW.lifecycle_state <> 'unstarted' OR NEW.lifecycle_version <> 0
                OR NEW.first_recorded_play_at IS NOT NULL
                OR NEW.started_at IS NOT NULL THEN
                RAISE EXCEPTION
                    'events are created unstarted without fabricated history'
                    USING ERRCODE='23514';
            END IF;
            RETURN NEW;
        END IF;
        IF NEW.lifecycle_version <> OLD.lifecycle_version
            OR (NEW.first_recorded_play_at IS DISTINCT FROM OLD.first_recorded_play_at
                AND pg_trigger_depth() < 2)
            OR (OLD.first_recorded_play_at IS NOT NULL
                AND NEW.first_recorded_play_at IS DISTINCT FROM
                    OLD.first_recorded_play_at AND NOT (
                    pg_trigger_depth() > 1 AND NEW.first_recorded_play_at IS NOT NULL
                    AND NEW.first_recorded_play_at < OLD.first_recorded_play_at
                    AND NEW.first_recorded_play_at = (
                        SELECT min(s.created_at) FROM tournament_fixtures f
                        JOIN match_games g ON g.match_id=f.match_id
                        JOIN match_game_scores s ON s.match_game_id=g.id
                        WHERE f.scope_event_id=NEW.id
                    )
                ))
            OR (NEW.started_at IS DISTINCT FROM OLD.started_at AND NOT (
                OLD.lifecycle_state='unstarted' AND NEW.lifecycle_state='in_progress'
                AND OLD.started_at IS NULL AND NEW.started_at IS NOT NULL
                AND NEW.started_at <= clock_timestamp()))
            OR (OLD.lifecycle_version > 0 AND NEW.tournament_id <> OLD.tournament_id)
        THEN
            RAISE EXCEPTION 'event lifecycle facts are immutable'
                USING ERRCODE='23514';
        END IF;
        IF NEW.lifecycle_state <> OLD.lifecycle_state THEN
            IF OLD.lifecycle_state='unstarted' AND NEW.lifecycle_state='in_progress'
                AND NEW.started_at IS NULL AND NEW.first_recorded_play_at IS NULL THEN
                RAISE EXCEPTION
                    'starting an event requires play or known start evidence'
                    USING ERRCODE='23514';
            END IF;
            IF NOT (
                (OLD.lifecycle_state='unstarted'
                    AND NEW.lifecycle_state IN ('in_progress','finished','cancelled'))
                OR (OLD.lifecycle_state='in_progress'
                    AND NEW.lifecycle_state IN ('finished','cancelled'))
                OR (OLD.lifecycle_state='finished'
                    AND NEW.lifecycle_state='in_progress')) THEN
                RAISE EXCEPTION 'illegal event lifecycle transition'
                    USING ERRCODE='23514';
            END IF;
            NEW.lifecycle_version := OLD.lifecycle_version + 1;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_event_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON
        tournament_events
    FOR EACH ROW EXECUTE FUNCTION preserve_event_lifecycle()
    """,
    """
    CREATE FUNCTION append_event_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE decision_at timestamptz := clock_timestamp();
    BEGIN
        IF NEW.lifecycle_state <> OLD.lifecycle_state THEN
            INSERT INTO tournament_event_lifecycle_history(
                event_id, version, from_state, to_state, observed_at, occurred_at)
            VALUES (
                NEW.id, NEW.lifecycle_version, OLD.lifecycle_state,
                NEW.lifecycle_state, decision_at,
                CASE WHEN NEW.lifecycle_state='cancelled' THEN decision_at
                    WHEN OLD.lifecycle_state='unstarted'
                        AND NEW.lifecycle_state='in_progress' THEN NEW.started_at END);
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER append_event_lifecycle AFTER UPDATE ON tournament_events
    FOR EACH ROW EXECUTE FUNCTION append_event_lifecycle()
    """,
    """
    CREATE FUNCTION preserve_event_lifecycle_history() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP <> 'INSERT' OR pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION 'event lifecycle history is append only and database owned'
                USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_event_lifecycle_history BEFORE INSERT OR UPDATE OR DELETE
        ON tournament_event_lifecycle_history
    FOR EACH ROW EXECUTE FUNCTION preserve_event_lifecycle_history()
    """,
    """
    CREATE TRIGGER preserve_event_recorded_games BEFORE INSERT OR UPDATE OR DELETE
        ON tournament_event_recorded_games
    FOR EACH ROW EXECUTE FUNCTION preserve_event_lifecycle_history()
    """,
    """
    CREATE FUNCTION record_event_play() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
        event_uuid uuid;
        match_uuid uuid;
        game_no integer;
        state event_lifecycle_state;
    BEGIN
        PERFORM t.id FROM tournaments t
        JOIN tournament_fixtures f ON f.scope_tournament_id=t.id
        JOIN match_games g ON g.match_id=f.match_id
        WHERE g.id=NEW.match_game_id FOR SHARE OF t;
        SELECT e.id, e.lifecycle_state, g.match_id, g.game_number
        INTO event_uuid, state, match_uuid, game_no
        FROM tournament_events e
        JOIN tournament_fixtures f ON f.scope_event_id=e.id
        JOIN match_games g ON g.match_id=f.match_id
        WHERE g.id=NEW.match_game_id
        FOR UPDATE OF e;
        IF event_uuid IS NULL THEN
            RETURN NEW;
        END IF;
        IF state='cancelled'
            AND NOT EXISTS (
                SELECT 1 FROM tournament_event_recorded_games
                WHERE match_id=match_uuid AND game_number=game_no
            ) AND NOT (
                pg_trigger_depth() > 1 AND EXISTS (
                    SELECT 1 FROM match_official_results r,
                        jsonb_array_elements(r.games) game
                    WHERE r.match_id=match_uuid AND r.revision > 1
                        AND r.revision=(SELECT max(revision)
                            FROM match_official_results WHERE match_id=match_uuid)
                        AND (game->>'game_number')::integer=game_no
                        AND (game->>'side_1_points')::integer=NEW.side_1_points
                        AND (game->>'side_2_points')::integer=NEW.side_2_points
                )
            ) AND NOT EXISTS (
                SELECT 1 FROM match_results r,
                    jsonb_array_elements(r.games) game
                WHERE r.match_id=match_uuid
                    AND r.supersedes_result_id IS NOT NULL
                    AND r.accepted_at IS NULL
                    AND NOT EXISTS (SELECT 1 FROM match_results successor
                        WHERE successor.supersedes_result_id=r.id)
                    AND NOT EXISTS (SELECT 1 FROM match_official_results official
                        WHERE official.match_id=match_uuid)
                    AND (game->>'game_number')::integer=game_no
                    AND (game->>'side_1_points')::integer=NEW.side_1_points
                    AND (game->>'side_2_points')::integer=NEW.side_2_points
            ) THEN
            RAISE EXCEPTION 'cancelled events cannot record new games'
                USING ERRCODE='23514';
        END IF;
        INSERT INTO tournament_event_recorded_games(match_id,game_number,event_id)
        VALUES (match_uuid,game_no,event_uuid) ON CONFLICT DO NOTHING;
        UPDATE tournament_events
        SET first_recorded_play_at=clock_timestamp(),
            lifecycle_state=CASE WHEN lifecycle_state='unstarted'
                THEN 'in_progress'::event_lifecycle_state ELSE lifecycle_state END
        WHERE id=event_uuid AND first_recorded_play_at IS NULL;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER record_event_play BEFORE INSERT ON match_game_scores
    FOR EACH ROW EXECUTE FUNCTION record_event_play();
    """,
    """
    CREATE FUNCTION observe_attached_event_play() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF NEW.match_id IS NULL OR (TG_OP='UPDATE'
            AND NEW.match_id IS NOT DISTINCT FROM OLD.match_id
            AND NEW.scope_event_id IS NOT DISTINCT FROM OLD.scope_event_id) THEN
            RETURN NEW;
        END IF;
        IF EXISTS (SELECT 1 FROM matches
            WHERE id=NEW.match_id AND status IN ('completed','voided'))
            OR EXISTS (
                SELECT 1 FROM match_games g
                JOIN match_game_scores s ON s.match_game_id=g.id
                WHERE g.match_id=NEW.match_id
            ) THEN
            PERFORM t.id FROM tournaments t
            WHERE t.id=NEW.scope_tournament_id FOR SHARE OF t;
            PERFORM id FROM tournament_events WHERE id=NEW.scope_event_id FOR UPDATE;
            IF EXISTS (SELECT 1 FROM tournament_events
                WHERE id=NEW.scope_event_id AND lifecycle_state='cancelled') THEN
                RAISE EXCEPTION 'cancelled events cannot attach new play'
                    USING ERRCODE='23514';
            END IF;
        END IF;
        IF EXISTS (
            SELECT 1 FROM match_games g
            JOIN match_game_scores s ON s.match_game_id=g.id
            WHERE g.match_id=NEW.match_id
        ) THEN
            INSERT INTO tournament_event_recorded_games(match_id,game_number,event_id)
            SELECT g.match_id,g.game_number,NEW.scope_event_id FROM match_games g
            JOIN match_game_scores s ON s.match_game_id=g.id
            WHERE g.match_id=NEW.match_id ON CONFLICT DO NOTHING;
            UPDATE tournament_events
            SET first_recorded_play_at=LEAST(first_recorded_play_at, (
                    SELECT min(s.created_at) FROM match_games g
                    JOIN match_game_scores s ON s.match_game_id=g.id
                    WHERE g.match_id=NEW.match_id
                )),
                lifecycle_state=CASE WHEN lifecycle_state='unstarted'
                    THEN 'in_progress'::event_lifecycle_state ELSE lifecycle_state END
            WHERE id=NEW.scope_event_id;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER observe_attached_event_play AFTER INSERT OR UPDATE OF
        match_id, stage_id, scope_event_id ON tournament_fixtures
    FOR EACH ROW EXECUTE FUNCTION observe_attached_event_play()
    """,
    """
    CREATE FUNCTION guard_cancelled_event_entry() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF NEW.status='entered' AND (TG_OP='INSERT'
            OR OLD.status<>'entered' OR NEW.event_id<>OLD.event_id) THEN
            PERFORM t.id FROM tournaments t
            JOIN tournament_events e ON e.tournament_id=t.id
            WHERE e.id=NEW.event_id FOR SHARE OF t;
            PERFORM id FROM tournament_events WHERE id=NEW.event_id FOR UPDATE;
            IF EXISTS (SELECT 1 FROM tournament_events
                WHERE id=NEW.event_id AND lifecycle_state='cancelled') THEN
                RAISE EXCEPTION 'cancelled events cannot accept new entries'
                    USING ERRCODE='23514';
            END IF;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER guard_cancelled_event_entry BEFORE INSERT OR UPDATE ON
        tournament_entries
    FOR EACH ROW EXECUTE FUNCTION guard_cancelled_event_entry()
    """,
    """
    CREATE FUNCTION retain_cancelled_event_counter() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE event_uuid uuid;
    BEGIN
        PERFORM t.id FROM tournaments t
        JOIN tournament_fixtures f ON f.scope_tournament_id=t.id
        WHERE f.match_id=NEW.match_id FOR SHARE OF t;
        SELECT e.id INTO event_uuid FROM tournament_events e
        JOIN tournament_fixtures f ON f.scope_event_id=e.id
        WHERE f.match_id=NEW.match_id AND e.lifecycle_state='cancelled'
        FOR UPDATE OF e;
        IF event_uuid IS NOT NULL AND NEW.supersedes_result_id IS NULL
            AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(NEW.games) game
                WHERE NOT EXISTS (
                    SELECT 1 FROM tournament_event_recorded_games recorded
                    WHERE recorded.match_id=NEW.match_id
                        AND recorded.game_number=(game->>'game_number')::integer
                )
            ) THEN
            RAISE EXCEPTION 'cancelled events cannot propose unrecorded play'
                USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER retain_cancelled_event_counter AFTER INSERT ON match_results
    FOR EACH ROW EXECUTE FUNCTION retain_cancelled_event_counter()
    """,
    """
    CREATE FUNCTION preserve_recorded_score_identity() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF NEW.created_at > clock_timestamp() THEN
            RAISE EXCEPTION 'score creation time cannot be in the future'
                USING ERRCODE='23514';
        END IF;
        IF TG_OP = 'INSERT' THEN
            RETURN NEW;
        END IF;
        IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'score creation time is immutable'
                USING ERRCODE='23514';
        END IF;
        IF NEW.match_game_id <> OLD.match_game_id THEN
            RAISE EXCEPTION 'a recorded score preserves its game identity'
                USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_recorded_score_identity BEFORE INSERT OR UPDATE
    ON match_game_scores FOR EACH ROW
    EXECUTE FUNCTION preserve_recorded_score_identity()
    """,
    """
    CREATE FUNCTION preserve_recorded_game_identity() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF ROW(NEW.match_id, NEW.game_number)
            IS DISTINCT FROM ROW(OLD.match_id, OLD.game_number)
            AND (
                EXISTS (SELECT 1 FROM match_game_scores
                    WHERE match_game_id=OLD.id)
                OR EXISTS (SELECT 1 FROM tournament_event_recorded_games
                    WHERE match_id=OLD.match_id AND game_number=OLD.game_number)
            ) THEN
            RAISE EXCEPTION 'a recorded game preserves its match and number identity'
                USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_recorded_game_identity BEFORE UPDATE
    ON match_games FOR EACH ROW
    EXECUTE FUNCTION preserve_recorded_game_identity()
    """,
)


def install_event_lifecycle_integrity(
    metadata: MetaData, connection: Connection, **kwargs: Any
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in EVENT_LIFECYCLE_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_event_lifecycle_integrity)
