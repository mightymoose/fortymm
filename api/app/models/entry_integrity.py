"""Database enforcement for entry membership, including direct SQL writers.

The baseline carries its own frozen copy. Deferred checks permit atomic roster
replacement; event-row writes serialize competing membership transactions.
"""

from typing import Any

from sqlalchemy import MetaData, event
from sqlalchemy.engine import Connection

from app.db import Base

ENTRY_INTEGRITY_DDL = (
    """
    CREATE OR REPLACE FUNCTION check_match_ending() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE row_match matches; has_play boolean;
    BEGIN
        IF TG_TABLE_NAME = 'matches' THEN
            SELECT * INTO row_match FROM matches WHERE id = NEW.id;
        ELSE
            SELECT * INTO row_match FROM matches WHERE id = NEW.match_id;
        END IF;
        IF NOT FOUND OR row_match.ending IS NULL THEN RETURN NULL; END IF;
        has_play := EXISTS (SELECT 1 FROM match_lineups WHERE match_id = row_match.id);
        IF row_match.status NOT IN ('completed', 'voided')
            OR (row_match.ending = 'walkover' AND has_play)
            OR (row_match.ending = 'stopped_during_play' AND NOT has_play)
        THEN
            RAISE EXCEPTION 'match ending contradicts recorded play'
                USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
    END $$
    """,
    """
    CREATE CONSTRAINT TRIGGER check_match_ending AFTER INSERT OR UPDATE
    ON matches DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_match_ending()
    """,
    """
    CREATE CONSTRAINT TRIGGER check_lineup_ending AFTER INSERT ON match_lineups
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_match_ending()
    """,
    """
    CREATE OR REPLACE FUNCTION entry_canonical_player(player_uuid uuid) RETURNS uuid
    LANGUAGE plpgsql STABLE AS $$
    DECLARE next_uuid uuid; visited uuid[] := ARRAY[]::uuid[];
    BEGIN
        LOOP
            IF player_uuid = ANY(visited) THEN
                RAISE EXCEPTION 'cyclic player identity merge' USING ERRCODE = '23514';
            END IF;
            visited := array_append(visited, player_uuid);
            SELECT merged_into_player_id INTO next_uuid FROM players WHERE id =
        player_uuid;
            IF next_uuid IS NULL THEN RETURN player_uuid; END IF;
            player_uuid := next_uuid;
        END LOOP;
    END $$
    """,
    """
    CREATE OR REPLACE FUNCTION entry_single_player(entry_uuid uuid) RETURNS uuid
    LANGUAGE sql STABLE AS $$
        SELECT entry_canonical_player(min(player_id::text)::uuid)
        FROM tournament_entry_members WHERE entry_id = entry_uuid AND left_at IS NULL
        HAVING count(*) = 1
    $$
    """,
    """
    CREATE OR REPLACE FUNCTION authorize_entry_membership() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE owner_uuid uuid; actor_uuid uuid;
    BEGIN
        SELECT t.owner_account_id INTO owner_uuid FROM tournament_entries en
        JOIN tournament_events e ON e.id = en.event_id
        JOIN tournaments t ON t.id = e.tournament_id
        WHERE en.id = NEW.entry_id AND t.status IN ('live', 'archived')
            AND en.created_at < transaction_timestamp();
        IF NOT FOUND THEN RETURN NEW; END IF;
        IF TG_OP = 'INSERT' THEN actor_uuid := NEW.joined_by_account_id;
        ELSIF NEW.left_at IS DISTINCT FROM OLD.left_at THEN actor_uuid :=
        NEW.left_by_account_id;
        ELSE RETURN NEW; END IF;
        IF actor_uuid IS DISTINCT FROM owner_uuid OR NOT EXISTS (
            SELECT 1 FROM accounts WHERE id = actor_uuid AND merged_at IS NULL
        ) THEN
            RAISE EXCEPTION 'roster change after start requires the tournament director'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER authorize_entry_membership BEFORE INSERT OR UPDATE
    ON tournament_entry_members FOR EACH ROW EXECUTE FUNCTION
        authorize_entry_membership()
    """,
    """
    CREATE OR REPLACE FUNCTION check_match_lineup() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE lineup match_lineups; owner_uuid uuid; fixture tournament_fixtures;
        side_size integer; previous match_lineups;
    BEGIN
        IF TG_TABLE_NAME = 'match_lineups' THEN
            SELECT * INTO lineup FROM match_lineups WHERE id = NEW.id;
        ELSE
            SELECT * INTO lineup FROM match_lineups WHERE id = NEW.lineup_id;
        END IF;
        IF NOT FOUND THEN RETURN NULL; END IF;
        IF lineup.recorded_transaction_id <> txid_current() THEN
            RAISE EXCEPTION 'lineup history requires a new correction revision'
                USING ERRCODE = '23514';
        END IF;
        IF lineup.revision = 1 AND NOT EXISTS (
            SELECT 1 FROM matches WHERE id = lineup.match_id
                AND (status = 'in_progress'
                    OR (status = 'completed' AND ending IS NULL)
                    OR (status IN ('completed', 'voided')
                        AND ending = 'stopped_during_play'))
        ) THEN
            RAISE EXCEPTION 'lineup requires a started match'
                USING ERRCODE = '23514';
        END IF;
        -- Direct snapshots and correction revisions share capture's roster lock.
        PERFORM e.id FROM tournament_fixtures f
        JOIN tournament_event_stages s ON s.id = f.stage_id
        JOIN tournament_events e ON e.id = s.event_id
        WHERE f.match_id = lineup.match_id FOR UPDATE OF e;
        SELECT t.owner_account_id INTO owner_uuid
        FROM tournament_fixtures f
        JOIN tournament_event_stages s ON s.id = f.stage_id
        JOIN tournament_events e ON e.id = s.event_id
        JOIN tournaments t ON t.id = e.tournament_id
        WHERE f.match_id = lineup.match_id;
        IF lineup.revision > 1 AND (lineup.recorded_by_account_id IS DISTINCT FROM
        owner_uuid
            OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = owner_uuid AND
        merged_at IS NULL))
        THEN
            RAISE EXCEPTION 'lineup correction requires the tournament director'
                USING ERRCODE = '23514';
        END IF;
        IF lineup.revision > 1 THEN
            SELECT * INTO previous FROM match_lineups
            WHERE match_id = lineup.match_id AND revision = lineup.revision - 1;
            IF NOT FOUND OR previous.started_at <> lineup.started_at
                OR previous.recorded_at > lineup.recorded_at THEN
                RAISE EXCEPTION
        'lineup correction must follow the preceding revision and start time'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        SELECT ms.team_size INTO side_size FROM matches m
        JOIN match_settings ms ON ms.id = m.match_settings_id WHERE m.id =
        lineup.match_id;
        IF (SELECT count(*) FROM match_lineup_players
            WHERE lineup_id = lineup.id AND side_number = 1) <> side_size
            OR (SELECT count(*) FROM match_lineup_players
            WHERE lineup_id = lineup.id AND side_number = 2) <> side_size THEN
            RAISE EXCEPTION 'lineup requires complete match sides' USING ERRCODE =
        '23514';
        END IF;
        SELECT * INTO fixture FROM tournament_fixtures WHERE match_id = lineup.match_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'lineup requires an event fixture' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
            SELECT 1 FROM match_lineup_players p
            JOIN tournament_entry_members m ON m.id = p.entry_member_id
            WHERE p.lineup_id = lineup.id AND (
                p.player_id <> m.player_id OR m.entry_id IS DISTINCT FROM
                    CASE WHEN p.side_number = 1 THEN fixture.entry_a_id ELSE
        fixture.entry_b_id END
                OR m.joined_at > lineup.started_at
                OR (m.left_at IS NOT NULL AND m.left_at <= lineup.started_at)
            )
        ) THEN
            RAISE EXCEPTION 'lineup participant must belong to its entry at match start'
                USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
    END $$
    """,
    """
    CREATE CONSTRAINT TRIGGER check_match_lineup AFTER INSERT ON match_lineups
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_match_lineup()
    """,
    """
    CREATE CONSTRAINT TRIGGER check_match_lineup_player AFTER INSERT ON
        match_lineup_players
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_match_lineup()
    """,
    """
    CREATE OR REPLACE FUNCTION preserve_match_lineup() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE match_uuid uuid; lineup_uuid uuid;
    BEGIN
        IF TG_TABLE_NAME = 'match_lineups' THEN
            match_uuid := OLD.match_id;
        ELSE
            lineup_uuid := COALESCE(NEW.lineup_id, OLD.lineup_id);
            SELECT match_id INTO match_uuid FROM match_lineups
            WHERE id = lineup_uuid;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM matches WHERE id = match_uuid)
        THEN RETURN COALESCE(NEW, OLD); END IF;
        -- Only the nested pristine-un-call trigger may delete a provisional
        -- snapshot. Direct deletes and all updates remain forbidden.
        IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND EXISTS (
            SELECT 1 FROM matches WHERE id = match_uuid AND status = 'pending'
                AND ending IS NULL
        ) AND NOT EXISTS (SELECT 1 FROM match_games WHERE match_id = match_uuid)
          AND NOT EXISTS (SELECT 1 FROM match_results WHERE match_id = match_uuid)
        THEN RETURN OLD; END IF;
        IF TG_OP <> 'INSERT' OR EXISTS (
            SELECT 1 FROM match_lineups WHERE id = lineup_uuid
                AND recorded_transaction_id <> txid_current()
        ) THEN
            RAISE EXCEPTION 'lineup history requires a new correction revision'
                USING ERRCODE = '23514';
        END IF;
        RETURN COALESCE(NEW, OLD);
    END $$
    """,
    """
    CREATE TRIGGER preserve_match_lineup BEFORE UPDATE OR DELETE
    ON match_lineups
    FOR EACH ROW EXECUTE FUNCTION preserve_match_lineup()
    """,
    """
    CREATE CONSTRAINT TRIGGER preserve_match_lineup_player AFTER INSERT
    ON match_lineup_players DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION preserve_match_lineup()
    """,
    """
    CREATE TRIGGER preserve_match_lineup_player_history BEFORE UPDATE OR DELETE
    ON match_lineup_players FOR EACH ROW EXECUTE FUNCTION preserve_match_lineup()
    """,
    """
    CREATE OR REPLACE FUNCTION reset_pristine_match_lineup() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF OLD.status = 'in_progress' AND NEW.status = 'pending'
            AND OLD.ending IS NULL AND NEW.ending IS NULL
            AND NOT EXISTS (SELECT 1 FROM match_games WHERE match_id = NEW.id)
            AND NOT EXISTS (SELECT 1 FROM match_results WHERE match_id = NEW.id)
        THEN
            DELETE FROM match_lineups WHERE match_id = NEW.id;
        END IF;
        RETURN NULL;
    END $$
    """,
    """
    CREATE TRIGGER reset_pristine_match_lineup AFTER UPDATE OF status ON matches
    FOR EACH ROW EXECUTE FUNCTION reset_pristine_match_lineup()
    """,
    """
    CREATE OR REPLACE FUNCTION check_pristine_match_reset() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF EXISTS (SELECT 1 FROM tournament_fixtures WHERE match_id = NEW.id)
            AND NOT EXISTS (SELECT 1 FROM match_lineups WHERE match_id = NEW.id)
            AND (EXISTS (SELECT 1 FROM match_games WHERE match_id = NEW.id)
                OR EXISTS (SELECT 1 FROM match_results WHERE match_id = NEW.id))
        THEN
            RAISE EXCEPTION 'uncall must preserve recorded play'
                USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
    END $$
    """,
    """
    CREATE CONSTRAINT TRIGGER check_pristine_match_reset
    AFTER UPDATE OF status ON matches DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (OLD.status = 'in_progress' AND NEW.status = 'pending')
    EXECUTE FUNCTION check_pristine_match_reset()
    """,
    """
    CREATE OR REPLACE FUNCTION capture_match_lineup() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE fixture tournament_fixtures; lineup_uuid uuid;
        current_status match_status; current_ending match_ending;
    BEGIN
        -- Deferred events can precede an un-call in the same transaction.
        SELECT status, ending INTO current_status, current_ending
        FROM matches WHERE id = NEW.id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        IF NOT (current_status = 'in_progress'
            OR (current_status = 'completed' AND current_ending IS NULL)) OR EXISTS (
            SELECT 1 FROM match_lineups WHERE match_id = NEW.id
        ) THEN RETURN NULL; END IF;
        SELECT * INTO fixture FROM tournament_fixtures WHERE match_id = NEW.id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        -- Serialize the snapshot with roster edits before reading eligibility.
        -- A member FK's KEY SHARE lock alone permits concurrent interval closure.
        PERFORM e.id FROM tournament_events e
        JOIN tournament_event_stages s ON s.event_id = e.id
        WHERE s.id = fixture.stage_id FOR UPDATE OF e;
        IF EXISTS (
            SELECT 1 FROM match_sides s
            JOIN match_side_players p ON p.match_side_id = s.id
            LEFT JOIN tournament_entry_members m
                ON entry_canonical_player(m.player_id) = p.user_id
                AND m.entry_id = CASE WHEN s.side_number = 1
                    THEN fixture.entry_a_id ELSE fixture.entry_b_id END
                AND m.left_at IS NULL
            WHERE s.match_id = NEW.id AND m.id IS NULL
        ) THEN
            RAISE EXCEPTION 'participant must be a current entry member'
                USING ERRCODE = '23514';
        END IF;
        INSERT INTO match_lineups (match_id) VALUES (NEW.id) RETURNING id INTO
        lineup_uuid;
        INSERT INTO match_lineup_players (lineup_id, side_number, entry_member_id,
        player_id)
        SELECT lineup_uuid, s.side_number, m.id, m.player_id
        FROM match_sides s JOIN match_side_players p ON p.match_side_id = s.id
        JOIN tournament_entry_members m
            ON entry_canonical_player(m.player_id) = p.user_id
            AND m.entry_id = CASE WHEN s.side_number = 1
                THEN fixture.entry_a_id ELSE fixture.entry_b_id END
            AND m.left_at IS NULL
        WHERE s.match_id = NEW.id;
        RETURN NULL;
    END $$
    """,
    """
    CREATE CONSTRAINT TRIGGER capture_match_lineup AFTER INSERT OR UPDATE OF status
    ON matches DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION capture_match_lineup()
    """,
    """
    CREATE OR REPLACE FUNCTION preserve_entry_membership() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM tournament_entries WHERE id = OLD.entry_id)
        THEN RETURN NULL; END IF;
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'membership history must be retained'
                USING ERRCODE = '23514';
        END IF;
        IF (NEW.id, NEW.entry_id, NEW.player_id, NEW.joined_at,
        NEW.joined_by_account_id)
            IS DISTINCT FROM (OLD.id, OLD.entry_id, OLD.player_id, OLD.joined_at,
        OLD.joined_by_account_id)
            OR (OLD.left_at IS NOT NULL AND NEW.left_at IS DISTINCT FROM OLD.left_at)
            OR (OLD.left_at IS NOT NULL AND NEW.left_by_account_id IS DISTINCT FROM
        OLD.left_by_account_id)
        THEN
            RAISE EXCEPTION 'membership history must be retained'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.left_at IS NOT NULL AND EXISTS (
            SELECT 1 FROM match_lineup_players p
            JOIN match_lineups l ON l.id = p.lineup_id
            WHERE p.entry_member_id = OLD.id AND l.started_at >= NEW.left_at
        ) THEN
            RAISE EXCEPTION 'membership history must preserve match eligibility'
                USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
    END $$
    """,
    """
    CREATE CONSTRAINT TRIGGER preserve_entry_membership AFTER UPDATE OR DELETE
    ON tournament_entry_members DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION preserve_entry_membership()
    """,
    """
    CREATE OR REPLACE FUNCTION lock_entry_event() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE event_uuid uuid;
    BEGIN
        IF TG_TABLE_NAME = 'tournament_entries' AND TG_OP = 'UPDATE' THEN
            IF NEW.event_id IS DISTINCT FROM OLD.event_id THEN
                RAISE EXCEPTION 'entry event is immutable' USING ERRCODE = '23514';
            END IF;
        END IF;
        IF TG_TABLE_NAME = 'players' THEN
            FOR event_uuid IN
                WITH RECURSIVE affected_players(id) AS (
                    SELECT OLD.id
                    UNION
                    SELECT p.id FROM players p
                    JOIN affected_players a ON p.merged_into_player_id = a.id
                )
                SELECT DISTINCT e.event_id FROM affected_players a
                JOIN tournament_entry_members m ON m.player_id = a.id
                JOIN tournament_entries e ON e.id = m.entry_id ORDER BY e.event_id
            LOOP
                UPDATE tournament_events SET id = id WHERE id = event_uuid;
            END LOOP;
            RETURN NEW;
        ELSIF TG_TABLE_NAME = 'match_lineups' THEN
            SELECT s.event_id INTO event_uuid FROM tournament_fixtures f
            JOIN tournament_event_stages s ON s.id = f.stage_id
            WHERE f.match_id = NEW.match_id;
        ELSIF TG_TABLE_NAME = 'tournament_events' THEN
            event_uuid := NEW.id;
        ELSIF TG_TABLE_NAME = 'tournament_entries' THEN
            event_uuid := COALESCE(NEW.event_id, OLD.event_id);
        ELSE
            SELECT event_id INTO event_uuid FROM tournament_entries
            WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
        END IF;
        UPDATE tournament_events SET id = id WHERE id = event_uuid;
        RETURN COALESCE(NEW, OLD);
    END $$
    """,
    """
    CREATE OR REPLACE FUNCTION check_entry_event() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE event_uuid uuid; affected_events uuid[];
    BEGIN
        IF TG_TABLE_NAME = 'players' THEN
            -- Only source identities change their canonical projection. Include
            -- aliases already merged into the source, without resolving every
            -- membership across the platform.
            WITH RECURSIVE affected_players(id) AS (
                SELECT NEW.id
                UNION
                SELECT p.id FROM players p
                JOIN affected_players a ON p.merged_into_player_id = a.id
            )
            SELECT array_agg(DISTINCT e.event_id) INTO affected_events
            FROM affected_players a
            JOIN tournament_entry_members m ON m.player_id = a.id
            JOIN tournament_entries e ON e.id = m.entry_id;
        ELSIF TG_TABLE_NAME = 'tournament_events' THEN
            event_uuid := NEW.id;
        ELSIF TG_TABLE_NAME = 'tournament_entries' THEN
            event_uuid := COALESCE(NEW.event_id, OLD.event_id);
        ELSE
            SELECT event_id INTO event_uuid FROM tournament_entries
            WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
        END IF;
        IF TG_TABLE_NAME <> 'players' THEN
            affected_events := ARRAY[event_uuid];
        END IF;
        IF EXISTS (
            SELECT m.entry_id FROM tournament_entry_members m
            JOIN tournament_entries e ON e.id = m.entry_id
            WHERE e.event_id = ANY(affected_events)
                AND e.status = 'entered' AND m.left_at IS NULL
            GROUP BY m.entry_id, entry_canonical_player(m.player_id)
            HAVING count(*) > 1
        ) THEN
            RAISE EXCEPTION 'duplicate canonical entry member'
                USING ERRCODE = '23505';
        END IF;
        IF EXISTS (
            SELECT entry_canonical_player(m.player_id) FROM tournament_entry_members m
            JOIN tournament_entries e ON e.id = m.entry_id
            JOIN tournament_events ev ON ev.id = e.event_id
            WHERE e.event_id = ANY(affected_events) AND e.status =
        'entered'
              AND m.left_at IS NULL
              AND NOT ev.allow_multiple_entries_per_player
            GROUP BY e.event_id, entry_canonical_player(m.player_id) HAVING count(*) > 1
        ) THEN
            RAISE EXCEPTION 'player already entered in this event'
                USING ERRCODE = '23505',
                CONSTRAINT = 'uq_tournament_entries_event_id_user_id_active';
        END IF;
        IF EXISTS (
            SELECT e.id FROM tournament_entries e
            JOIN tournament_events ev ON ev.id = e.event_id
            LEFT JOIN tournament_entry_members m
                ON m.entry_id = e.id AND m.left_at IS NULL
            WHERE e.event_id = event_uuid AND e.status = 'entered'
            GROUP BY e.id, ev.format
            HAVING (ev.format = 'singles' AND count(m.id) <> 1)
                OR (ev.format = 'doubles' AND count(m.id) <> 2)
                OR (ev.format = 'teams' AND count(m.id) < 1)
        ) THEN
            RAISE EXCEPTION 'invalid active entry member count'
                USING ERRCODE = '23514', CONSTRAINT = 'ck_entry_member_count';
        END IF;
        RETURN NULL;
    END $$
    """,
    """
    CREATE TRIGGER lock_entry_event BEFORE INSERT OR UPDATE OR DELETE
    ON tournament_entries FOR EACH ROW EXECUTE FUNCTION lock_entry_event()
    """,
    """
    CREATE TRIGGER lock_lineup_event BEFORE INSERT ON match_lineups
    FOR EACH ROW EXECUTE FUNCTION lock_entry_event()
    """,
    """
    CREATE TRIGGER lock_player_entry_events BEFORE UPDATE OF merged_into_player_id
    ON players FOR EACH ROW EXECUTE FUNCTION lock_entry_event()
    """,
    """
    CREATE CONSTRAINT TRIGGER check_player_entry_events AFTER UPDATE OF
        merged_into_player_id
    ON players DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_entry_event()
    """,
    """
    CREATE TRIGGER lock_member_event BEFORE INSERT OR UPDATE OR DELETE
    ON tournament_entry_members FOR EACH ROW EXECUTE FUNCTION lock_entry_event()
    """,
    """
    CREATE CONSTRAINT TRIGGER check_entry_event AFTER INSERT OR UPDATE OR DELETE
    ON tournament_entries DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_entry_event()
    """,
    """
    CREATE CONSTRAINT TRIGGER check_member_event AFTER INSERT OR UPDATE OR DELETE
    ON tournament_entry_members DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_entry_event()
    """,
    """
    CREATE CONSTRAINT TRIGGER check_event_members
    AFTER UPDATE OF format, allow_multiple_entries_per_player
    ON tournament_events DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_entry_event()
    """,
)


def install_entry_integrity(
    metadata: MetaData, connection: Connection, **kwargs: Any
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in ENTRY_INTEGRITY_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_entry_integrity)
