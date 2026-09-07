"""Fresh pre-beta baseline: accounts, durable players, sporting history.

Pre-beta databases are disposable. This revision replaces the previous chain;
there is intentionally no legacy-data upgrade or ID backfill.
"""

from uuid import UUID

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

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
            OR (row_match.ending = 'walkover' AND (
                has_play
                OR EXISTS (SELECT 1 FROM match_games WHERE match_id = row_match.id)
                OR EXISTS (SELECT 1 FROM match_results WHERE match_id = row_match.id)
            ))
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
    CREATE CONSTRAINT TRIGGER check_game_ending AFTER INSERT OR UPDATE ON match_games
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_match_ending()
    """,
    """
    CREATE CONSTRAINT TRIGGER check_result_ending AFTER INSERT OR UPDATE
    ON match_results
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
        IF NEW.joined_at > clock_timestamp() THEN
            RAISE EXCEPTION 'membership cannot start in the future'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.left_at > clock_timestamp() THEN
            RAISE EXCEPTION 'membership cannot end in the future'
                USING ERRCODE = '23514';
        END IF;
        BEGIN
            PERFORM id FROM accounts
            WHERE id IN (NEW.joined_by_account_id, NEW.left_by_account_id)
            ORDER BY id FOR KEY SHARE NOWAIT;
        EXCEPTION WHEN lock_not_available THEN
            RAISE EXCEPTION 'roster actor requires account locks before parents; retry'
                USING ERRCODE = '40001';
        END;
        IF TG_OP = 'UPDATE' THEN
            -- The row is already locked: do not wait backwards on its parents.
            BEGIN
                PERFORM t.id FROM tournament_entries en
                JOIN tournament_events e ON e.id = en.event_id
                JOIN tournaments t ON t.id = e.tournament_id
                WHERE en.id = NEW.entry_id FOR SHARE OF t NOWAIT;
                PERFORM e.id FROM tournament_entries en
                JOIN tournament_events e ON e.id = en.event_id
                WHERE en.id = NEW.entry_id FOR UPDATE OF e NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION 'roster update requires parent locks; retry transaction'
                    USING ERRCODE = '40001';
            END;
        END IF;
        -- SHARE conflicts with go-live's status UPDATE as well as its owner lock.
        -- Hold it before authorizing and before the member's event lock.
        PERFORM t.id FROM tournament_entries en
        JOIN tournament_events e ON e.id = en.event_id
        JOIN tournaments t ON t.id = e.tournament_id
        WHERE en.id = NEW.entry_id FOR SHARE OF t;
        SELECT t.owner_account_id INTO owner_uuid FROM tournament_entries en
        JOIN tournament_events e ON e.id = en.event_id
        JOIN tournaments t ON t.id = e.tournament_id
        WHERE en.id = NEW.entry_id AND t.status IN ('live', 'archived')
            AND en.created_transaction_id <> txid_current();
        IF NOT FOUND THEN RETURN NEW; END IF;
        IF TG_OP = 'INSERT' THEN actor_uuid := NEW.joined_by_account_id;
        ELSIF NEW.left_at IS DISTINCT FROM OLD.left_at THEN actor_uuid :=
        NEW.left_by_account_id;
        ELSE RETURN NEW; END IF;
        IF actor_uuid IS DISTINCT FROM owner_uuid
            OR (TG_OP = 'INSERT' AND NEW.left_at IS NOT NULL
                AND NEW.left_by_account_id IS DISTINCT FROM owner_uuid)
            OR NOT EXISTS (
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
    CREATE OR REPLACE FUNCTION preserve_match_topology() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_TABLE_NAME = 'match_settings' THEN
            IF NEW.team_size IS NOT DISTINCT FROM OLD.team_size THEN RETURN NEW; END IF;
            BEGIN
                PERFORM id FROM matches WHERE match_settings_id = OLD.id
                ORDER BY id FOR UPDATE NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION 'match topology requires match lock; retry'
                    USING ERRCODE = '40001';
            END;
            IF NOT EXISTS (
                SELECT 1 FROM matches m JOIN match_lineups l ON l.match_id = m.id
                WHERE m.match_settings_id = OLD.id
            ) THEN RETURN NEW; END IF;
        ELSE
            IF NEW.match_settings_id IS NOT DISTINCT FROM OLD.match_settings_id
                OR NOT EXISTS (SELECT 1 FROM match_lineups WHERE match_id = OLD.id)
            THEN RETURN NEW; END IF;
        END IF;
        RAISE EXCEPTION 'recorded match topology must be retained'
            USING ERRCODE = '23514';
    END $$
    """,
    """
    CREATE TRIGGER preserve_match_topology BEFORE UPDATE OF team_size ON match_settings
    FOR EACH ROW EXECUTE FUNCTION preserve_match_topology()
    """,
    """
    CREATE TRIGGER preserve_match_settings_reference
    BEFORE UPDATE OF match_settings_id ON matches
    FOR EACH ROW EXECUTE FUNCTION preserve_match_topology()
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
            SELECT 1 FROM tournament_entries en
            JOIN tournament_event_stages s ON s.id = fixture.stage_id
            WHERE en.id IN (fixture.entry_a_id, fixture.entry_b_id)
                AND en.event_id <> s.event_id
        ) THEN
            RAISE EXCEPTION 'fixture entries must belong to its event'
                USING ERRCODE = '23514';
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
    DECLARE fixture tournament_fixtures; lineup_uuid uuid; match_uuid uuid;
        current_status match_status; current_ending match_ending;
    BEGIN
        IF TG_TABLE_NAME = 'tournament_fixtures' THEN
            SELECT match_id INTO match_uuid FROM tournament_fixtures WHERE id = NEW.id;
        ELSE
            match_uuid := NEW.id;
        END IF;
        -- Deferred events can precede an un-call in the same transaction.
        SELECT status, ending INTO current_status, current_ending
        FROM matches WHERE id = match_uuid FOR UPDATE;
        IF NOT FOUND THEN RETURN NULL; END IF;
        IF NOT (current_status = 'in_progress'
            OR (current_status = 'completed' AND current_ending IS NULL)) OR EXISTS (
            SELECT 1 FROM match_lineups WHERE match_id = match_uuid
        ) THEN RETURN NULL; END IF;
        SELECT * INTO fixture FROM tournament_fixtures WHERE match_id = match_uuid;
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
                ON entry_canonical_player(m.player_id)
                    = entry_canonical_player(p.user_id)
                AND m.entry_id = CASE WHEN s.side_number = 1
                    THEN fixture.entry_a_id ELSE fixture.entry_b_id END
                AND m.left_at IS NULL
            WHERE s.match_id = match_uuid AND m.id IS NULL
        ) THEN
            RAISE EXCEPTION 'participant must be a current entry member'
                USING ERRCODE = '23514';
        END IF;
        INSERT INTO match_lineups (match_id) VALUES (match_uuid) RETURNING id INTO
        lineup_uuid;
        INSERT INTO match_lineup_players (lineup_id, side_number, entry_member_id,
        player_id)
        SELECT lineup_uuid, s.side_number, m.id, m.player_id
        FROM match_sides s JOIN match_side_players p ON p.match_side_id = s.id
        JOIN tournament_entry_members m
            ON entry_canonical_player(m.player_id) = entry_canonical_player(p.user_id)
            AND m.entry_id = CASE WHEN s.side_number = 1
                THEN fixture.entry_a_id ELSE fixture.entry_b_id END
            AND m.left_at IS NULL
        WHERE s.match_id = match_uuid;
        RETURN NULL;
    END $$
    """,
    """
    CREATE CONSTRAINT TRIGGER capture_match_lineup
    AFTER INSERT OR UPDATE OF status, ending
    ON matches DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION capture_match_lineup()
    """,
    """
    CREATE CONSTRAINT TRIGGER capture_fixture_lineup AFTER INSERT OR UPDATE OF match_id
    ON tournament_fixtures DEFERRABLE INITIALLY DEFERRED
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
        IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL AND EXISTS (
            SELECT 1 FROM tournament_fixtures f
            JOIN matches m ON m.id = f.match_id
            WHERE OLD.entry_id IN (f.entry_a_id, f.entry_b_id)
                AND m.status = 'pending'
                AND NOT EXISTS (SELECT 1 FROM match_lineups l WHERE l.match_id = m.id)
                AND (EXISTS (SELECT 1 FROM match_games g WHERE g.match_id = m.id)
                    OR EXISTS (SELECT 1 FROM match_results r WHERE r.match_id = m.id))
        ) THEN
            RAISE EXCEPTION 'pending evidence must preserve membership'
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
    DECLARE event_uuid uuid; fixture_uuid uuid; match_uuid uuid; player_events uuid[];
        fixture_stage uuid; fixture_a uuid; fixture_b uuid;
        evidence_state jsonb; current_evidence_state jsonb;
    BEGIN
        IF TG_TABLE_NAME = 'match_results' THEN
            BEGIN
                PERFORM id FROM accounts
                WHERE id IN (NEW.submitted_by_user_id, NEW.accepted_by_user_id)
                ORDER BY id FOR KEY SHARE NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION 'result actor requires account locks; retry'
                    USING ERRCODE = '40001';
            END;
        END IF;
        IF TG_TABLE_NAME IN ('match_games', 'match_results') THEN
            SELECT jsonb_build_array(m.status, (
                SELECT l.id FROM match_lineups l WHERE l.match_id = m.id
                ORDER BY l.revision DESC LIMIT 1
            )) INTO evidence_state FROM matches m WHERE m.id = NEW.match_id;
        END IF;
        IF TG_TABLE_NAME = 'match_lineups' THEN
            IF NEW.recorded_at > clock_timestamp() THEN
                RAISE EXCEPTION 'lineup cannot be recorded in the future'
                    USING ERRCODE = '23514';
            END IF;
            BEGIN
                PERFORM id FROM accounts WHERE id = NEW.recorded_by_account_id
                FOR KEY SHARE NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION 'lineup actor requires account locks; retry'
                    USING ERRCODE = '40001';
            END;
            BEGIN
                PERFORM id FROM matches WHERE id = NEW.match_id FOR UPDATE NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION 'lineup requires match lock; retry'
                    USING ERRCODE = '40001';
            END;
        END IF;
        IF TG_TABLE_NAME = 'tournament_entry_members' AND TG_OP = 'DELETE' THEN
            IF EXISTS (SELECT 1 FROM tournament_entries WHERE id = OLD.entry_id) THEN
                RAISE EXCEPTION 'membership history must be retained'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF TG_TABLE_NAME IN ('match_games', 'match_results') AND TG_OP = 'UPDATE' THEN
            IF NEW.match_id IS DISTINCT FROM OLD.match_id THEN
                RAISE EXCEPTION 'recorded evidence match is immutable'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF TG_TABLE_NAME = 'tournament_entries' THEN
            IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND
                NEW.added_by_user_id IS DISTINCT FROM OLD.added_by_user_id
            ) THEN
                BEGIN
                    PERFORM id FROM accounts WHERE id = NEW.added_by_user_id
                    FOR KEY SHARE NOWAIT;
                EXCEPTION WHEN lock_not_available THEN
                    RAISE EXCEPTION 'entry actor requires account locks; retry'
                        USING ERRCODE = '40001';
                END;
            END IF;
            IF TG_OP = 'DELETE' AND EXISTS (
                SELECT 1 FROM tournament_events WHERE id = OLD.event_id
            ) THEN
                RAISE EXCEPTION 'entry history must be retained; withdraw the entry'
                    USING ERRCODE = '23514';
            END IF;
            IF TG_OP = 'INSERT' THEN
                NEW.created_transaction_id := txid_current();
            ELSIF TG_OP = 'UPDATE' AND
                NEW.created_transaction_id IS DISTINCT FROM OLD.created_transaction_id
            THEN
                RAISE EXCEPTION 'entry creation transaction is immutable'
                    USING ERRCODE = '23514';
            END IF;
            IF TG_OP = 'UPDATE' AND NEW.event_id IS DISTINCT FROM OLD.event_id THEN
                RAISE EXCEPTION 'entry event is immutable' USING ERRCODE = '23514';
            END IF;
        END IF;
        IF TG_TABLE_NAME = 'players' THEN
            WITH RECURSIVE affected_players(id) AS (
                SELECT OLD.id
                UNION
                SELECT p.id FROM players p
                JOIN affected_players a ON p.merged_into_player_id = a.id
            )
            SELECT array_agg(DISTINCT e.event_id ORDER BY e.event_id)
            INTO player_events FROM affected_players a
            JOIN tournament_entry_members m ON m.player_id = a.id
            JOIN tournament_entries e ON e.id = m.entry_id;
            BEGIN
                PERFORM t.id FROM tournaments t
                WHERE t.id IN (
                    SELECT tournament_id FROM tournament_events
                    WHERE id = ANY(player_events)
                ) ORDER BY t.id FOR SHARE OF t NOWAIT;
                PERFORM id FROM tournament_events
                WHERE id = ANY(player_events) ORDER BY id FOR UPDATE NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION 'player merge requires parent locks; retry'
                    USING ERRCODE = '40001';
            END;
            FOR event_uuid IN
                SELECT id FROM tournament_events
                WHERE id = ANY(player_events) ORDER BY id
            LOOP
                UPDATE tournament_events SET id = id WHERE id = event_uuid;
            END LOOP;
            RETURN NEW;
        ELSIF TG_TABLE_NAME = 'matches' THEN
            match_uuid := NEW.id;
            SELECT s.event_id, f.id, f.stage_id, f.entry_a_id, f.entry_b_id
            INTO event_uuid, fixture_uuid, fixture_stage, fixture_a, fixture_b
            FROM tournament_fixtures f
            JOIN tournament_event_stages s ON s.id = f.stage_id
            WHERE f.match_id = match_uuid;
        ELSIF TG_TABLE_NAME IN ('match_lineups', 'match_games', 'match_results') THEN
            match_uuid := NEW.match_id;
            SELECT s.event_id, f.id, f.stage_id, f.entry_a_id, f.entry_b_id
            INTO event_uuid, fixture_uuid, fixture_stage, fixture_a, fixture_b
            FROM tournament_fixtures f
            JOIN tournament_event_stages s ON s.id = f.stage_id
            WHERE f.match_id = match_uuid;
        ELSIF TG_TABLE_NAME = 'tournament_events' THEN
            event_uuid := NEW.id;
        ELSIF TG_TABLE_NAME = 'tournament_entries' THEN
            event_uuid := COALESCE(NEW.event_id, OLD.event_id);
        ELSE
            SELECT event_id INTO event_uuid FROM tournament_entries
            WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
        END IF;
        IF TG_TABLE_NAME = 'match_lineups' THEN
            BEGIN
                PERFORM id FROM tournament_events
                WHERE id = event_uuid FOR UPDATE NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION 'lineup requires event lock; retry'
                    USING ERRCODE = '40001';
            END;
        END IF;
        IF TG_TABLE_NAME IN ('tournament_entries', 'matches') THEN
            IF TG_OP = 'UPDATE' THEN
                BEGIN
                    PERFORM t.id FROM tournaments t
                    JOIN tournament_events e ON e.tournament_id = t.id
                    WHERE e.id = event_uuid FOR SHARE OF t NOWAIT;
                    PERFORM id FROM tournament_events
                    WHERE id = event_uuid FOR UPDATE NOWAIT;
                EXCEPTION WHEN lock_not_available THEN
                    RAISE EXCEPTION '% update requires parent locks; retry',
                        CASE WHEN TG_TABLE_NAME = 'matches' THEN 'match'
                            ELSE 'entry' END
                        USING ERRCODE = '40001';
                END;
            END IF;
            PERFORM t.id FROM tournaments t
            JOIN tournament_events e ON e.tournament_id = t.id
            WHERE e.id = event_uuid FOR SHARE OF t;
        END IF;
        UPDATE tournament_events SET id = id WHERE id = event_uuid;
        IF event_uuid IS NOT NULL AND NOT FOUND AND TG_TABLE_NAME IN (
            'matches', 'match_lineups', 'match_games', 'match_results'
        ) THEN
            RAISE EXCEPTION 'tournament association was deleted; retry transaction'
                USING ERRCODE = '40001';
        END IF;
        IF fixture_uuid IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM tournament_fixtures f
            JOIN tournament_event_stages s ON s.id = f.stage_id
            WHERE f.id = fixture_uuid AND f.match_id = match_uuid
                AND s.event_id = event_uuid
                AND f.stage_id IS NOT DISTINCT FROM fixture_stage
                AND f.entry_a_id IS NOT DISTINCT FROM fixture_a
                AND f.entry_b_id IS NOT DISTINCT FROM fixture_b
        ) THEN
            RAISE EXCEPTION 'tournament association changed; retry transaction'
                USING ERRCODE = '40001';
        END IF;
        IF fixture_uuid IS NOT NULL
            AND TG_TABLE_NAME IN ('match_games', 'match_results') THEN
            SELECT jsonb_build_array(m.status, (
                SELECT l.id FROM match_lineups l WHERE l.match_id = m.id
                ORDER BY l.revision DESC LIMIT 1
            )) INTO current_evidence_state FROM matches m WHERE m.id = match_uuid;
            IF current_evidence_state IS DISTINCT FROM evidence_state THEN
                RAISE EXCEPTION 'match state changed; retry transaction'
                    USING ERRCODE = '40001';
            END IF;
        END IF;
        RETURN COALESCE(NEW, OLD);
    END $$
    """,
    """
    CREATE OR REPLACE FUNCTION check_entry_event() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE event_uuid uuid; affected_events uuid[];
    BEGIN
        -- Membership writers already serialize on the event. Check the final
        -- timeline so an atomic departure/return can share its boundary instant.
        IF TG_TABLE_NAME = 'tournament_entry_members' THEN
          IF EXISTS (
            SELECT 1 FROM tournament_entry_members a
            JOIN tournament_entry_members b ON b.entry_id = a.entry_id
                AND b.player_id = a.player_id AND b.id > a.id
            WHERE a.entry_id = COALESCE(NEW.entry_id, OLD.entry_id)
                AND tstzrange(a.joined_at, a.left_at, '[)')
                    && tstzrange(b.joined_at, b.left_at, '[)')
        ) THEN
            RAISE EXCEPTION 'overlapping membership intervals'
                USING ERRCODE = '23514', CONSTRAINT = 'ck_entry_members_no_overlap';
          END IF;
        END IF;
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
                AND m.left_at IS NULL
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
    CREATE TRIGGER lock_match_status_event BEFORE UPDATE OF status, ending ON matches
    FOR EACH ROW EXECUTE FUNCTION lock_entry_event()
    """,
    """
    CREATE OR REPLACE FUNCTION lock_fixture_link() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'INSERT' AND NEW.match_id IS NULL THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' THEN
            IF NEW.match_id IS NOT DISTINCT FROM OLD.match_id
                AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id
                AND NEW.entry_a_id IS NOT DISTINCT FROM OLD.entry_a_id
                AND NEW.entry_b_id IS NOT DISTINCT FROM OLD.entry_b_id
                AND NEW.id IS NOT DISTINCT FROM OLD.id
                AND NEW.group_id IS NOT DISTINCT FROM OLD.group_id
                AND NEW.round IS NOT DISTINCT FROM OLD.round
                AND NEW.position IS NOT DISTINCT FROM OLD.position
                AND NEW.scope_event_id IS NOT DISTINCT FROM OLD.scope_event_id
                AND NEW.scope_tournament_id IS NOT DISTINCT FROM OLD.scope_tournament_id
            THEN RETURN NEW; END IF;
        END IF;
        PERFORM t.id FROM tournaments t
        JOIN tournament_events e ON e.tournament_id = t.id
        JOIN tournament_event_stages s ON s.event_id = e.id
        WHERE s.id IN (NEW.stage_id, OLD.stage_id)
        ORDER BY t.id FOR SHARE OF t NOWAIT;
        PERFORM e.id FROM tournament_events e
        JOIN tournament_event_stages s ON s.event_id = e.id
        WHERE s.id IN (NEW.stage_id, OLD.stage_id)
        ORDER BY e.id FOR UPDATE OF e NOWAIT;
        IF TG_OP <> 'INSERT' THEN
            IF EXISTS (SELECT 1 FROM match_lineups WHERE match_id = OLD.match_id)
                OR EXISTS (SELECT 1 FROM match_games WHERE match_id = OLD.match_id)
                OR EXISTS (SELECT 1 FROM match_results WHERE match_id = OLD.match_id)
            THEN
                RAISE EXCEPTION 'recorded match fixture must be retained'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        RETURN COALESCE(NEW, OLD);
    EXCEPTION WHEN lock_not_available THEN
        -- UPDATE has already locked the fixture before this row trigger. Never
        -- wait backwards: direct writers must retry with parent locks first.
        RAISE EXCEPTION 'fixture link requires parent locks before update; retry'
            USING ERRCODE = '40001';
    END $$
    """,
    """
    CREATE TRIGGER lock_fixture_link BEFORE INSERT OR DELETE
    OR UPDATE OF id, match_id, entry_a_id, entry_b_id, stage_id, group_id,
        round, position, scope_event_id, scope_tournament_id
    ON tournament_fixtures FOR EACH ROW EXECUTE FUNCTION lock_fixture_link()
    """,
    """
    CREATE TRIGGER lock_game_event BEFORE INSERT OR UPDATE OF match_id ON match_games
    FOR EACH ROW EXECUTE FUNCTION lock_entry_event()
    """,
    """
    CREATE TRIGGER a_lock_result_event BEFORE INSERT
    OR UPDATE OF match_id, submitted_by_user_id, accepted_by_user_id, accepted_at
    ON match_results
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


revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

NOTIFICATION_TYPE_SEED = [
    (
        "33333333-3333-3333-3333-333333330001",
        "match_reminder",
        "Match reminders",
        "Match",
    ),
    (
        "33333333-3333-3333-3333-333333330002",
        "rating_change",
        "Rating changes",
        "Rating",
    ),
    (
        "33333333-3333-3333-3333-333333330003",
        "tournament",
        "Tournament news",
        "Tourney",
    ),
    (
        "33333333-3333-3333-3333-333333330004",
        "opponent",
        "Challenges & friends",
        "Social",
    ),
    (
        "33333333-3333-3333-3333-333333330005",
        "result_confirm",
        "Score acceptances",
        "Scores",
    ),
    ("33333333-3333-3333-3333-333333330006", "match_calls", "Match calls", "Calls"),
]

NOTIFICATION_CHANNEL_SEED = [
    ("44444444-4444-4444-4444-444444440001", "in_app", "In-app", True),
    ("44444444-4444-4444-4444-444444440002", "push", "Push", True),
    ("44444444-4444-4444-4444-444444440003", "email", "Email", True),
    ("44444444-4444-4444-4444-444444440004", "sms", "SMS", False),
]

DRAW_TYPE_SEED = [
    (
        UUID("22222222-2222-2222-2222-222222220001"),
        "round-robin",
        "Round robin",
        "Everyone in a group plays everyone else in that group. Every "
        "entrant is guaranteed "
        "the same number of matches and the final standings rank the "
        "whole field, so it is "
        "the fairest read on form — but the match count climbs quickly "
        "with group size, and "
        "the event needs at least one group.",
        1,
    ),
    (
        UUID("22222222-2222-2222-2222-222222220002"),
        "single-elim",
        "Single elimination",
        "A knockout bracket: lose once and you are out. It crowns a "
        "champion in the fewest "
        "matches and the least table time, which suits a large field or"
        " a tight schedule — "
        "but half the entrants are finished after one match, and a "
        "field that is not a power "
        "of two gives the top seeds byes.",
        2,
    ),
    (
        UUID("22222222-2222-2222-2222-222222220003"),
        "rr-then-ko",
        "Round-robin then knockout",
        "Groups play all-play-all, then the top finishers from each "
        "group meet in a knockout "
        "bracket.",
        3,
    ),
    (
        UUID("22222222-2222-2222-2222-222222220004"),
        "swiss",
        "Swiss",
        "A fixed number of rounds, each pairing entrants who are on "
        "similar scores. Nobody "
        "is eliminated and everybody plays every round, so a large "
        "field is ranked in far "
        "fewer matches than a round robin — but a round's pairings are "
        "only known once the "
        "round before it has finished, and a long event may repeat a pairing.",
        4,
    ),
]


def upgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table(
        "accounts",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "display_name",
            sa.String(length=255),
            server_default="Account",
            nullable=False,
        ),
        sa.Column("email", sa.String(length=320), nullable=True),
        sa.Column("agent_access_linked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("agent_access_revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("merged_into_user_id", sa.UUID(), nullable=True),
        sa.Column("merged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(merged_at IS NULL) = (merged_into_user_id IS NULL)",
            name="ck_accounts_tombstone_pair",
        ),
        sa.CheckConstraint(
            "merged_into_user_id <> id", name="ck_accounts_not_self_merged"
        ),
        sa.ForeignKeyConstraint(
            ["merged_into_user_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_accounts_email"), "accounts", ["email"], unique=True)
    op.create_index(
        op.f("ix_accounts_merged_into_user_id"),
        "accounts",
        ["merged_into_user_id"],
        unique=False,
    )
    op.create_table(
        "draw_types",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("key", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column(
            "display_order", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key"),
    )
    op.create_table(
        "match_settings",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("team_size", sa.SmallInteger(), nullable=False),
        sa.Column("best_of", sa.SmallInteger(), nullable=False),
        sa.Column(
            "affects_rating",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        sa.Column(
            "verification_policy",
            sa.Enum(
                "none",
                "self_report",
                "opponent_confirms",
                "all_players_confirm",
                name="verification_policy",
            ),
            server_default="none",
            nullable=False,
        ),
        sa.Column(
            "retirement_window",
            sa.Interval(),
            server_default=sa.text("'7 days'"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "retirement_window IS NULL OR retirement_window > interval '0'",
            name="ck_match_settings_retirement_window_positive",
        ),
        sa.CheckConstraint(
            "best_of >= 1 AND best_of % 2 = 1", name="ck_match_settings_best_of"
        ),
        sa.CheckConstraint("team_size IN (1, 2)", name="ck_match_settings_team_size"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "notification_channels",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("key", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "display_order", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False
        ),
        sa.Column(
            "is_available", sa.Boolean(), server_default=sa.text("true"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_notification_channels_key"),
        "notification_channels",
        ["key"],
        unique=True,
    )
    op.create_table(
        "notification_types",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("key", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("short_label", sa.String(length=32), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "display_order", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_notification_types_key"), "notification_types", ["key"], unique=True
    )
    op.create_table(
        "permissions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.String(length=1024), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_permissions_name"), "permissions", ["name"], unique=True)
    op.create_table(
        "players",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("username", sa.String(length=255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("merged_into_player_id", sa.UUID(), nullable=True),
        sa.Column("merged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "(merged_at IS NULL) = (merged_into_player_id IS NULL)",
            name="ck_players_tombstone_pair",
        ),
        sa.CheckConstraint(
            "merged_into_player_id <> id", name="ck_players_not_self_merged"
        ),
        sa.ForeignKeyConstraint(
            ["merged_into_player_id"], ["players.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_players_merged_into_player_id"),
        "players",
        ["merged_into_player_id"],
        unique=False,
    )
    op.create_index(op.f("ix_players_username"), "players", ["username"], unique=True)
    op.create_table(
        "rating_strategies",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "state_schema", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column(
            "initial_state", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
        sa.Column("initial_rating_value", sa.Float(), nullable=True),
        sa.Column(
            "is_automatic",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_rating_strategies_key"), "rating_strategies", ["key"], unique=True
    )
    op.create_table(
        "roles",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.String(length=1024), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_roles_name"), "roles", ["name"], unique=True)
    op.create_table(
        "account_players",
        sa.Column("account_id", sa.UUID(), nullable=False),
        sa.Column("player_id", sa.UUID(), nullable=False),
        sa.Column(
            "is_primary", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["player_id"], ["players.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("account_id", "player_id"),
    )
    op.create_index(
        "uq_account_players_primary",
        "account_players",
        ["account_id"],
        unique=True,
        postgresql_where=sa.text("is_primary"),
    )
    op.create_table(
        "device_tokens",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("token", sa.String(length=512), nullable=False),
        sa.Column("platform", sa.String(length=16), nullable=False),
        sa.Column("environment", sa.String(length=16), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token", name="uq_device_tokens_token"),
    )
    op.create_index(
        op.f("ix_device_tokens_user_id"), "device_tokens", ["user_id"], unique=False
    )
    op.create_table(
        "leagues",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "visibility",
            sa.Enum("public", "private", name="league_visibility"),
            server_default="public",
            nullable=False,
        ),
        sa.Column(
            "is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("rating_strategy_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["rating_strategy_id"], ["rating_strategies.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_leagues_name"), "leagues", ["name"], unique=True)
    op.create_index(
        op.f("ix_leagues_rating_strategy_id"),
        "leagues",
        ["rating_strategy_id"],
        unique=False,
    )
    op.create_index(
        "uq_leagues_one_default",
        "leagues",
        ["is_default"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )
    op.create_table(
        "login_identities",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("account_id", sa.UUID(), nullable=False),
        sa.Column("issuer", sa.String(length=512), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("subject", sa.String(length=512), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "account_id",
            "issuer",
            "provider",
            name="uq_login_identities_account_provider",
        ),
        sa.UniqueConstraint(
            "issuer", "provider", "subject", name="uq_login_identities_subject"
        ),
    )
    op.create_index(
        op.f("ix_login_identities_account_id"),
        "login_identities",
        ["account_id"],
        unique=False,
    )
    op.create_table(
        "notification_channel_settings",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("channel", sa.String(length=16), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["channel"], ["notification_channels.key"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "channel", name="uq_notification_channel_settings_user_channel"
        ),
    )
    op.create_table(
        "notification_preferences",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("channel", sa.String(length=16), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["category"], ["notification_types.key"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["channel"], ["notification_channels.key"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "category",
            "channel",
            name="uq_notification_preferences_user_category_channel",
        ),
    )
    op.create_table(
        "role_permissions",
        sa.Column("role_id", sa.UUID(), nullable=False),
        sa.Column("permission_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["permission_id"], ["permissions.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["role_id"], ["roles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("role_id", "permission_id"),
    )
    op.create_table(
        "tournament_event_draw_settings",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("draw_type_id", sa.UUID(), nullable=False),
        sa.Column(
            "settings",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "jsonb_typeof(settings) = 'object'",
            name="ck_tournament_event_draw_settings_settings_object",
        ),
        sa.ForeignKeyConstraint(
            ["draw_type_id"], ["draw_types.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "user_roles",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("role_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["role_id"], ["roles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "role_id"),
    )
    op.create_table(
        "user_tokens",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("token", sa.LargeBinary(), nullable=False),
        sa.Column("context", sa.String(length=255), nullable=False),
        sa.Column("sent_to", sa.String(length=255), nullable=True),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("replaced_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_user_tokens_replaced_pending_email",
        "user_tokens",
        ["created_at"],
        unique=False,
        postgresql_where=sa.text(
            "replaced_at IS NOT NULL AND (context LIKE 'change:%' OR "
            "context LIKE 'merge:%')"
        ),
    )
    op.create_index(
        op.f("ix_user_tokens_token"), "user_tokens", ["token"], unique=False
    )
    op.create_index(
        op.f("ix_user_tokens_user_id"), "user_tokens", ["user_id"], unique=False
    )
    op.create_table(
        "league_memberships",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("league_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["league_id"], ["leagues.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["players.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "league_id", "user_id", name="uq_league_memberships_league_id_user_id"
        ),
    )
    op.create_index(
        "ix_league_memberships_user_id", "league_memberships", ["user_id"], unique=False
    )
    op.create_table(
        "matches",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("match_settings_id", sa.UUID(), nullable=False),
        sa.Column("league_id", sa.UUID(), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "pending", "in_progress", "completed", "voided", name="match_status"
            ),
            server_default="pending",
            nullable=False,
        ),
        sa.Column("created_by_user_id", sa.UUID(), nullable=False),
        sa.Column(
            "ending",
            sa.Enum("walkover", "stopped_during_play", name="match_ending"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["league_id"], ["leagues.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["match_settings_id"], ["match_settings.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_matches_created_by_user_id_created_at",
        "matches",
        ["created_by_user_id", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_index("ix_matches_league_id", "matches", ["league_id"], unique=False)
    op.create_index(
        "ix_matches_status_completed_at",
        "matches",
        ["status", sa.literal_column("completed_at DESC")],
        unique=False,
    )
    op.create_index(
        "ix_matches_status_created_at",
        "matches",
        ["status", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_index(
        "ix_matches_status_updated_at",
        "matches",
        ["status", sa.literal_column("updated_at DESC")],
        unique=False,
    )
    op.create_table(
        "tournaments",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column(
            "details_version", sa.Integer(), server_default=sa.text("1"), nullable=False
        ),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.Enum("draft", "published", "live", "archived", name="tournament_status"),
            server_default="draft",
            nullable=False,
        ),
        sa.Column(
            "address",
            postgresql.JSONB(none_as_null=True, astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("league_id", sa.UUID(), nullable=False),
        sa.Column("owner_account_id", sa.UUID(), nullable=False),
        sa.Column("created_by_user_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["league_id"], ["leagues.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["owner_account_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_tournaments_created_by_user_id_created_at",
        "tournaments",
        ["created_by_user_id", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_index(
        op.f("ix_tournaments_owner_account_id"),
        "tournaments",
        ["owner_account_id"],
        unique=False,
    )
    op.create_table(
        "user_league_ratings",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("league_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("rating_strategy_id", sa.UUID(), nullable=False),
        sa.Column("rating_value", sa.Float(), nullable=True),
        sa.Column(
            "rating_state", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["league_id"], ["leagues.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["rating_strategy_id"], ["rating_strategies.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["players.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "league_id", "user_id", name="uq_user_league_ratings_league_id_user_id"
        ),
    )
    op.create_index(
        "ix_user_league_ratings_user_id",
        "user_league_ratings",
        ["user_id"],
        unique=False,
    )
    op.create_table(
        "match_games",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("match_id", sa.UUID(), nullable=False),
        sa.Column("game_number", sa.SmallInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("game_number >= 1", name="ck_match_games_game_number"),
        sa.ForeignKeyConstraint(["match_id"], ["matches.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "match_id", "game_number", name="uq_match_games_match_id_game_number"
        ),
    )
    op.create_index(
        "ix_match_games_match_id", "match_games", ["match_id"], unique=False
    )
    op.create_table(
        "match_results",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("match_id", sa.UUID(), nullable=False),
        sa.Column("submitted_by_user_id", sa.UUID(), nullable=False),
        sa.Column("submitted_for_player_id", sa.UUID(), nullable=True),
        sa.Column(
            "submitted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("supersedes_result_id", sa.UUID(), nullable=True),
        sa.Column("accepted_by_user_id", sa.UUID(), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reminder_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("games", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.CheckConstraint(
            "(accepted_by_user_id IS NULL) = (accepted_at IS NULL)",
            name="ck_match_results_accepted_pair",
        ),
        sa.CheckConstraint(
            "supersedes_result_id <> id", name="ck_match_results_not_self"
        ),
        sa.ForeignKeyConstraint(
            ["accepted_by_user_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["match_id"], ["matches.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["submitted_by_user_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["submitted_for_player_id"], ["players.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["supersedes_result_id", "match_id"],
            ["match_results.id", "match_results.match_id"],
            name="fk_match_results_predecessor_match",
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint("id", "match_id", name="uq_match_results_id_match"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "supersedes_result_id", name="uq_match_results_supersedes_result_id"
        ),
    )
    op.create_index(
        "ix_match_results_match_id", "match_results", ["match_id"], unique=False
    )
    op.create_index(
        "uq_match_results_root",
        "match_results",
        ["match_id"],
        unique=True,
        postgresql_where=sa.text("supersedes_result_id IS NULL"),
    )
    op.execute("""
        CREATE FUNCTION guard_proposal_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            -- Serialize appends and acceptance even for direct SQL writers.
            -- A real row version (not just FOR UPDATE) also makes stale
            -- REPEATABLE READ / SERIALIZABLE writers fail with 40001.
            UPDATE matches SET id = id WHERE id = NEW.match_id;
            IF NEW.submitted_for_player_id IS NOT NULL THEN
                -- Bump the Player version as well as locking it: a merge
                -- using an older Repeatable Read snapshot must retry rather
                -- than miss this proposal in its representation update.
                UPDATE players SET id = id
                WHERE id = NEW.submitted_for_player_id
                  AND merged_into_player_id IS NULL;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'a proposal must represent an active Player'
                        USING ERRCODE = '23514';
                END IF;
            END IF;
            -- A non-deferrable FK alone checks at statement end, permitting
            -- circular multi-row INSERTs. Require an already inserted parent.
            IF NEW.supersedes_result_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM match_results
                WHERE id = NEW.supersedes_result_id AND match_id = NEW.match_id
            ) THEN
                RAISE EXCEPTION 'proposal predecessor must already exist in this match'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
    """)
    op.execute("""
        CREATE TRIGGER guard_proposal_insert
        BEFORE INSERT ON match_results
        FOR EACH ROW EXECUTE FUNCTION guard_proposal_insert()
    """)
    op.execute("""
        CREATE FUNCTION guard_proposal_update() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF ROW(NEW.id, NEW.match_id, NEW.supersedes_result_id, NEW.games,
                   NEW.submitted_by_user_id, NEW.submitted_at)
                IS DISTINCT FROM
               ROW(OLD.id, OLD.match_id, OLD.supersedes_result_id, OLD.games,
                   OLD.submitted_by_user_id, OLD.submitted_at) THEN
                RAISE EXCEPTION 'proposal snapshot and links are immutable'
                    USING ERRCODE = '23514';
            END IF;
            IF NEW.submitted_for_player_id IS DISTINCT FROM OLD.submitted_for_player_id
            THEN
                -- Only the nested write from apply_player_merge_to_proposals
                -- may repoint representation; ordinary SQL cannot borrow a
                -- previously recorded merge as permission to rewrite history.
                IF pg_trigger_depth() <> 2 OR
                   NEW.submitted_for_player_id IS NULL OR
                   OLD.submitted_for_player_id IS NULL OR NOT EXISTS (
                    SELECT 1 FROM players WHERE id = OLD.submitted_for_player_id
                      AND merged_into_player_id = NEW.submitted_for_player_id
                      AND merged_at IS NOT NULL
                ) THEN
                    RAISE EXCEPTION
                        'represented Player changes require a same-person merge'
                        USING ERRCODE = '23514';
                END IF;
            END IF;
            IF OLD.accepted_by_user_id IS NOT NULL AND
                ROW(NEW.accepted_by_user_id, NEW.accepted_at) IS DISTINCT FROM
                ROW(OLD.accepted_by_user_id, OLD.accepted_at) THEN
                RAISE EXCEPTION 'proposal acceptance is immutable'
                    USING ERRCODE = '23514';
            END IF;
            IF OLD.accepted_by_user_id IS NULL AND
               NEW.accepted_by_user_id IS NOT NULL THEN
                UPDATE matches SET id = id WHERE id = OLD.match_id;
                IF EXISTS (
                    SELECT 1 FROM match_results WHERE supersedes_result_id = OLD.id
                ) THEN
                    RAISE EXCEPTION 'only the proposal head can receive acceptance'
                        USING ERRCODE = '23514';
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$
    """)
    op.execute("""
        CREATE TRIGGER guard_proposal_update
        BEFORE UPDATE ON match_results
        FOR EACH ROW EXECUTE FUNCTION guard_proposal_update()
    """)
    op.execute("""
        CREATE FUNCTION prevent_proposal_delete() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'proposal history cannot be deleted'
                USING ERRCODE = '23514';
        END;
        $$
    """)
    op.execute("""
        CREATE TRIGGER prevent_proposal_delete
        BEFORE DELETE ON match_results
        FOR EACH ROW EXECUTE FUNCTION prevent_proposal_delete()
    """)
    op.execute("""
        CREATE FUNCTION apply_player_merge_to_proposals() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            UPDATE match_results SET submitted_for_player_id = NEW.merged_into_player_id
            WHERE submitted_for_player_id = NEW.id;
            RETURN NEW;
        END;
        $$
    """)
    op.execute("""
        CREATE TRIGGER apply_player_merge_to_proposals
        AFTER UPDATE ON players
        FOR EACH ROW WHEN (OLD.merged_into_player_id IS NULL
                           AND NEW.merged_into_player_id IS NOT NULL)
        EXECUTE FUNCTION apply_player_merge_to_proposals()
    """)
    op.execute("""
        CREATE FUNCTION preserve_player_merge() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                IF OLD.merged_into_player_id IS NOT NULL THEN
                    RAISE EXCEPTION 'recorded Player merges cannot be deleted'
                        USING ERRCODE = '23514';
                END IF;
                RETURN OLD;
            END IF;
            IF OLD.merged_into_player_id IS NOT NULL AND
               ROW(NEW.merged_into_player_id, NEW.merged_at) IS DISTINCT FROM
               ROW(OLD.merged_into_player_id, OLD.merged_at) THEN
                RAISE EXCEPTION 'recorded Player merges are immutable'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
    """)
    op.execute("""
        CREATE TRIGGER preserve_player_merge
        BEFORE UPDATE OR DELETE ON players
        FOR EACH ROW EXECUTE FUNCTION preserve_player_merge()
    """)
    op.create_table(
        "match_sides",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("match_id", sa.UUID(), nullable=False),
        sa.Column("side_number", sa.SmallInteger(), nullable=False),
        sa.Column(
            "score", sa.SmallInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("won", sa.Boolean(), nullable=True),
        sa.CheckConstraint("score >= 0", name="ck_match_sides_score"),
        sa.CheckConstraint("side_number IN (1, 2)", name="ck_match_sides_side_number"),
        sa.ForeignKeyConstraint(["match_id"], ["matches.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "match_id", name="uq_match_sides_id_match_id"),
        sa.UniqueConstraint(
            "match_id", "side_number", name="uq_match_sides_match_id_side_number"
        ),
    )
    op.create_index(
        "ix_match_sides_match_id", "match_sides", ["match_id"], unique=False
    )
    op.create_table(
        "rating_history",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("league_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("match_id", sa.UUID(), nullable=True),
        sa.Column("rating_strategy_id", sa.UUID(), nullable=False),
        sa.Column("rating_value", sa.Float(), nullable=False),
        sa.Column(
            "rating_state", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column("previous_rating_value", sa.Float(), nullable=True),
        sa.Column(
            "source",
            sa.Enum(
                "match", "manual", "import", "initial", name="rating_history_source"
            ),
            nullable=False,
        ),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["league_id"], ["leagues.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["match_id"], ["matches.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["rating_strategy_id"], ["rating_strategies.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["players.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_rating_history_league_id_user_id_created_at",
        "rating_history",
        ["league_id", "user_id", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_index(
        "ix_rating_history_match_id", "rating_history", ["match_id"], unique=False
    )
    op.create_index(
        "uq_rating_history_match_id_user_id",
        "rating_history",
        ["match_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("match_id IS NOT NULL"),
    )
    op.create_table(
        "schedule_solves",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("tournament_id", sa.UUID(), nullable=False),
        sa.Column(
            "trigger",
            sa.Enum(
                "go_live",
                "match_completed",
                "settings_changed",
                "manual",
                "pin_tick",
                "rerun",
                name="schedule_solve_trigger",
            ),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.Enum(
                "queued",
                "running",
                "succeeded",
                "infeasible",
                "failed",
                name="schedule_solve_status",
            ),
            server_default="queued",
            nullable=False,
        ),
        sa.Column(
            "verdict",
            sa.Enum("optimal", "feasible", "infeasible", name="solver_verdict"),
            nullable=True,
        ),
        sa.Column(
            "requested_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("wall_time_ms", sa.Integer(), nullable=True),
        sa.Column("fixtures_placed", sa.Integer(), nullable=True),
        sa.Column("fixtures_pinned", sa.Integer(), nullable=True),
        sa.Column(
            "overrunning", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("input_fingerprint", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "infeasibility_reasons",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "placement_conflicts",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "rerun_requested",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id"], ["tournaments.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_schedule_solves_tournament_id_requested_at",
        "schedule_solves",
        ["tournament_id", sa.literal_column("requested_at DESC")],
        unique=False,
    )
    op.create_table(
        "tournament_events",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("tournament_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column(
            "format",
            sa.Enum("singles", "doubles", "teams", name="event_format"),
            nullable=False,
        ),
        sa.Column(
            "allow_multiple_entries_per_player",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.CheckConstraint(
            "NOT allow_multiple_entries_per_player OR format = 'teams'",
            name="ck_tournament_events_multiple_entries_teams_only",
        ),
        sa.Column("draw_settings_id", sa.UUID(), nullable=False),
        sa.Column("max_players", sa.Integer(), nullable=True),
        sa.Column("entry_fee", sa.Numeric(precision=8, scale=2), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("slot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "match_settings", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column(
            "predicates",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "lock_version", sa.Integer(), server_default=sa.text("1"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "entry_fee >= 0", name="ck_tournament_events_entry_fee_non_negative"
        ),
        sa.CheckConstraint(
            "max_players > 0", name="ck_tournament_events_max_players_positive"
        ),
        sa.ForeignKeyConstraint(
            ["draw_settings_id"],
            ["tournament_event_draw_settings.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id"], ["tournaments.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tournament_id", "id", name="uq_tournament_events_tournament_id_id"
        ),
    )
    op.create_index(
        op.f("ix_tournament_events_draw_settings_id"),
        "tournament_events",
        ["draw_settings_id"],
        unique=False,
    )
    op.create_index(
        "ix_tournament_events_tournament_id_created_at",
        "tournament_events",
        ["tournament_id", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_table(
        "tournament_tables",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("tournament_id", sa.UUID(), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("court", sa.String(length=255), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id"], ["tournaments.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tournament_id", "id", name="uq_tournament_tables_tournament_id_id"
        ),
        sa.UniqueConstraint(
            "tournament_id",
            "position",
            deferrable=True,
            initially="DEFERRED",
            name="uq_tournament_tables_tournament_position",
        ),
    )
    op.create_index(
        "ix_tournament_tables_tournament_id_position",
        "tournament_tables",
        ["tournament_id", "position"],
        unique=False,
    )
    op.create_table(
        "match_game_scores",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("match_game_id", sa.UUID(), nullable=False),
        sa.Column("side_1_points", sa.SmallInteger(), nullable=False),
        sa.Column("side_2_points", sa.SmallInteger(), nullable=False),
        sa.Column("version", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "side_1_points >= 0", name="ck_match_game_scores_side_1_points"
        ),
        sa.CheckConstraint(
            "side_2_points >= 0", name="ck_match_game_scores_side_2_points"
        ),
        sa.ForeignKeyConstraint(
            ["match_game_id"], ["match_games.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("match_game_id", name="uq_match_game_scores_match_game_id"),
    )
    op.create_table(
        "match_side_players",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("match_side_id", sa.UUID(), nullable=False),
        sa.Column("match_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(["match_id"], ["matches.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["match_side_id", "match_id"],
            ["match_sides.id", "match_sides.match_id"],
            name="fk_match_side_players_side_match",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["players.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "match_id", "user_id", name="uq_match_side_players_match_id_user_id"
        ),
        sa.UniqueConstraint(
            "match_side_id",
            "user_id",
            name="uq_match_side_players_match_side_id_user_id",
        ),
    )
    op.create_index(
        "ix_match_side_players_match_side_id",
        "match_side_players",
        ["match_side_id"],
        unique=False,
    )
    op.create_index(
        "ix_match_side_players_user_id", "match_side_players", ["user_id"], unique=False
    )
    op.create_table(
        "notifications",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("body", sa.String(length=500), nullable=False),
        sa.Column("link", sa.String(length=512), nullable=True),
        sa.Column("action_label", sa.String(length=40), nullable=True),
        sa.Column("delta", sa.String(length=16), nullable=True),
        sa.Column("result_id", sa.UUID(), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["category"], ["notification_types.key"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["result_id"], ["match_results.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_notifications_result_id", "notifications", ["result_id"], unique=False
    )
    op.create_index(
        "ix_notifications_user_id_created_at",
        "notifications",
        ["user_id", "created_at"],
        unique=False,
    )
    op.create_table(
        "tournament_entries",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("added_by_user_id", sa.UUID(), nullable=True),
        sa.Column("seed", sa.Integer(), nullable=True),
        sa.Column(
            "created_transaction_id",
            sa.BigInteger(),
            server_default=sa.text("txid_current()"),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.Enum("entered", "withdrawn", name="tournament_entry_status"),
            server_default="entered",
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["added_by_user_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["event_id"], ["tournament_events.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_tournament_entries_added_by_user_id",
        "tournament_entries",
        ["added_by_user_id"],
        unique=False,
    )
    op.create_index(
        "ix_tournament_entries_event_id",
        "tournament_entries",
        ["event_id"],
        unique=False,
    )
    op.create_table(
        "tournament_event_reservations",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("slot_date", sa.Date(), nullable=False),
        sa.Column("slot_start", sa.Time(), nullable=False),
        sa.Column("slot_end", sa.Time(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["event_id"], ["tournament_events.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_tournament_event_reservations"),
        sa.UniqueConstraint(
            "event_id", "id", name="uq_tournament_event_reservations_event_id_id"
        ),
        sa.UniqueConstraint(
            "event_id",
            "position",
            deferrable=True,
            initially="DEFERRED",
            name="uq_tournament_event_reservations_event_id_position",
        ),
    )
    op.create_table(
        "tournament_event_stages",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("draw_type_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["draw_type_id"], ["draw_types.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["event_id"], ["tournament_events.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "event_id", "id", name="uq_tournament_event_stages_event_id_id"
        ),
        sa.UniqueConstraint(
            "event_id", "position", name="uq_tournament_event_stages_event_id_position"
        ),
    )
    op.create_table(
        "tournament_event_reservation_tables",
        sa.Column("tournament_id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("reservation_id", sa.UUID(), nullable=False),
        sa.Column("table_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["event_id", "reservation_id"],
            [
                "tournament_event_reservations.event_id",
                "tournament_event_reservations.id",
            ],
            name="fk_tournament_event_reservation_tables_event_id_reservation_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id", "event_id"],
            ["tournament_events.tournament_id", "tournament_events.id"],
            name="fk_tournament_event_reservation_tables_tournament_id_event_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id", "table_id"],
            ["tournament_tables.tournament_id", "tournament_tables.id"],
            name="fk_tournament_event_reservation_tables_tournament_id_table_id",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "event_id",
            "reservation_id",
            "table_id",
            name="pk_tournament_event_reservation_tables",
        ),
        sa.UniqueConstraint(
            "event_id",
            "reservation_id",
            "position",
            deferrable=True,
            initially="DEFERRED",
            name="uq_tournament_event_reservation_tables_reservation_position",
        ),
    )
    op.create_index(
        "ix_tournament_event_reservation_tables_tournament_id_table_id",
        "tournament_event_reservation_tables",
        ["tournament_id", "table_id"],
        unique=False,
    )
    op.create_table(
        "tournament_event_stage_groups",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("stage_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["stage_id"], ["tournament_event_stages.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_tournament_event_stage_groups"),
        sa.UniqueConstraint(
            "stage_id", "id", name="uq_tournament_event_stage_groups_stage_id_id"
        ),
        sa.UniqueConstraint(
            "stage_id",
            "position",
            deferrable=True,
            initially="DEFERRED",
            name="uq_tournament_event_stage_groups_stage_id_position",
        ),
    )
    op.create_table(
        "tournament_event_group_reservations",
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.Column("stage_id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("reservation_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["event_id", "reservation_id"],
            [
                "tournament_event_reservations.event_id",
                "tournament_event_reservations.id",
            ],
            name="fk_tournament_event_group_reservations_event_id_reservation_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["event_id", "stage_id"],
            ["tournament_event_stages.event_id", "tournament_event_stages.id"],
            name="fk_tournament_event_group_reservations_event_id_stage_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["stage_id", "group_id"],
            [
                "tournament_event_stage_groups.stage_id",
                "tournament_event_stage_groups.id",
            ],
            name="fk_tournament_event_group_reservations_stage_id_group_id",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "group_id", name="pk_tournament_event_group_reservations"
        ),
    )
    op.create_index(
        "ix_tournament_event_group_reservations_event_id_reservation_id",
        "tournament_event_group_reservations",
        ["event_id", "reservation_id"],
        unique=False,
    )
    op.create_index(
        "ix_tournament_event_group_reservations_event_id_stage_id",
        "tournament_event_group_reservations",
        ["event_id", "stage_id"],
        unique=False,
    )
    op.create_unique_constraint(
        "uq_tournament_entries_event_id_id", "tournament_entries", ["event_id", "id"]
    )
    op.create_table(
        "tournament_fixtures",
        sa.CheckConstraint(
            "winner_entry_id IS NULL OR (entry_a_id IS NOT NULL "
            "AND entry_b_id IS NOT NULL "
            "AND winner_entry_id IN (entry_a_id, entry_b_id))",
            name="ck_fixture_valid_winner",
        ),
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("scope_tournament_id", sa.UUID(), nullable=False),
        sa.Column("scope_event_id", sa.UUID(), nullable=False),
        sa.Column("stage_id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.Column("round", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("entry_a_id", sa.UUID(), nullable=True),
        sa.Column("entry_b_id", sa.UUID(), nullable=True),
        sa.Column("winner_entry_id", sa.UUID(), nullable=True),
        sa.Column("match_id", sa.UUID(), nullable=True),
        sa.Column("table_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("scheduled_start", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "call_notified_count",
            sa.Integer(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["entry_a_id"], ["tournament_entries.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["entry_b_id"], ["tournament_entries.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["match_id"], ["matches.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["stage_id", "group_id"],
            [
                "tournament_event_stage_groups.stage_id",
                "tournament_event_stage_groups.id",
            ],
            name="fk_tournament_fixtures_stage_id_group_id",
            initially="DEFERRED",
            deferrable=True,
        ),
        sa.ForeignKeyConstraint(
            ["table_id"], ["tournament_tables.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["winner_entry_id"], ["tournament_entries.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["scope_event_id", "stage_id"],
            ["tournament_event_stages.event_id", "tournament_event_stages.id"],
            name="fk_fixture_event_stage",
            ondelete="CASCADE",
            deferrable=True,
            initially="DEFERRED",
        ),
        sa.ForeignKeyConstraint(
            ["scope_event_id", "entry_a_id"],
            ["tournament_entries.event_id", "tournament_entries.id"],
            name="fk_fixture_event_entry_a",
            deferrable=True,
            initially="DEFERRED",
        ),
        sa.ForeignKeyConstraint(
            ["scope_event_id", "entry_b_id"],
            ["tournament_entries.event_id", "tournament_entries.id"],
            name="fk_fixture_event_entry_b",
            deferrable=True,
            initially="DEFERRED",
        ),
        sa.ForeignKeyConstraint(
            ["scope_tournament_id", "scope_event_id"],
            ["tournament_events.tournament_id", "tournament_events.id"],
            name="fk_fixture_tournament_event",
            deferrable=True,
            initially="DEFERRED",
        ),
        sa.ForeignKeyConstraint(
            ["scope_tournament_id", "table_id"],
            ["tournament_tables.tournament_id", "tournament_tables.id"],
            name="fk_fixture_tournament_table",
            deferrable=True,
            initially="DEFERRED",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "stage_id",
            "group_id",
            "round",
            "position",
            name="uq_tournament_fixtures_stage_id_group_id_round_position",
        ),
        sa.CheckConstraint(
            "entry_a_id <> entry_b_id",
            name="ck_tournament_fixtures_distinct_entries",
        ),
    )
    op.create_index(
        "ix_tournament_fixtures_match_id",
        "tournament_fixtures",
        ["match_id"],
        unique=True,
    )
    op.create_index(
        "ix_tournament_fixtures_stage_id",
        "tournament_fixtures",
        ["stage_id"],
        unique=False,
    )
    op.create_index(
        "ix_tournament_fixtures_table_id",
        "tournament_fixtures",
        ["table_id"],
        unique=False,
    )
    # ### end Alembic commands ###
    op.bulk_insert(
        sa.table(
            "rating_strategies",
            sa.column("id", sa.UUID()),
            sa.column("key", sa.String()),
            sa.column("name", sa.String()),
            sa.column("description", sa.Text()),
            sa.column("state_schema", postgresql.JSONB()),
            sa.column("initial_state", postgresql.JSONB()),
            sa.column("initial_rating_value", sa.Float()),
            sa.column("is_automatic", sa.Boolean()),
        ),
        [
            {
                "description": "Glicko-2 — tracks both skill (rating) and "
                "uncertainty (RD + "
                "volatility). Updated automatically on each rated match.",
                "id": UUID("11111111-1111-1111-1111-111111110001"),
                "initial_rating_value": 1500.0,
                "initial_state": {"rating": 1500.0, "rd": 350.0, "volatility": 0.06},
                "is_automatic": True,
                "key": "glicko2",
                "name": "Glicko-2",
                "state_schema": {
                    "additionalProperties": False,
                    "properties": {
                        "rating": {"type": "number"},
                        "rd": {"type": "number"},
                        "volatility": {"type": "number"},
                    },
                    "required": ["rating", "rd", "volatility"],
                    "type": "object",
                },
            },
            {
                "description": "Ratings supplied externally (e.g. USATT) or by "
                "admin entry. Match "
                "completion does not change ratings in a manual league.",
                "id": UUID("11111111-1111-1111-1111-111111110002"),
                "initial_rating_value": None,
                "initial_state": None,
                "is_automatic": False,
                "key": "manual",
                "name": "Manual / external",
                "state_schema": {
                    "additionalProperties": False,
                    "properties": {"rating": {"type": "number"}},
                    "required": ["rating"],
                    "type": "object",
                },
            },
        ],
    )

    op.bulk_insert(
        sa.table(
            "notification_types",
            sa.column("id", sa.UUID()),
            sa.column("key", sa.String()),
            sa.column("name", sa.String()),
            sa.column("short_label", sa.String()),
            sa.column("display_order", sa.Integer()),
            sa.column("is_active", sa.Boolean()),
        ),
        [
            {
                "display_order": 1,
                "id": UUID("33333333-3333-3333-3333-333333330001"),
                "is_active": True,
                "key": "match_reminder",
                "name": "Match reminders",
                "short_label": "Match",
            },
            {
                "display_order": 2,
                "id": UUID("33333333-3333-3333-3333-333333330002"),
                "is_active": True,
                "key": "rating_change",
                "name": "Rating changes",
                "short_label": "Rating",
            },
            {
                "display_order": 3,
                "id": UUID("33333333-3333-3333-3333-333333330003"),
                "is_active": True,
                "key": "tournament",
                "name": "Tournament news",
                "short_label": "Tourney",
            },
            {
                "display_order": 4,
                "id": UUID("33333333-3333-3333-3333-333333330004"),
                "is_active": True,
                "key": "opponent",
                "name": "Challenges & friends",
                "short_label": "Social",
            },
            {
                "display_order": 5,
                "id": UUID("33333333-3333-3333-3333-333333330005"),
                "is_active": True,
                "key": "result_confirm",
                "name": "Score acceptances",
                "short_label": "Scores",
            },
            {
                "display_order": 6,
                "id": UUID("33333333-3333-3333-3333-333333330006"),
                "is_active": True,
                "key": "match_calls",
                "name": "Match calls",
                "short_label": "Calls",
            },
        ],
    )

    op.bulk_insert(
        sa.table(
            "notification_channels",
            sa.column("id", sa.UUID()),
            sa.column("key", sa.String()),
            sa.column("name", sa.String()),
            sa.column("display_order", sa.Integer()),
            sa.column("is_active", sa.Boolean()),
            sa.column("is_available", sa.Boolean()),
        ),
        [
            {
                "display_order": 1,
                "id": UUID("44444444-4444-4444-4444-444444440001"),
                "is_active": True,
                "is_available": True,
                "key": "in_app",
                "name": "In-app",
            },
            {
                "display_order": 2,
                "id": UUID("44444444-4444-4444-4444-444444440002"),
                "is_active": True,
                "is_available": True,
                "key": "push",
                "name": "Push",
            },
            {
                "display_order": 3,
                "id": UUID("44444444-4444-4444-4444-444444440003"),
                "is_active": True,
                "is_available": True,
                "key": "email",
                "name": "Email",
            },
            {
                "display_order": 4,
                "id": UUID("44444444-4444-4444-4444-444444440004"),
                "is_active": True,
                "is_available": False,
                "key": "sms",
                "name": "SMS",
            },
        ],
    )

    op.bulk_insert(
        sa.table(
            "draw_types",
            sa.column("id", sa.UUID()),
            sa.column("key", sa.String()),
            sa.column("name", sa.String()),
            sa.column("description", sa.Text()),
            sa.column("display_order", sa.Integer()),
        ),
        [
            {
                "description": "Everyone in a group plays everyone else in that "
                "group. Every entrant "
                "is guaranteed the same number of matches and the final standings "
                "rank the whole field, so it is the fairest read on form — but the "
                "match count climbs quickly with group size, and the event needs at "
                "least one group.",
                "display_order": 1,
                "id": UUID("22222222-2222-2222-2222-222222220001"),
                "key": "round-robin",
                "name": "Round robin",
            },
            {
                "description": "A knockout bracket: lose once and you are out. It "
                "crowns a champion "
                "in the fewest matches and the least table time, which suits a large "
                "field or a tight schedule — but half the entrants are finished after "
                "one match, and a field that is not a power of two gives the top "
                "seeds byes.",
                "display_order": 2,
                "id": UUID("22222222-2222-2222-2222-222222220002"),
                "key": "single-elim",
                "name": "Single elimination",
            },
            {
                "description": "Groups play all-play-all, then the top finishers "
                "from each group "
                "meet in a knockout bracket.",
                "display_order": 3,
                "id": UUID("22222222-2222-2222-2222-222222220003"),
                "key": "rr-then-ko",
                "name": "Round-robin then knockout",
            },
            {
                "description": "A fixed number of rounds, each pairing entrants "
                "who are on similar "
                "scores. Nobody is eliminated and everybody plays every round, so a "
                "large field is ranked in far fewer matches than a round robin — but "
                "a round's pairings are only known once the round before it has "
                "finished, and a long event may repeat a pairing.",
                "display_order": 4,
                "id": UUID("22222222-2222-2222-2222-222222220004"),
                "key": "swiss",
                "name": "Swiss",
            },
        ],
    )

    op.create_table(
        "tournament_entry_members",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("entry_id", sa.UUID(), nullable=False),
        sa.Column("player_id", sa.UUID(), nullable=False),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("joined_by_account_id", sa.UUID(), nullable=True),
        sa.Column("left_by_account_id", sa.UUID(), nullable=True),
        sa.CheckConstraint(
            "left_at IS NULL OR left_at >= joined_at",
            name="ck_tournament_entry_members_interval",
        ),
        sa.CheckConstraint(
            "(left_at IS NULL) = (left_by_account_id IS NULL)",
            name="ck_tournament_entry_members_departure_attribution",
        ),
        sa.ForeignKeyConstraint(
            ["entry_id"], ["tournament_entries.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["joined_by_account_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["left_by_account_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["player_id"], ["players.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_tournament_entry_members_entry_id",
        "tournament_entry_members",
        ["entry_id"],
        unique=False,
    )
    op.create_index(
        "ix_tournament_entry_members_joined_by_account_id",
        "tournament_entry_members",
        ["joined_by_account_id"],
        unique=False,
    )
    op.create_index(
        "ix_tournament_entry_members_left_by_account_id",
        "tournament_entry_members",
        ["left_by_account_id"],
        unique=False,
    )
    op.create_index(
        "ix_tournament_entry_members_player_id",
        "tournament_entry_members",
        ["player_id"],
        unique=False,
    )
    op.create_index(
        "uq_tournament_entry_members_current_player",
        "tournament_entry_members",
        ["entry_id", "player_id"],
        unique=True,
        postgresql_where=sa.text("left_at IS NULL"),
    )
    op.create_table(
        "match_lineups",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("match_id", sa.UUID(), nullable=False),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column(
            "revision", sa.Integer(), server_default=sa.text("1"), nullable=False
        ),
        sa.Column(
            "recorded_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column(
            "recorded_transaction_id",
            sa.BigInteger(),
            server_default=sa.text("txid_current()"),
            nullable=False,
        ),
        sa.Column("recorded_by_account_id", sa.UUID(), nullable=True),
        sa.Column("correction_reason", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "(revision = 1 AND correction_reason IS NULL) OR (revision > 1 "
            "AND recorded_by_account_id IS NOT NULL "
            "AND correction_reason IS NOT NULL "
            "AND length(trim(correction_reason)) > 0)",
            name="ck_match_lineups_correction_audit",
        ),
        sa.CheckConstraint("revision > 0", name="ck_match_lineups_revision"),
        sa.ForeignKeyConstraint(["match_id"], ["matches.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["recorded_by_account_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("match_id", "revision", name="uq_match_lineups_revision"),
        sa.CheckConstraint(
            "started_at <= recorded_at", name="ck_match_lineups_chronology"
        ),
    )
    op.create_index(
        "ix_match_lineups_match_id", "match_lineups", ["match_id"], unique=False
    )
    op.create_index(
        "ix_match_lineups_recorded_by_account_id",
        "match_lineups",
        ["recorded_by_account_id"],
        unique=False,
    )
    op.create_table(
        "match_lineup_players",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("lineup_id", sa.UUID(), nullable=False),
        sa.Column("side_number", sa.SmallInteger(), nullable=False),
        sa.Column("entry_member_id", sa.UUID(), nullable=False),
        sa.Column("player_id", sa.UUID(), nullable=False),
        sa.CheckConstraint(
            "side_number IN (1, 2)", name="ck_match_lineup_players_side"
        ),
        sa.ForeignKeyConstraint(
            ["entry_member_id"], ["tournament_entry_members.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["lineup_id"], ["match_lineups.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["player_id"], ["players.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "lineup_id", "player_id", name="uq_match_lineup_players_player"
        ),
    )
    op.create_index(
        "ix_match_lineup_players_entry_member_id",
        "match_lineup_players",
        ["entry_member_id"],
        unique=False,
    )
    op.create_index(
        "ix_match_lineup_players_lineup_id",
        "match_lineup_players",
        ["lineup_id"],
        unique=False,
    )
    op.create_index(
        "ix_match_lineup_players_player_id",
        "match_lineup_players",
        ["player_id"],
        unique=False,
    )
    for statement in FIXTURE_INTEGRITY_DDL:
        op.execute(statement)
    for statement in ENTRY_INTEGRITY_DDL:
        op.execute(statement)


def downgrade() -> None:
    # These functions and their dependent triggers belong to this baseline.
    # Remove them before the table row types referenced by their bodies.
    for signature in (
        "fixture_scope()",
        "check_match_ending()",
        "authorize_entry_membership()",
        "check_match_lineup()",
        "preserve_match_lineup()",
        "capture_match_lineup()",
        "reset_pristine_match_lineup()",
        "check_pristine_match_reset()",
        "preserve_entry_membership()",
        "lock_entry_event()",
        "lock_fixture_link()",
        "preserve_match_topology()",
        "check_entry_event()",
        "entry_single_player(uuid)",
        "entry_canonical_player(uuid)",
    ):
        op.execute(f"DROP FUNCTION IF EXISTS {signature} CASCADE")
    op.drop_table("match_lineup_players")
    op.drop_table("match_lineups")
    op.drop_table("tournament_entry_members")
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_index("ix_tournament_fixtures_table_id", table_name="tournament_fixtures")
    op.drop_index("ix_tournament_fixtures_stage_id", table_name="tournament_fixtures")
    op.drop_index("ix_tournament_fixtures_match_id", table_name="tournament_fixtures")
    op.drop_table("tournament_fixtures")
    op.drop_index(
        "ix_tournament_event_group_reservations_event_id_stage_id",
        table_name="tournament_event_group_reservations",
    )
    op.drop_index(
        "ix_tournament_event_group_reservations_event_id_reservation_id",
        table_name="tournament_event_group_reservations",
    )
    op.drop_table("tournament_event_group_reservations")
    op.drop_table("tournament_event_stage_groups")
    op.drop_index(
        "ix_tournament_event_reservation_tables_tournament_id_table_id",
        table_name="tournament_event_reservation_tables",
    )
    op.drop_table("tournament_event_reservation_tables")
    op.drop_table("tournament_event_stages")
    op.drop_table("tournament_event_reservations")
    op.drop_index("ix_tournament_entries_event_id", table_name="tournament_entries")
    op.drop_index(
        "ix_tournament_entries_added_by_user_id", table_name="tournament_entries"
    )
    op.drop_table("tournament_entries")
    op.drop_index("ix_notifications_user_id_created_at", table_name="notifications")
    op.drop_index("ix_notifications_result_id", table_name="notifications")
    op.drop_table("notifications")
    op.drop_index("ix_match_side_players_user_id", table_name="match_side_players")
    op.drop_index(
        "ix_match_side_players_match_side_id", table_name="match_side_players"
    )
    op.drop_table("match_side_players")
    op.drop_table("match_game_scores")
    op.drop_index(
        "ix_tournament_tables_tournament_id_position", table_name="tournament_tables"
    )
    op.drop_table("tournament_tables")
    op.drop_index(
        "ix_tournament_events_tournament_id_created_at", table_name="tournament_events"
    )
    op.drop_index(
        op.f("ix_tournament_events_draw_settings_id"), table_name="tournament_events"
    )
    op.drop_table("tournament_events")
    op.drop_index(
        "ix_schedule_solves_tournament_id_requested_at", table_name="schedule_solves"
    )
    op.drop_table("schedule_solves")
    op.drop_index(
        "uq_rating_history_match_id_user_id",
        table_name="rating_history",
        postgresql_where=sa.text("match_id IS NOT NULL"),
    )
    op.drop_index("ix_rating_history_match_id", table_name="rating_history")
    op.drop_index(
        "ix_rating_history_league_id_user_id_created_at", table_name="rating_history"
    )
    op.drop_table("rating_history")
    op.drop_index("ix_match_sides_match_id", table_name="match_sides")
    op.drop_table("match_sides")
    op.drop_index("ix_match_results_match_id", table_name="match_results")
    op.drop_table("match_results")
    op.drop_index("ix_match_games_match_id", table_name="match_games")
    op.drop_table("match_games")
    op.drop_index("ix_user_league_ratings_user_id", table_name="user_league_ratings")
    op.drop_table("user_league_ratings")
    op.drop_index(op.f("ix_tournaments_owner_account_id"), table_name="tournaments")
    op.drop_index(
        "ix_tournaments_created_by_user_id_created_at", table_name="tournaments"
    )
    op.drop_table("tournaments")
    op.drop_index("ix_matches_status_updated_at", table_name="matches")
    op.drop_index("ix_matches_status_created_at", table_name="matches")
    op.drop_index("ix_matches_status_completed_at", table_name="matches")
    op.drop_index("ix_matches_league_id", table_name="matches")
    op.drop_index("ix_matches_created_by_user_id_created_at", table_name="matches")
    op.drop_table("matches")
    op.drop_index("ix_league_memberships_user_id", table_name="league_memberships")
    op.drop_table("league_memberships")
    op.drop_index(op.f("ix_user_tokens_user_id"), table_name="user_tokens")
    op.drop_index(op.f("ix_user_tokens_token"), table_name="user_tokens")
    op.drop_index(
        "ix_user_tokens_replaced_pending_email",
        table_name="user_tokens",
        postgresql_where=sa.text(
            "replaced_at IS NOT NULL AND (context LIKE 'change:%' OR "
            "context LIKE 'merge:%')"
        ),
    )
    op.drop_table("user_tokens")
    op.drop_table("user_roles")
    op.drop_table("tournament_event_draw_settings")
    op.drop_table("role_permissions")
    op.drop_table("notification_preferences")
    op.drop_table("notification_channel_settings")
    op.drop_index(op.f("ix_login_identities_account_id"), table_name="login_identities")
    op.drop_table("login_identities")
    op.drop_index(
        "uq_leagues_one_default",
        table_name="leagues",
        postgresql_where=sa.text("is_default"),
    )
    op.drop_index(op.f("ix_leagues_rating_strategy_id"), table_name="leagues")
    op.drop_index(op.f("ix_leagues_name"), table_name="leagues")
    op.drop_table("leagues")
    op.drop_index(op.f("ix_device_tokens_user_id"), table_name="device_tokens")
    op.drop_table("device_tokens")
    op.drop_index(
        "uq_account_players_primary",
        table_name="account_players",
        postgresql_where=sa.text("is_primary"),
    )
    op.drop_table("account_players")
    op.drop_index(op.f("ix_roles_name"), table_name="roles")
    op.drop_table("roles")
    op.drop_index(op.f("ix_rating_strategies_key"), table_name="rating_strategies")
    op.drop_table("rating_strategies")
    op.drop_index(op.f("ix_players_username"), table_name="players")
    op.drop_index(op.f("ix_players_merged_into_player_id"), table_name="players")
    op.drop_table("players")
    op.drop_index(op.f("ix_permissions_name"), table_name="permissions")
    op.drop_table("permissions")
    op.drop_index(op.f("ix_notification_types_key"), table_name="notification_types")
    op.drop_table("notification_types")
    op.drop_index(
        op.f("ix_notification_channels_key"), table_name="notification_channels"
    )
    op.drop_table("notification_channels")
    op.drop_table("match_settings")
    op.drop_table("draw_types")
    op.drop_index(op.f("ix_accounts_merged_into_user_id"), table_name="accounts")
    op.drop_index(op.f("ix_accounts_email"), table_name="accounts")
    op.drop_table("accounts")
    # ### end Alembic commands ###
    postgresql.ENUM(name="event_format").drop(op.get_bind(), checkfirst=True)

    postgresql.ENUM(name="league_visibility").drop(op.get_bind(), checkfirst=True)

    postgresql.ENUM(name="match_status").drop(op.get_bind(), checkfirst=True)
    postgresql.ENUM(name="match_ending").drop(op.get_bind(), checkfirst=True)

    postgresql.ENUM(name="rating_history_source").drop(op.get_bind(), checkfirst=True)

    postgresql.ENUM(name="schedule_solve_status").drop(op.get_bind(), checkfirst=True)

    postgresql.ENUM(name="schedule_solve_trigger").drop(op.get_bind(), checkfirst=True)

    postgresql.ENUM(name="solver_verdict").drop(op.get_bind(), checkfirst=True)

    postgresql.ENUM(name="tournament_entry_status").drop(op.get_bind(), checkfirst=True)

    postgresql.ENUM(name="tournament_status").drop(op.get_bind(), checkfirst=True)

    postgresql.ENUM(name="verification_policy").drop(op.get_bind(), checkfirst=True)

    # Dropping tables removes their triggers, but not their function definitions.
    for function in (
        "guard_proposal_insert",
        "guard_proposal_update",
        "prevent_proposal_delete",
        "apply_player_merge_to_proposals",
        "preserve_player_merge",
    ):
        op.execute(f"DROP FUNCTION {function}()")
