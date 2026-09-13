"""Fresh pre-beta baseline: accounts, durable players, sporting history.

Pre-beta databases are disposable. This revision replaces the previous chain;
there is intentionally no legacy-data upgrade or ID backfill.
"""

from uuid import UUID

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

AUTHORITY_INTEGRITY_DDL = (
    """
    CREATE FUNCTION tournament_can_direct(tournament_uuid uuid, account_uuid uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
            SELECT 1 FROM tournaments t JOIN accounts a ON a.id = account_uuid
            WHERE t.id = tournament_uuid AND a.merged_at IS NULL
                AND a.deactivated_at IS NULL AND a.erased_at IS NULL
                AND (t.owner_account_id = account_uuid OR EXISTS (
                    SELECT 1 FROM tournament_account_grants g
                    WHERE g.tournament_id = t.id AND g.account_id = account_uuid
                        AND g.role = 'director' AND g.revoked_at IS NULL
                ))
        )
    $$
    """,
    """
    CREATE FUNCTION check_tournament_grant_origin() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        BEGIN
            PERFORM id FROM accounts
            -- The original grantor is immutable history on UPDATE. Only INSERT
            -- creates that FK; later authority changes must not lock its Account.
            WHERE id IN (NEW.account_id, NEW.revoked_by_account_id,
                CASE WHEN TG_OP = 'INSERT' THEN NEW.granted_by_account_id END)
            ORDER BY id FOR KEY SHARE NOWAIT;
            PERFORM id FROM tournaments WHERE id = NEW.tournament_id FOR UPDATE NOWAIT;
        EXCEPTION WHEN lock_not_available THEN
            RAISE EXCEPTION 'authority changes require parent locks; retry'
                USING ERRCODE = '40001';
        END;
        IF TG_OP = 'INSERT' AND NOT EXISTS (
            SELECT 1 FROM accounts WHERE id = NEW.account_id AND merged_at IS NULL
                AND deactivated_at IS NULL AND erased_at IS NULL
        ) THEN
            RAISE EXCEPTION 'authority recipient must be active'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.inherited_from_grant_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM tournament_account_grants g
            WHERE g.id = NEW.inherited_from_grant_id
                AND g.tournament_id = NEW.tournament_id
                AND g.role = NEW.role AND g.account_id <> NEW.account_id
                AND g.revocation_reason = 'account_merge' AND g.revoked_at IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'inherited grant requires matching revoked source authority'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER check_tournament_grant_origin BEFORE INSERT OR UPDATE
    ON tournament_account_grants
    FOR EACH ROW EXECUTE FUNCTION check_tournament_grant_origin()
    """,
    """
    CREATE FUNCTION prepare_tournament_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE parent tournaments;
    BEGIN
        BEGIN
            PERFORM id FROM accounts
            WHERE id IN (NEW.previous_owner_account_id, NEW.new_owner_account_id,
                NEW.actor_account_id) ORDER BY id FOR KEY SHARE NOWAIT;
            SELECT * INTO parent FROM tournaments WHERE id = NEW.tournament_id
                FOR UPDATE NOWAIT;
        EXCEPTION WHEN lock_not_available THEN
            RAISE EXCEPTION 'ownership transfer requires parent locks; retry'
                USING ERRCODE = '40001';
        END;
        IF parent.id IS NULL
            OR parent.owner_account_id IS DISTINCT FROM NEW.previous_owner_account_id
            OR (NEW.revision IS NOT NULL
                AND NEW.revision <> parent.ownership_revision + 1) THEN
            RAISE EXCEPTION 'transfer must follow current ownership'
                USING ERRCODE = '23514';
        END IF;
        NEW.revision := parent.ownership_revision + 1;
        NEW.transferred_at := clock_timestamp();
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER prepare_tournament_transfer BEFORE INSERT
    ON tournament_ownership_transfers
    FOR EACH ROW EXECUTE FUNCTION prepare_tournament_transfer()
    """,
    """
    CREATE FUNCTION apply_tournament_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        UPDATE tournaments SET owner_account_id = NEW.new_owner_account_id,
            ownership_revision = NEW.revision WHERE id = NEW.tournament_id;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER apply_tournament_transfer AFTER INSERT
    ON tournament_ownership_transfers
    FOR EACH ROW EXECUTE FUNCTION apply_tournament_transfer()
    """,
    """
    CREATE FUNCTION preserve_tournament_creator() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'INSERT' THEN
            IF NEW.ownership_revision <> 0 THEN
                RAISE EXCEPTION 'initial ownership revision must be zero'
                    USING ERRCODE = '23514';
            END IF;
            NEW.owner_account_id := COALESCE(
                NEW.owner_account_id, NEW.created_by_user_id);
        ELSIF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
            RAISE EXCEPTION 'tournament creator is immutable' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' THEN
            IF NEW.owner_account_id IS DISTINCT FROM OLD.owner_account_id THEN
                IF NEW.ownership_revision <> OLD.ownership_revision + 1
                    OR NOT EXISTS (
                        SELECT 1 FROM tournament_ownership_transfers h
                        WHERE h.tournament_id = OLD.id
                            AND h.revision = NEW.ownership_revision
                            AND h.previous_owner_account_id = OLD.owner_account_id
                            AND h.new_owner_account_id = NEW.owner_account_id
                    ) THEN
                    RAISE EXCEPTION 'owner changes require a fresh transfer'
                        USING ERRCODE = '23514';
                END IF;
            ELSIF NEW.ownership_revision IS DISTINCT FROM OLD.ownership_revision THEN
                RAISE EXCEPTION 'ownership revision changes require a new owner'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF TG_OP = 'INSERT'
            OR NEW.owner_account_id IS DISTINCT FROM OLD.owner_account_id THEN
            BEGIN
                PERFORM id FROM accounts WHERE id = NEW.owner_account_id
                    FOR KEY SHARE NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION 'ownership changes require account locks; retry'
                    USING ERRCODE = '40001';
            END;
            IF NOT EXISTS (SELECT 1 FROM accounts
                WHERE id = NEW.owner_account_id AND merged_at IS NULL
                    AND deactivated_at IS NULL AND erased_at IS NULL) THEN
                RAISE EXCEPTION 'owner must be active' USING ERRCODE = '23514';
            END IF;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_tournament_creator BEFORE INSERT OR UPDATE ON tournaments
    FOR EACH ROW EXECUTE FUNCTION preserve_tournament_creator()
    """,
    """
    CREATE FUNCTION preserve_tournament_authority() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'DELETE' THEN
            IF EXISTS (SELECT 1 FROM tournaments WHERE id = OLD.tournament_id) THEN
                RAISE EXCEPTION 'authority history is retained with its tournament'
                    USING ERRCODE = '23514';
            END IF;
            RETURN OLD;
        END IF;
        IF TG_TABLE_NAME = 'tournament_ownership_transfers' THEN
            RAISE EXCEPTION 'ownership transfer history is immutable'
                USING ERRCODE = '23514';
        END IF;
        IF (to_jsonb(NEW) - ARRAY[
            'revoked_at', 'revoked_by_account_id', 'revocation_reason'])
            IS DISTINCT FROM
            (to_jsonb(OLD) - ARRAY[
                'revoked_at', 'revoked_by_account_id', 'revocation_reason'])
            OR (OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
            RAISE EXCEPTION 'grant attribution and completed revocations are immutable'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_tournament_grant BEFORE UPDATE OR DELETE
    ON tournament_account_grants
    FOR EACH ROW EXECUTE FUNCTION preserve_tournament_authority()
    """,
    """
    CREATE TRIGGER preserve_tournament_transfer BEFORE UPDATE OR DELETE
    ON tournament_ownership_transfers
    FOR EACH ROW EXECUTE FUNCTION preserve_tournament_authority()
    """,
)

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
    CREATE TRIGGER fixture_scope BEFORE INSERT OR UPDATE OF
        stage_id, scope_event_id, scope_tournament_id ON tournament_fixtures
    FOR EACH ROW EXECUTE FUNCTION fixture_scope()
    """,
)

ENTRY_SUPERSESSION_DDL = (
    """
        CREATE OR REPLACE FUNCTION preserve_entry_supersession() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        IF TG_OP = 'UPDATE' AND OLD.superseded_by_entry_id IS NOT NULL AND
        NEW.superseded_by_entry_id IS DISTINCT FROM OLD.superseded_by_entry_id THEN
        RAISE EXCEPTION 'Entry supersession is permanent'
        USING ERRCODE = '23514' , CONSTRAINT = 'ck_entry_supersession_permanent' ;
        END IF;
        IF NEW.superseded_by_entry_id IS NOT NULL THEN
        -- Entry writers take their event lock before the child row. A direct
        -- writer that encounters contention retries in that parent-first order.
        BEGIN
        PERFORM id FROM tournament_events WHERE id = NEW.event_id
        FOR UPDATE NOWAIT;
        EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'Retry entry supersession with the event locked'
        USING ERRCODE = '40001' ;
        END;
        IF EXISTS (
        WITH RECURSIVE chain(id, next_id) AS (
        SELECT id, superseded_by_entry_id FROM tournament_entries
        WHERE id = NEW.superseded_by_entry_id
        UNION
        SELECT e.id, e.superseded_by_entry_id FROM tournament_entries e
        JOIN chain c ON e.id = c.next_id
        ) SELECT 1 FROM chain WHERE id = NEW.id OR next_id = NEW.id
        ) THEN
        RAISE EXCEPTION 'Entry supersession cannot form a cycle'
        USING ERRCODE = '23514' , CONSTRAINT = 'ck_entry_supersession_cycle' ;
        END IF;
        END IF;
        RETURN NEW;
        END $$
        """,
    """
        CREATE TRIGGER preserve_entry_supersession
        BEFORE INSERT OR UPDATE OF superseded_by_entry_id ON tournament_entries
        FOR EACH ROW EXECUTE FUNCTION preserve_entry_supersession()
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
    DECLARE tournament_uuid uuid; actor_uuid uuid;
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
        SELECT t.id INTO tournament_uuid FROM tournament_entries en
        JOIN tournament_events e ON e.id = en.event_id
        JOIN tournaments t ON t.id = e.tournament_id
        WHERE en.id = NEW.entry_id AND t.status IN ('live', 'archived')
            AND en.created_transaction_id <> txid_current();
        IF NOT FOUND THEN RETURN NEW; END IF;
        IF TG_OP = 'INSERT' THEN actor_uuid := NEW.joined_by_account_id;
        ELSIF NEW.left_at IS DISTINCT FROM OLD.left_at THEN actor_uuid :=
        NEW.left_by_account_id;
        ELSE RETURN NEW; END IF;
        IF NOT tournament_can_direct(tournament_uuid, actor_uuid)
            OR (TG_OP = 'INSERT' AND NEW.left_at IS NOT NULL
                AND NOT tournament_can_direct(tournament_uuid, NEW.left_by_account_id))
        THEN
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
    DECLARE lineup match_lineups; tournament_uuid uuid; fixture tournament_fixtures;
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
        SELECT t.id INTO tournament_uuid
        FROM tournament_fixtures f
        JOIN tournament_event_stages s ON s.id = f.stage_id
        JOIN tournament_events e ON e.id = s.event_id
        JOIN tournaments t ON t.id = e.tournament_id
        WHERE f.match_id = lineup.match_id;
        IF lineup.revision > 1 AND NOT tournament_can_direct(
            tournament_uuid, lineup.recorded_by_account_id)
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
            IF TG_OP = 'DELETE' THEN
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
        IF TG_TABLE_NAME IN ('match_games', 'match_results') THEN
            PERFORM t.id FROM tournaments t
            JOIN tournament_events e ON e.tournament_id = t.id
            WHERE e.id = event_uuid FOR SHARE OF t;
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
        IF TG_TABLE_NAME = 'matches' THEN
            IF OLD.status='pending' AND NEW.status='in_progress' AND EXISTS (
                SELECT 1 FROM tournament_events
                WHERE id=event_uuid AND lifecycle_state='cancelled'
            ) THEN
                RAISE EXCEPTION 'cancelled events cannot start matches'
                    USING ERRCODE = '23514';
            END IF;
        ELSIF TG_TABLE_NAME = 'match_lineups' THEN
            IF NOT EXISTS (SELECT 1 FROM match_lineups WHERE match_id=NEW.match_id)
                AND EXISTS (SELECT 1 FROM tournament_events
                    WHERE id=event_uuid AND lifecycle_state='cancelled') THEN
                RAISE EXCEPTION 'cancelled events cannot record a first lineup'
                    USING ERRCODE = '23514';
            END IF;
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
    DECLARE event_row RECORD; placement_only boolean := false;
    BEGIN
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
            THEN
                IF ROW(NEW.table_id, NEW.scheduled_start, NEW.pinned_at)
                    IS NOT DISTINCT FROM
                    ROW(OLD.table_id, OLD.scheduled_start, OLD.pinned_at) THEN
                    RETURN NEW;
                END IF;
                placement_only := true;
            END IF;
        END IF;
        PERFORM t.id FROM tournaments t
        JOIN tournament_events e ON e.tournament_id = t.id
        JOIN tournament_event_stages s ON s.event_id = e.id
        WHERE s.id IN (NEW.stage_id, OLD.stage_id)
        ORDER BY t.id FOR SHARE OF t NOWAIT;
        FOR event_row IN
            SELECT e.id, e.lifecycle_state FROM tournament_events e
            JOIN tournament_event_stages s ON s.event_id = e.id
            WHERE s.id IN (NEW.stage_id, OLD.stage_id)
            ORDER BY e.id FOR UPDATE OF e NOWAIT
        LOOP
            IF TG_OP <> 'INSERT' AND event_row.id=OLD.scope_event_id
                AND event_row.lifecycle_state='cancelled' THEN
                RAISE EXCEPTION 'cancelled event fixture must be retained'
                    USING ERRCODE = '23514';
            END IF;
            IF TG_OP <> 'DELETE' AND event_row.id=NEW.scope_event_id
                AND event_row.lifecycle_state='cancelled' THEN
                RAISE EXCEPTION 'cancelled events cannot accept fixtures'
                    USING ERRCODE = '23514';
            END IF;
        END LOOP;
        IF TG_OP <> 'INSERT' AND NOT placement_only THEN
            IF EXISTS (SELECT 1 FROM match_lineups WHERE match_id = OLD.match_id)
                OR EXISTS (SELECT 1 FROM match_games WHERE match_id = OLD.match_id)
                OR EXISTS (SELECT 1 FROM match_results WHERE match_id = OLD.match_id)
                OR EXISTS (SELECT 1 FROM tournament_event_recorded_games
                    WHERE match_id = OLD.match_id)
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
        round, position, scope_event_id, scope_tournament_id,
        table_id, scheduled_start, pinned_at
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


ADVANCEMENT_TABLE_DDL = (
    """
    CREATE TABLE fixture_advancement_decisions (
        event_id UUID NOT NULL REFERENCES tournament_events(id),
        id UUID DEFAULT gen_random_uuid() NOT NULL,
        fixture_id UUID NOT NULL,
        side VARCHAR NOT NULL,
        entry_id UUID NOT NULL,
        source_fixture_id UUID,
        source_group_id UUID,
        rule_version VARCHAR NOT NULL,
        rule_settings JSONB NOT NULL,
        evidence_count INTEGER DEFAULT 1 NOT NULL,
        revision INTEGER DEFAULT 1 NOT NULL,
        predecessor_id UUID,
        actor_account_id UUID,
        reason VARCHAR,
        unknown_reason VARCHAR,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT ck_advancement_not_self CHECK (id <> predecessor_id),
        CONSTRAINT ck_advancement_rule_settings CHECK ((source_group_id IS NULL AND rule_settings = '{}'::jsonb) OR (source_group_id IS NOT NULL AND (jsonb_typeof(rule_settings->'qualification_place') = 'number' AND (rule_settings->>'qualification_place') ~ '^[1-9][0-9]*$' AND jsonb_typeof(rule_settings->'qualifiers_per_group') = 'number' AND (rule_settings->>'qualifiers_per_group') ~ '^[1-9][0-9]*$' AND jsonb_typeof(rule_settings->'group_count') = 'number' AND (rule_settings->>'group_count') ~ '^[1-9][0-9]*$' AND jsonb_typeof(rule_settings->'group_index') = 'number' AND (rule_settings->>'group_index') ~ '^(0|[1-9][0-9]*)$' AND jsonb_typeof(rule_settings->'seed') = 'number' AND (rule_settings->>'seed') ~ '^[1-9][0-9]*$' AND rule_settings - ARRAY['qualification_place','qualifiers_per_group','group_count','group_index','seed'] = '{}'::jsonb) IS TRUE)),
        CONSTRAINT ck_advancement_provenance CHECK ((unknown_reason IS NOT NULL AND length(trim(unknown_reason)) > 0 AND source_fixture_id IS NULL AND source_group_id IS NULL AND evidence_count = 0 AND rule_version = 'unknown') OR (unknown_reason IS NULL AND num_nonnulls(source_fixture_id, source_group_id) = 1 AND evidence_count > 0 AND rule_version <> 'unknown')),
        CONSTRAINT ck_advancement_settings CHECK (jsonb_typeof(rule_settings) = 'object'),
        CONSTRAINT ck_advancement_replacement_actor CHECK (predecessor_id IS NULL OR (actor_account_id IS NOT NULL AND reason IS NOT NULL AND length(trim(reason)) > 0)),
        CONSTRAINT ck_advancement_evidence_count CHECK (evidence_count >= 0),
        CONSTRAINT ck_advancement_side CHECK (side IN ('a', 'b')),
        CONSTRAINT ck_advancement_rule CHECK (length(trim(rule_version)) > 0),
        CONSTRAINT ck_advancement_revision CHECK (revision >= 1 AND ((revision = 1) = (predecessor_id IS NULL))),
        CONSTRAINT uq_advancement_seat UNIQUE (id, fixture_id, side),
        CONSTRAINT uq_advancement_revision UNIQUE (fixture_id, side, revision),
        CONSTRAINT uq_advancement_successor UNIQUE (predecessor_id),
        CONSTRAINT fk_advancement_predecessor FOREIGN KEY(predecessor_id, fixture_id, side) REFERENCES fixture_advancement_decisions (id, fixture_id, side),
        FOREIGN KEY(fixture_id) REFERENCES tournament_fixtures (id),
        FOREIGN KEY(entry_id) REFERENCES tournament_entries (id),
        FOREIGN KEY(source_fixture_id) REFERENCES tournament_fixtures (id),
        FOREIGN KEY(source_group_id) REFERENCES tournament_event_stage_groups (id),
        FOREIGN KEY(actor_account_id) REFERENCES accounts (id)
    )
    """,
    """
    CREATE UNIQUE INDEX uq_advancement_root ON fixture_advancement_decisions (fixture_id, side) WHERE predecessor_id IS NULL
    """,
    "CREATE INDEX ix_fixture_advancement_decisions_event_id "
    "ON fixture_advancement_decisions (event_id)",
    "CREATE INDEX ix_fixture_entry_a_play_evidence ON tournament_fixtures (entry_a_id) "
    "WHERE match_id IS NOT NULL OR winner_entry_id IS NOT NULL",
    "CREATE INDEX ix_fixture_entry_b_play_evidence ON tournament_fixtures (entry_b_id) "
    "WHERE match_id IS NOT NULL OR winner_entry_id IS NOT NULL",
    "CREATE INDEX ix_fixture_event_play_evidence ON tournament_fixtures (scope_event_id) "
    "WHERE match_id IS NOT NULL OR winner_entry_id IS NOT NULL",
    """
    CREATE TABLE advancement_decision_evidence (
        decision_id UUID NOT NULL,
        match_id UUID NOT NULL,
        official_result_id UUID NOT NULL,
        PRIMARY KEY (decision_id, match_id),
        CONSTRAINT fk_advancement_evidence_result FOREIGN KEY(official_result_id, match_id) REFERENCES match_official_results (id, match_id),
        FOREIGN KEY(decision_id) REFERENCES fixture_advancement_decisions (id),
        FOREIGN KEY(match_id) REFERENCES matches (id)
    )
    """,
)

ADVANCEMENT_INTEGRITY_DDL = (
    """
    CREATE FUNCTION advancement_event_scope() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE fixture_event UUID;
    BEGIN
        SELECT scope_event_id INTO fixture_event FROM tournament_fixtures
            WHERE id = NEW.fixture_id;
        IF NEW.event_id IS NULL THEN NEW.event_id := fixture_event; END IF;
        IF NEW.event_id IS DISTINCT FROM fixture_event THEN
            RAISE EXCEPTION 'advancement event must match its target fixture' USING
                ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER advancement_event_scope BEFORE INSERT ON
        fixture_advancement_decisions
    FOR EACH ROW EXECUTE FUNCTION advancement_event_scope()
    """,
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
        IF decision.event_id IS DISTINCT FROM target.scope_event_id THEN
            RAISE EXCEPTION 'advancement event must match its target fixture' USING
                ERRCODE = '23514';
        END IF;
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


IDENTITY_RETENTION_DDL = (
    """
    CREATE FUNCTION preserve_retired_username() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF (OLD.retired_at IS NOT NULL OR NEW.retired_at IS NOT NULL)
            AND NEW.username IS DISTINCT FROM OLD.username THEN
            RAISE EXCEPTION 'retired Player username remains reserved'
                USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """CREATE TRIGGER preserve_retired_username BEFORE UPDATE OF username ON players
    FOR EACH ROW EXECUTE FUNCTION preserve_retired_username()""",
    """
    CREATE FUNCTION preserve_identity() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        RAISE EXCEPTION 'identities must be retained' USING ERRCODE='23514';
    END $$
    """,
    """CREATE TRIGGER preserve_account BEFORE DELETE ON accounts
    FOR EACH ROW EXECUTE FUNCTION preserve_identity()""",
    """CREATE TRIGGER preserve_player BEFORE DELETE ON players
    FOR EACH ROW EXECUTE FUNCTION preserve_identity()""",
    """
    CREATE FUNCTION preserve_account_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF (TG_OP = 'UPDATE' AND OLD.erased_at IS NOT NULL
            AND NEW.erased_at IS DISTINCT FROM OLD.erased_at)
            OR (NEW.erased_at IS NOT NULL AND (
                NEW.deactivated_at IS NULL OR NEW.email IS NOT NULL
                OR NEW.display_name <> 'Erased account'
                OR NEW.confirmed_at IS NOT NULL OR NEW.last_seen_at IS NOT NULL
                OR NEW.agent_access_linked_at IS NOT NULL
                OR NEW.agent_access_revoked_at IS NOT NULL
            )) THEN
            RAISE EXCEPTION 'erased identity must remain inert' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """CREATE TRIGGER preserve_account_erasure BEFORE INSERT OR UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION preserve_account_erasure()""",
    """
    CREATE FUNCTION check_erased_account_credentials() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF EXISTS (SELECT 1 FROM accounts WHERE id=NEW.id AND erased_at IS NOT NULL)
            AND (
                EXISTS (SELECT 1 FROM login_identities WHERE account_id=NEW.id)
                OR EXISTS (SELECT 1 FROM account_session_tokens WHERE user_id=NEW.id)
                OR EXISTS (SELECT 1 FROM account_email_tokens WHERE user_id=NEW.id
                    OR target_account_id=NEW.id OR guest_account_id=NEW.id)
                OR EXISTS (SELECT 1 FROM account_email_intents WHERE user_id=NEW.id
                    OR target_account_id=NEW.id)
                OR EXISTS (SELECT 1 FROM account_first_sign_in_intents
                    WHERE user_id=NEW.id)
                OR EXISTS (SELECT 1 FROM device_tokens WHERE user_id=NEW.id)
            ) THEN
            RAISE EXCEPTION 'erased account credentials must be removed'
                USING ERRCODE='23514';
        END IF;
        RETURN NULL;
    END $$
    """,
    """CREATE CONSTRAINT TRIGGER check_erased_account_credentials
    AFTER INSERT OR UPDATE ON accounts DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_erased_account_credentials()""",
    """
    CREATE FUNCTION revoke_deactivated_account_credentials() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        DELETE FROM account_session_tokens WHERE user_id=NEW.id;
        DELETE FROM account_email_tokens
            WHERE user_id=NEW.id OR target_account_id=NEW.id;
        DELETE FROM account_email_intents
            WHERE user_id=NEW.id OR target_account_id=NEW.id;
        DELETE FROM account_first_sign_in_intents WHERE user_id=NEW.id;
        RETURN NULL;
    END $$
    """,
    """CREATE TRIGGER revoke_deactivated_account_credentials
    AFTER UPDATE OF deactivated_at ON accounts
    FOR EACH ROW WHEN (OLD.deactivated_at IS NULL AND NEW.deactivated_at IS NOT NULL
        AND NEW.erased_at IS NULL)
    EXECUTE FUNCTION revoke_deactivated_account_credentials()""",
    """
    CREATE FUNCTION guard_erased_account_credential() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE account_row record;
    BEGIN
        -- SHARE conflicts with lifecycle non-key UPDATEs as well as the service
        -- FOR UPDATE lock. Ordinary FK KEY SHARE would allow the race.
        FOR account_row IN
            SELECT a.id, a.erased_at, a.deactivated_at FROM accounts a
            WHERE a.id IN (
                SELECT (to_jsonb(NEW)->>column_name)::uuid
                FROM unnest(TG_ARGV) AS column_name
            ) ORDER BY a.id FOR SHARE
        LOOP
            IF account_row.erased_at IS NOT NULL THEN
                RAISE EXCEPTION 'erased account credentials cannot be attached'
                    USING ERRCODE='23514';
            END IF;
            -- A foreign guest reference does not grant access to that guest.
            -- Login identities and device registrations survive deactivation.
            IF account_row.deactivated_at IS NOT NULL
                AND TG_TABLE_NAME IN ('account_session_tokens',
                    'account_email_tokens', 'account_email_intents',
                    'account_first_sign_in_intents')
                AND account_row.id IN (
                    (to_jsonb(NEW)->>'user_id')::uuid,
                    (to_jsonb(NEW)->>'target_account_id')::uuid
                ) THEN
                RAISE EXCEPTION 'inactive account credentials cannot be attached'
                    USING ERRCODE='23514';
            END IF;
        END LOOP;
        RETURN NEW;
    END $$
    """,
    """CREATE TRIGGER guard_erased_account_credential BEFORE INSERT OR UPDATE
    ON login_identities FOR EACH ROW
    EXECUTE FUNCTION guard_erased_account_credential('account_id')""",
    """CREATE TRIGGER guard_erased_account_credential BEFORE INSERT OR UPDATE
    ON account_session_tokens FOR EACH ROW
    EXECUTE FUNCTION guard_erased_account_credential('user_id')""",
    """CREATE TRIGGER guard_erased_account_credential BEFORE INSERT OR UPDATE
    ON account_email_tokens FOR EACH ROW
    EXECUTE FUNCTION guard_erased_account_credential(
        'user_id', 'target_account_id', 'guest_account_id')""",
    """CREATE TRIGGER guard_erased_account_credential BEFORE INSERT OR UPDATE
    ON account_email_intents FOR EACH ROW
    EXECUTE FUNCTION guard_erased_account_credential('user_id', 'target_account_id')""",
    """CREATE TRIGGER guard_erased_account_credential BEFORE INSERT OR UPDATE
    ON account_first_sign_in_intents FOR EACH ROW
    EXECUTE FUNCTION guard_erased_account_credential('user_id')""",
    """CREATE TRIGGER guard_erased_account_credential BEFORE INSERT OR UPDATE
    ON device_tokens FOR EACH ROW
    EXECUTE FUNCTION guard_erased_account_credential('user_id')""",
    """
    CREATE FUNCTION guard_retired_player_admission() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE player_row record;
    BEGIN
        IF NEW.left_at IS NOT NULL THEN RETURN NEW; END IF;
        IF TG_OP='UPDATE' AND (NEW.entry_id, NEW.player_id, NEW.left_at)
            IS NOT DISTINCT FROM (OLD.entry_id, OLD.player_id, OLD.left_at)
        THEN RETURN NEW; END IF;
        IF NOT EXISTS (SELECT 1 FROM tournament_entries
            WHERE id=NEW.entry_id AND status='entered') THEN RETURN NEW; END IF;
        FOR player_row IN SELECT id, retired_at FROM players
            WHERE id IN (NEW.player_id, entry_canonical_player(NEW.player_id))
            ORDER BY id FOR SHARE
        LOOP
            IF player_row.retired_at IS NOT NULL THEN
                RAISE EXCEPTION 'retired Player cannot be admitted'
                    USING ERRCODE='23514';
            END IF;
        END LOOP;
        RETURN NEW;
    END $$
    """,
    """CREATE TRIGGER guard_retired_player_admission BEFORE INSERT OR UPDATE
    ON tournament_entry_members FOR EACH ROW
    EXECUTE FUNCTION guard_retired_player_admission()""",
    """
    CREATE FUNCTION guard_retired_registration() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE player_row record;
    BEGIN
        -- Closing an existing registration never admits a Player.
        IF NEW.withdrawn_at IS NOT NULL THEN RETURN NEW; END IF;
        FOR player_row IN SELECT p.id, p.retired_at FROM players p
            WHERE p.id IN (
                SELECT entry_canonical_player(m.player_id)
                FROM tournament_entry_members m
                WHERE m.entry_id=NEW.entry_id AND m.left_at IS NULL
            ) ORDER BY p.id FOR SHARE
        LOOP
            IF player_row.retired_at IS NOT NULL THEN
                RAISE EXCEPTION 'retired Player cannot be admitted'
                    USING ERRCODE='23514';
            END IF;
        END LOOP;
        RETURN NEW;
    END $$
    """,
    """CREATE TRIGGER guard_retired_registration BEFORE INSERT
    ON tournament_entry_registrations FOR EACH ROW
    EXECUTE FUNCTION guard_retired_registration()""",
)


SPORTING_RETENTION_DDL = (
    """
    CREATE FUNCTION preserve_published_tournament() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'UPDATE' THEN
            IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
                RAISE EXCEPTION 'tournament publication history must be retained'
                    USING ERRCODE='23514';
            END IF;
            RETURN NEW;
        END IF;
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'only unused draft tournaments can be deleted'
                USING ERRCODE='23514';
        END IF;
        RETURN OLD;
    END $$
    """,
    """CREATE TRIGGER preserve_published_tournament
    BEFORE DELETE OR UPDATE OF status ON tournaments
    FOR EACH ROW EXECUTE FUNCTION preserve_published_tournament()""",
    """
    CREATE FUNCTION retain_match_play() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_match uuid; side_size integer; rated boolean;
        first_count integer; second_count integer;
    BEGIN
        IF TG_TABLE_NAME = 'match_results' THEN
            target_match := NEW.match_id;
        ELSE
            SELECT match_id INTO target_match FROM match_games
            WHERE id = NEW.match_game_id;
        END IF;
        PERFORM id FROM matches WHERE id=target_match FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM match_recorded_play WHERE match_id=target_match)
        THEN
            SELECT settings.team_size, settings.affects_rating INTO side_size, rated
            FROM matches m JOIN match_settings settings
                ON settings.id=m.match_settings_id
            WHERE m.id=target_match;
            SELECT count(*) FILTER (WHERE s.side_number=1),
                   count(*) FILTER (WHERE s.side_number=2)
            INTO first_count, second_count FROM match_side_players p
            JOIN match_sides s ON s.id=p.match_side_id WHERE p.match_id=target_match;
            IF (SELECT count(*) FROM match_sides WHERE match_id=target_match) <> 2
                OR first_count <> side_size
                OR (second_count <> side_size AND NOT
                    (side_size=1 AND second_count=0 AND NOT rated)) THEN
                RAISE EXCEPTION 'recorded play requires complete participants'
                    USING ERRCODE='23514';
            END IF;
        END IF;
        WITH recorded AS (
            INSERT INTO match_recorded_play(match_id)
            VALUES (target_match)
            ON CONFLICT DO NOTHING RETURNING match_id
        )
        INSERT INTO match_recorded_participants(match_id, side_number, player_id)
        SELECT p.match_id, s.side_number, p.user_id
        FROM recorded r JOIN match_side_players p ON p.match_id = r.match_id
        JOIN match_sides s ON s.id = p.match_side_id;
        RETURN NEW;
    END $$
    """,
    """CREATE TRIGGER retain_proposal_participants AFTER INSERT ON match_results
    FOR EACH ROW EXECUTE FUNCTION retain_match_play()""",
    """CREATE TRIGGER retain_match_play AFTER INSERT ON match_game_scores
    FOR EACH ROW EXECUTE FUNCTION retain_match_play()""",
    """
    CREATE FUNCTION preserve_match_play() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP <> 'INSERT' OR pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION 'recorded play history is immutable and database owned'
                USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """CREATE TRIGGER preserve_match_participants BEFORE INSERT OR UPDATE OR DELETE
    ON match_recorded_participants
    FOR EACH ROW EXECUTE FUNCTION preserve_match_play()""",
    """CREATE TRIGGER preserve_match_play BEFORE INSERT OR UPDATE OR DELETE
    ON match_recorded_play FOR EACH ROW EXECUTE FUNCTION preserve_match_play()""",
    """
    CREATE FUNCTION lock_recorded_participants() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        PERFORM id FROM matches WHERE id IN (
            CASE WHEN TG_OP <> 'DELETE' THEN NEW.match_id END,
            CASE WHEN TG_OP <> 'INSERT' THEN OLD.match_id END
        ) ORDER BY id FOR UPDATE;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END $$
    """,
    """CREATE TRIGGER lock_recorded_participants BEFORE INSERT OR UPDATE OR DELETE
    ON match_side_players FOR EACH ROW EXECUTE FUNCTION lock_recorded_participants()""",
    """
    CREATE FUNCTION check_recorded_participants() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE participant match_side_players%ROWTYPE;
    BEGIN
        SELECT * INTO participant FROM match_side_players WHERE id=NEW.id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        -- Deferred so an explicit same-person merge can finish its identity
        -- tombstones before current participants are compared with original ones.
        IF EXISTS (SELECT 1 FROM match_recorded_play
            WHERE match_id=participant.match_id)
            AND NOT EXISTS (
                SELECT 1 FROM match_recorded_participants recorded
                JOIN match_sides side ON side.id=participant.match_side_id
                WHERE recorded.match_id=participant.match_id
                  AND recorded.side_number=side.side_number
                  AND entry_canonical_player(recorded.player_id)=
                      entry_canonical_player(participant.user_id)
            )
            AND NOT EXISTS (
                SELECT 1 FROM match_lineups lineup
                JOIN match_lineup_players p ON p.lineup_id=lineup.id
                JOIN match_sides side ON side.id=participant.match_side_id
                WHERE lineup.match_id=participant.match_id AND lineup.revision > 1
                  AND p.side_number=side.side_number AND p.player_id=participant.user_id
            ) THEN
            RAISE EXCEPTION 'recorded participants cannot gain an unrecorded identity'
                USING ERRCODE='23514';
        END IF;
        RETURN NULL;
    END $$
    """,
    """CREATE CONSTRAINT TRIGGER check_recorded_participants
    AFTER INSERT OR UPDATE ON match_side_players DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_recorded_participants()""",
)


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
        IF OLD.lifecycle_state='cancelled' AND
            (to_jsonb(NEW) - ARRAY['updated_at','lock_version','lifecycle_state',
                'lifecycle_version','first_recorded_play_at','started_at'])
            IS DISTINCT FROM
            (to_jsonb(OLD) - ARRAY['updated_at','lock_version','lifecycle_state',
                'lifecycle_version','first_recorded_play_at','started_at']) THEN
            RAISE EXCEPTION 'cancelled event configuration is immutable'
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
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER record_event_play BEFORE INSERT ON match_game_scores
    FOR EACH ROW EXECUTE FUNCTION record_event_play();
    """,
    """
    CREATE FUNCTION observe_recorded_event_play() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        -- The BEFORE trigger already owns the parent/event locks and validated
        -- cancellation. Observe only persisted evidence so earlier-time refinement
        -- is checked against the retained scores by preserve_event_lifecycle.
        UPDATE tournament_events e
        SET first_recorded_play_at=(
                SELECT min(s.created_at) FROM tournament_fixtures evidence
                JOIN match_games game ON game.match_id=evidence.match_id
                JOIN match_game_scores s ON s.match_game_id=game.id
                WHERE evidence.scope_event_id=e.id
            ),
            lifecycle_state=CASE WHEN e.lifecycle_state='unstarted'
                THEN 'in_progress'::event_lifecycle_state ELSE e.lifecycle_state END
        FROM tournament_fixtures f JOIN match_games g ON g.match_id=f.match_id
        WHERE g.id=NEW.match_game_id AND e.id=f.scope_event_id
            AND (e.first_recorded_play_at IS NULL
                OR NEW.created_at < e.first_recorded_play_at);
        RETURN NULL;
    END $$
    """,
    """
    CREATE TRIGGER observe_recorded_event_play AFTER INSERT ON match_game_scores
    FOR EACH ROW EXECUTE FUNCTION observe_recorded_event_play()
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


ARCHIVE_DDL = (
    """
    CREATE FUNCTION record_tournament_archive() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'UPDATE' AND OLD.status = 'archived' AND
            (NEW.status, NEW.archive_observed_at, NEW.archived_at) IS DISTINCT FROM
            (OLD.status, OLD.archive_observed_at, OLD.archived_at) THEN
            RAISE EXCEPTION 'archive history must be preserved' USING ERRCODE='23514';
        END IF;
        IF NEW.status = 'archived' AND
            (TG_OP = 'INSERT' OR OLD.status <> 'archived') THEN
            NEW.archive_observed_at := clock_timestamp();
            IF TG_OP = 'UPDATE' AND NEW.archived_at IS NULL THEN
                NEW.archived_at := NEW.archive_observed_at;
            END IF;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER record_tournament_archive BEFORE INSERT OR UPDATE ON tournaments
    FOR EACH ROW EXECUTE FUNCTION record_tournament_archive()
    """,
    """
    CREATE FUNCTION append_tournament_archive() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF NEW.status = 'archived' AND
            (TG_OP = 'INSERT' OR OLD.status <> 'archived') THEN
            INSERT INTO tournament_archive_history(
                tournament_id, observed_at, occurred_at)
            VALUES (NEW.id, NEW.archive_observed_at, NEW.archived_at);
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER append_tournament_archive AFTER INSERT OR UPDATE ON tournaments
    FOR EACH ROW EXECUTE FUNCTION append_tournament_archive()
    """,
    """
    CREATE FUNCTION preserve_tournament_archive() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP <> 'INSERT' OR pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION 'archive history is immutable and database owned'
                USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_tournament_archive BEFORE INSERT OR UPDATE OR DELETE ON
        tournament_archive_history
    FOR EACH ROW EXECUTE FUNCTION preserve_tournament_archive()
    """,
    """
    CREATE FUNCTION preserve_archived_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'UPDATE' AND NEW.tournament_id = OLD.tournament_id THEN
            RETURN NEW;
        END IF;
        IF TG_OP = 'INSERT' THEN
            PERFORM id FROM tournaments WHERE id=NEW.tournament_id FOR SHARE NOWAIT;
        ELSIF TG_OP = 'DELETE' THEN
            PERFORM id FROM tournaments WHERE id=OLD.tournament_id FOR SHARE NOWAIT;
        ELSE
            PERFORM id FROM tournaments
            WHERE id IN (OLD.tournament_id, NEW.tournament_id)
            ORDER BY id FOR SHARE NOWAIT;
        END IF;
        IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM tournament_archive_history
            WHERE tournament_id=OLD.tournament_id) THEN
            RAISE EXCEPTION 'archive history must preserve its events'
                USING ERRCODE='23514';
        END IF;
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        IF EXISTS (SELECT 1 FROM tournament_archive_history
            WHERE tournament_id=NEW.tournament_id) THEN
            RAISE EXCEPTION 'an archived tournament cannot accept new events'
                USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'event composition requires archive parent lock; retry'
            USING ERRCODE='40001';
    END $$
    """,
    """
    CREATE TRIGGER preserve_archived_event
    BEFORE INSERT OR DELETE OR UPDATE OF tournament_id
    ON tournament_events FOR EACH ROW EXECUTE FUNCTION preserve_archived_event()
    """,
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
    DECLARE
        affected_events uuid[] := '{}';
        require_progress boolean := false;
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
        ELSIF TG_TABLE_NAME = 'tournament_events' THEN
            IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
                AND (NEW.lifecycle_state='finished' OR OLD.lifecycle_state='finished')
            THEN
                affected_events := ARRAY[NEW.id];
            ELSIF NEW.draw_type_id IS DISTINCT FROM OLD.draw_type_id THEN
                affected_events := ARRAY[NEW.id];
                require_progress := true;
            ELSE
                RETURN NULL;
            END IF;
        ELSIF TG_TABLE_NAME = 'tournament_event_stages' THEN
            IF ROW(NEW.draw_type_id, NEW.event_id)
                IS NOT DISTINCT FROM ROW(OLD.draw_type_id, OLD.event_id) THEN
                RETURN NULL;
            END IF;
            affected_events := ARRAY[OLD.event_id, NEW.event_id];
            require_progress := true;
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
            IF TG_OP <> 'DELETE' THEN
                affected_events := array_append(affected_events, NEW.scope_event_id);
            END IF;
            IF TG_OP <> 'INSERT' THEN
                affected_events := array_append(affected_events, OLD.scope_event_id);
            END IF;
        END IF;
        IF COALESCE(cardinality(affected_events), 0) = 0 THEN
            RETURN NULL;
        END IF;
        IF require_progress OR
            TG_TABLE_NAME IN ('tournament_fixtures','tournament_entries') THEN
            SELECT array_agg(scope.id) INTO affected_events
            FROM unnest(affected_events) AS scope(id)
            WHERE EXISTS (SELECT 1 FROM tournament_event_lifecycle_history h
                WHERE h.event_id=scope.id)
                OR EXISTS (SELECT 1 FROM tournament_event_reconciliations r
                    WHERE r.event_id=scope.id)
                OR EXISTS (SELECT 1 FROM tournament_fixtures f
                    JOIN matches m ON m.id=f.match_id
                    WHERE f.scope_event_id=scope.id
                        AND m.status IN ('completed','voided'));
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
    CREATE TRIGGER invalidate_progress_event_reconciliation
    AFTER UPDATE OF lifecycle_state, draw_type_id ON tournament_events
    FOR EACH ROW EXECUTE FUNCTION invalidate_event_reconciliation()
    """,
    """
    CREATE TRIGGER invalidate_stage_strategy_event_reconciliation
    AFTER UPDATE OF draw_type_id, event_id ON tournament_event_stages
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


COMPETITION_RULE_INTEGRITY_DDL = (
    """
    CREATE FUNCTION bind_competition_stage_rules() RETURNS trigger LANGUAGE plpgsql
            AS $$
    BEGIN
        UPDATE tournament_event_stages SET rule_revision_id=NEW.id
            WHERE event_id=NEW.event_id AND retired_at IS NULL;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER bind_competition_stage_rules AFTER INSERT ON
            tournament_draw_revisions
    FOR EACH ROW EXECUTE FUNCTION bind_competition_stage_rules()
    """,
    """
    CREATE FUNCTION match_rules_agree(settings match_settings, rules jsonb)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
        SELECT (settings.rule_version, settings.team_size, settings.best_of,
            settings.affects_rating,
                settings.verification_policy::text, settings.retirement_window)
        IS NOT DISTINCT FROM
            ((rules->>'rule_version')::smallint, (rules->>'team_size')::smallint,
            (rules->>'best_of')::smallint,
             (rules->>'affects_rating')::boolean, rules->>'verification_policy',
             (rules->>'retirement_window')::interval)
    $$
    """,
    """
    CREATE FUNCTION check_match_rule_source() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE rules jsonb;
    BEGIN
        IF NEW.source_rule_revision_id IS NOT NULL THEN
            SELECT match_rules INTO STRICT rules FROM tournament_draw_revisions
                WHERE id=NEW.source_rule_revision_id;
            IF NOT match_rules_agree(NEW, rules) THEN
                RAISE EXCEPTION 'match rules must agree with their source revision'
                    USING ERRCODE='23514';
            END IF;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER check_match_rule_source BEFORE INSERT ON match_settings
    FOR EACH ROW EXECUTE FUNCTION check_match_rule_source()
    """,
    """
    CREATE FUNCTION check_fixture_rules() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE settings match_settings; rules jsonb; stage_revision uuid;
    BEGIN
        SELECT rule_revision_id INTO STRICT stage_revision FROM tournament_event_stages
            WHERE id=NEW.stage_id;
        IF stage_revision IS DISTINCT FROM NEW.draw_revision_id THEN
            RAISE EXCEPTION 'fixture stage rules must agree with its draw revision'
                USING ERRCODE='23514';
        END IF;
        IF NEW.match_id IS NOT NULL THEN
            SELECT ms.* INTO STRICT settings FROM match_settings ms
                JOIN matches m ON m.match_settings_id=ms.id WHERE m.id=NEW.match_id;
            SELECT match_rules INTO STRICT rules FROM tournament_draw_revisions
                WHERE id=NEW.draw_revision_id;
            IF NOT match_rules_agree(settings, rules) OR
                (settings.source_rule_revision_id IS NOT NULL AND
                 settings.source_rule_revision_id <> NEW.draw_revision_id) THEN
                RAISE EXCEPTION 'fixture match rules must agree with its draw revision'
                    USING ERRCODE='23514';
            END IF;
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER check_fixture_rules AFTER INSERT OR UPDATE OF match_id,
            draw_revision_id, stage_id
    ON tournament_fixtures FOR EACH ROW EXECUTE FUNCTION check_fixture_rules()
    """,
    """
    CREATE FUNCTION check_match_rule_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE source_revision uuid; target_match uuid;
    BEGIN
        IF TG_TABLE_NAME = 'matches' THEN
            target_match := NEW.id;
        ELSE
            target_match := OLD.match_id;
        END IF;
        SELECT ms.source_rule_revision_id INTO source_revision
            FROM matches m JOIN match_settings ms ON ms.id=m.match_settings_id
            WHERE m.id=target_match FOR UPDATE OF m;
        IF source_revision IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM tournament_fixtures
            WHERE match_id=target_match AND draw_revision_id=source_revision
        ) THEN
            RAISE EXCEPTION 'match source revision requires its fixture'
                USING ERRCODE='23514';
        END IF;
        RETURN NULL;
    END $$
    """,
    """
    CREATE CONSTRAINT TRIGGER match_rule_fixture_owner
    AFTER INSERT OR UPDATE OF id, match_settings_id ON matches
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION check_match_rule_fixture()
    """,
    """
    CREATE CONSTRAINT TRIGGER preserve_fixture_rule_owner
    AFTER DELETE OR UPDATE OF match_id, draw_revision_id ON tournament_fixtures
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION check_match_rule_fixture()
    """,
    """
    CREATE FUNCTION preserve_rule_sources_on_truncate() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF EXISTS (
            SELECT 1 FROM matches m JOIN match_settings ms ON ms.id=m.match_settings_id
            WHERE ms.source_rule_revision_id IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'match source revision requires its fixture'
                USING ERRCODE='23514';
        END IF;
        RETURN NULL;
    END $$
    """,
    """
    CREATE TRIGGER preserve_rule_sources_on_truncate AFTER TRUNCATE
    ON tournament_fixtures FOR EACH STATEMENT
    EXECUTE FUNCTION preserve_rule_sources_on_truncate()
    """,
    """
    CREATE FUNCTION preserve_stage_rules() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF OLD.rule_revision_id IS NOT NULL AND
            (NEW.rule_revision_id, NEW.event_id, NEW.draw_type_id, NEW.position)
            IS DISTINCT FROM (OLD.rule_revision_id, OLD.event_id, OLD.draw_type_id,
            OLD.position)
        THEN
            RAISE EXCEPTION 'stage rules binding is immutable' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_stage_rules BEFORE UPDATE ON tournament_event_stages
    FOR EACH ROW EXECUTE FUNCTION preserve_stage_rules()
    """,
    """
    CREATE FUNCTION preserve_match_rule_reference() RETURNS trigger LANGUAGE plpgsql
            AS $$
    BEGIN
        IF NEW.match_settings_id IS DISTINCT FROM OLD.match_settings_id THEN
            RAISE EXCEPTION 'match rules reference is immutable' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER immutable_match_rule_reference BEFORE UPDATE OF match_settings_id
            ON matches
    FOR EACH ROW EXECUTE FUNCTION preserve_match_rule_reference()
    """,
    """
    CREATE FUNCTION capture_competition_rules() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE event_row tournament_events; draw_key text;
    BEGIN
        SELECT * INTO STRICT event_row FROM tournament_events WHERE id=NEW.event_id;
        SELECT key INTO STRICT draw_key FROM draw_types WHERE id=event_row.draw_type_id;
        IF event_row.format = 'teams' THEN
            RAISE EXCEPTION 'team competition rules are not supported' USING
            ERRCODE='23514';
        END IF;
        IF NEW.match_rules IS NULL THEN
            NEW.match_rules := jsonb_build_object(
                'rule_version', 1, 'team_size', CASE WHEN event_row.format='doubles'
            THEN 2 ELSE 1 END,
                'best_of', event_row.match_settings->'length_games',
                'affects_rating', event_row.match_settings->'rated',
                'verification_policy', 'none', 'retirement_window', 'P7D');
        END IF;
        IF NEW.format_rules IS NULL THEN
            NEW.format_rules := jsonb_build_object('version', 1,
                'draw_type', draw_key, 'settings', event_row.draw_settings);
        END IF;
        IF (jsonb_typeof(NEW.match_rules) = 'object'
            AND NEW.match_rules ?& ARRAY['rule_version','team_size','best_of',
            'affects_rating','verification_policy','retirement_window']
            AND NEW.match_rules - ARRAY['rule_version','team_size','best_of',
            'affects_rating','verification_policy','retirement_window'] = '{}'::jsonb
            AND NEW.match_rules->'rule_version' = '1'::jsonb
            AND NEW.match_rules->'team_size' IN ('1'::jsonb, '2'::jsonb)
            AND jsonb_typeof(NEW.match_rules->'best_of') = 'number'
            AND NEW.match_rules->'best_of' IN ('1'::jsonb, '3'::jsonb,
                '5'::jsonb, '7'::jsonb)
            AND jsonb_typeof(NEW.match_rules->'affects_rating') = 'boolean'
            AND NEW.match_rules->>'verification_policy' IN ('none','self_report',
            'opponent_confirms','all_players_confirm')
            AND jsonb_typeof(NEW.match_rules->'retirement_window') IN ('null',
            'string')) IS NOT TRUE THEN
            RAISE EXCEPTION 'invalid match rule snapshot' USING ERRCODE='23514';
        END IF;
        IF NEW.match_rules->'team_size' IS DISTINCT FROM
            to_jsonb(CASE WHEN event_row.format='doubles' THEN 2 ELSE 1 END) OR
            NEW.match_rules->'best_of' IS DISTINCT FROM
                event_row.match_settings->'length_games' OR
            NEW.match_rules->'affects_rating' IS DISTINCT FROM
                event_row.match_settings->'rated' THEN
            RAISE EXCEPTION 'match rules must agree with the event' USING
            ERRCODE='23514';
        END IF;
        IF NEW.match_rules->'retirement_window' <> 'null'::jsonb AND
            (NEW.match_rules->>'retirement_window') !~
            '^P([0-9]+D)?(T([0-9]+H)?([0-9]+M)?([0-9]+([.][0-9]+)?S)?)?$' THEN
            RAISE EXCEPTION 'invalid match rule duration' USING ERRCODE='23514';
        END IF;
        IF (NEW.match_rules->>'best_of')::integer % 2 <> 1 OR
            ((NEW.match_rules->>'retirement_window')::interval <= interval '0') THEN
            RAISE EXCEPTION 'invalid match rule values' USING ERRCODE='23514';
        END IF;
        IF (jsonb_typeof(NEW.format_rules) = 'object'
            AND NEW.format_rules ?& ARRAY['version','draw_type','settings']
            AND NEW.format_rules - ARRAY['version','draw_type','settings'] = '{}'::jsonb
            AND NEW.format_rules->'version' = '1'::jsonb
            AND NEW.format_rules->>'draw_type' IN ('round-robin','single-elim',
            'rr-then-ko','swiss')
            AND jsonb_typeof(NEW.format_rules->'settings') = 'object') IS NOT TRUE THEN
            RAISE EXCEPTION 'invalid format rule snapshot' USING ERRCODE='23514';
        END IF;
        IF NEW.format_rules->>'draw_type' IS DISTINCT FROM draw_key OR
            NEW.format_rules->'settings' IS DISTINCT FROM event_row.draw_settings THEN
            RAISE EXCEPTION 'format rules must agree with the event' USING
            ERRCODE='23514';
        END IF;
        IF (CASE NEW.format_rules->>'draw_type'
            WHEN 'round-robin' THEN NEW.format_rules->'settings' = '{}'::jsonb
            WHEN 'single-elim' THEN NEW.format_rules->'settings' = '{}'::jsonb
            WHEN 'rr-then-ko' THEN
                ((NEW.format_rules->'settings') - 'qualifiers_per_group' = '{}'::jsonb
                 AND jsonb_typeof(NEW.format_rules->'settings'->
                     'qualifiers_per_group') = 'number'
                 AND NEW.format_rules->'settings'->>'qualifiers_per_group' ~
            '^[1-9][0-9]*$')
            WHEN 'swiss' THEN
                ((NEW.format_rules->'settings') - 'rounds' = '{}'::jsonb
                 AND jsonb_typeof(NEW.format_rules->'settings'->'rounds') = 'number'
                 AND NEW.format_rules->'settings'->>'rounds' ~ '^[1-9][0-9]*$')
            ELSE false END) IS NOT TRUE THEN
            RAISE EXCEPTION 'invalid format rule settings' USING ERRCODE='23514';
        END IF;
        IF NEW.format_rules->>'draw_type' = 'swiss' AND
            (NEW.format_rules->'settings'->>'rounds')::integer > 32 THEN
            RAISE EXCEPTION 'invalid format rule rounds' USING ERRCODE='23514';
        END IF;
        IF NEW.format_rules->>'draw_type' = 'rr-then-ko' AND
            (NEW.format_rules->'settings'->>'qualifiers_per_group')::integer > 1000 THEN
            RAISE EXCEPTION 'invalid format rule qualifiers' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER capture_competition_rules BEFORE INSERT ON tournament_draw_revisions
    FOR EACH ROW EXECUTE FUNCTION capture_competition_rules()
    """,
    """
    CREATE FUNCTION preserve_match_rules() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'match rules are immutable' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """
    CREATE TRIGGER preserve_match_rules BEFORE UPDATE ON match_settings
    FOR EACH ROW EXECUTE FUNCTION preserve_match_rules()
    """,
)


def upgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table(
        "accounts",
        sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("erased_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.CheckConstraint("display_order >= 0", name="ck_draw_types_display_order"),
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
        sa.CheckConstraint(
            "display_order >= 0", name="ck_notification_channels_display_order"
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
        sa.CheckConstraint(
            "display_order >= 0", name="ck_notification_types_display_order"
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
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.UniqueConstraint("key", "version", name="uq_rating_strategies_key_version"),
        sa.CheckConstraint("version > 0", name="ck_rating_strategies_version"),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "state_schema", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column(
            "initial_state", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
        sa.CheckConstraint(
            "jsonb_typeof(state_schema) = 'object'",
            name="ck_rating_strategies_state_schema_object",
        ),
        sa.CheckConstraint(
            "initial_state IS NULL OR "
            "jsonb_typeof(initial_state) IN ('object', 'null')",
            name="ck_rating_strategies_initial_state_object",
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
        op.f("ix_rating_strategies_key"), "rating_strategies", ["key"], unique=False
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
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table(
        "account_first_sign_in_intents",
        sa.Column("email", sa.String(254), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.CheckConstraint(
            "email = lower(email)",
            name="ck_account_first_sign_in_intents_normalized_email",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("email"),
        sa.UniqueConstraint("user_id"),
    )
    op.create_table(
        "account_email_intents",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "purpose",
            sa.Enum(
                "login",
                "first_sign_in",
                "change",
                "merge",
                name="emailpurpose",
                native_enum=False,
            ),
            nullable=False,
        ),
        sa.Column("sent_to", sa.String(length=254), nullable=False),
        sa.Column("prior_email", sa.String(length=254), nullable=True),
        sa.Column("target_account_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(purpose = 'change' AND target_account_id IS NULL) OR (purpose = "
            "'merge' AND target_account_id IS NOT NULL AND prior_email IS NULL)",
            name="ck_account_email_intents_payload",
        ),
        sa.CheckConstraint(
            "purpose IN ('change', 'merge')", name="ck_account_email_intents_purpose"
        ),
        sa.ForeignKeyConstraint(
            ["target_account_id"], ["accounts.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
        sa.CheckConstraint(
            "target_account_id <> user_id",
            name="ck_account_email_intents_distinct_accounts",
        ),
    )
    op.create_table(
        "account_email_tokens",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("token", sa.LargeBinary(), nullable=False),
        sa.Column(
            "purpose",
            sa.Enum(
                "login",
                "first_sign_in",
                "change",
                "merge",
                name="ck_account_email_tokens_purpose",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=False,
        ),
        sa.Column("sent_to", sa.String(length=254), nullable=True),
        sa.Column("prior_email", sa.String(length=254), nullable=True),
        sa.Column("target_account_id", sa.UUID(), nullable=True),
        sa.Column("guest_account_id", sa.UUID(), nullable=True),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("replaced_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "(purpose = 'merge' AND (replaced_at IS NOT NULL OR target_account_id "
            "IS NOT NULL)) OR (purpose <> 'merge' AND target_account_id IS NULL)",
            name="ck_account_email_tokens_merge_target",
        ),
        sa.CheckConstraint(
            "purpose = 'change' OR prior_email IS NULL",
            name="ck_account_email_tokens_prior_email",
        ),
        sa.CheckConstraint(
            "purpose IN ('login', 'first_sign_in') OR guest_account_id IS NULL",
            name="ck_account_email_tokens_guest_source",
        ),
        sa.CheckConstraint(
            "(replaced_at IS NULL AND sent_to IS NOT NULL) OR (replaced_at IS NOT "
            "NULL AND sent_to IS NULL AND prior_email IS NULL AND target_account_id"
            " IS NULL AND guest_account_id IS NULL)",
            name="ck_account_email_tokens_live_payload",
        ),
        sa.ForeignKeyConstraint(
            ["guest_account_id"], ["accounts.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["target_account_id"], ["accounts.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.CheckConstraint(
            "target_account_id <> user_id AND guest_account_id <> user_id",
            name="ck_account_email_tokens_distinct_accounts",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token"),
    )
    op.create_index(
        "ix_account_email_tokens_created_at",
        "account_email_tokens",
        ["created_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_account_email_tokens_user_id"),
        "account_email_tokens",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        "uq_account_email_tokens_active_login",
        "account_email_tokens",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text(
            "replaced_at IS NULL AND purpose IN ('login', 'first_sign_in')"
        ),
    )
    op.create_index(
        "uq_account_email_tokens_active_confirmation",
        "account_email_tokens",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text(
            "replaced_at IS NULL AND purpose IN ('change', 'merge')"
        ),
    )
    op.create_table(
        "account_session_tokens",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("token", sa.LargeBinary(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token"),
    )
    op.create_index(
        op.f("ix_account_session_tokens_user_id"),
        "account_session_tokens",
        ["user_id"],
        unique=False,
    )
    # ### end Alembic commands ###
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
        sa.CheckConstraint(
            "status = 'voided' OR "
            "(status = 'completed' AND completed_at IS NOT NULL) OR "
            "(status IN ('pending', 'in_progress') AND completed_at IS NULL)",
            name="ck_matches_completed_at",
        ),
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
        sa.CheckConstraint(
            "(status = 'archived') = (archive_observed_at IS NOT NULL)",
            name="ck_tournaments_archive_state",
        ),
        sa.CheckConstraint(
            "archived_at IS NULL OR (archive_observed_at IS NOT NULL AND archived_at <= archive_observed_at)",
            name="ck_tournaments_archive_chronology",
        ),
        sa.Column("archive_observed_at", sa.DateTime(timezone=True)),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column(
            "details_version", sa.Integer(), server_default=sa.text("1"), nullable=False
        ),
        sa.CheckConstraint(
            "details_version >= 1", name="ck_tournaments_details_version"
        ),
        sa.Column(
            "ownership_revision",
            sa.Integer(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "ownership_revision >= 0", name="ck_tournaments_ownership_revision"
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
        sa.CheckConstraint(
            "address IS NULL OR jsonb_typeof(address) = 'object'",
            name="ck_tournaments_address_object",
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
        sa.CheckConstraint(
            "rating_state IS NULL OR jsonb_typeof(rating_state) IN ('object', 'null')",
            name="ck_user_league_ratings_rating_state_object",
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
            "participant_authorized",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
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
            "jsonb_typeof(games) = 'array'", name="ck_match_results_games_array"
        ),
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
            IF EXISTS (
                SELECT 1 FROM matches WHERE id = NEW.match_id
                AND (current_official_result_id IS NOT NULL OR status = 'voided')
            ) THEN
                RAISE EXCEPTION 'closed matches cannot receive proposals'
                    USING ERRCODE = '23514';
            END IF;
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
            -- Derive immutable origin evidence; caller-supplied booleans cannot
            -- turn an unauthorized proposal into an official timeout later.
            BEGIN
                PERFORM ap.account_id FROM account_players ap
                JOIN accounts a ON a.id = ap.account_id
                WHERE ap.account_id = NEW.submitted_by_user_id
                  AND ap.player_id = NEW.submitted_for_player_id
                FOR SHARE OF ap, a NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION 'proposal authority changed; retry' USING ERRCODE = '40001';
            END;
            NEW.participant_authorized := EXISTS (
                SELECT 1 FROM account_players ap JOIN accounts a ON a.id = ap.account_id
                JOIN match_side_players p ON p.user_id = ap.player_id
                WHERE ap.account_id = NEW.submitted_by_user_id
                  AND ap.player_id = NEW.submitted_for_player_id AND ap.is_primary
                  AND a.merged_at IS NULL AND p.match_id = NEW.match_id
            );
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
                   NEW.submitted_by_user_id, NEW.submitted_at, NEW.participant_authorized)
                IS DISTINCT FROM
               ROW(OLD.id, OLD.match_id, OLD.supersedes_result_id, OLD.games,
                   OLD.submitted_by_user_id, OLD.submitted_at, OLD.participant_authorized) THEN
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
                    SELECT 1 FROM matches WHERE id = OLD.match_id
                    AND (current_official_result_id IS NOT NULL OR status = 'voided')
                ) THEN
                    RAISE EXCEPTION 'closed matches cannot receive participant consent'
                        USING ERRCODE = '23514';
                END IF;
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
        "match_rating_bases",
        sa.Column(
            "match_id",
            sa.UUID(),
            sa.ForeignKey("matches.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
        sa.Column(
            "rating_strategy_id",
            sa.UUID(),
            sa.ForeignKey("rating_strategies.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "match_id",
            "rating_strategy_id",
            name="uq_match_rating_bases_match_strategy",
        ),
    )
    op.create_table(
        "rating_inputs",
        sa.Column(
            "id",
            sa.UUID(),
            server_default=sa.text("gen_random_uuid()"),
            primary_key=True,
        ),
        sa.Column(
            "sequence",
            sa.BigInteger(),
            sa.Identity(always=True),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "league_id",
            sa.UUID(),
            sa.ForeignKey("leagues.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "player_id",
            sa.UUID(),
            sa.ForeignKey("players.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "actor_account_id",
            sa.UUID(),
            sa.ForeignKey("accounts.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "rating_strategy_id",
            sa.UUID(),
            sa.ForeignKey("rating_strategies.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "supersedes_id",
            sa.UUID(),
            sa.ForeignKey("rating_inputs.id", ondelete="RESTRICT"),
            unique=True,
            nullable=True,
        ),
        sa.Column("rating", sa.Float(), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("effective_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "recorded_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "rating > '-Infinity'::float8 AND rating < 'Infinity'::float8",
            name="ck_rating_inputs_finite",
        ),
        sa.CheckConstraint(
            "source IN ('manual', 'import')", name="ck_rating_inputs_source"
        ),
    )
    op.create_table(
        "rating_history",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("league_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("match_id", sa.UUID(), nullable=True),
        sa.Column(
            "rating_input_id",
            sa.UUID(),
            sa.ForeignKey("rating_inputs.id", ondelete="RESTRICT"),
            nullable=True,
            unique=True,
        ),
        sa.Column("official_result_id", sa.UUID(), nullable=True),
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
        sa.ForeignKeyConstraint(["match_id"], ["matches.id"], ondelete="RESTRICT"),
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
        sa.CheckConstraint(
            "wall_time_ms IS NULL OR wall_time_ms >= 0",
            name="ck_schedule_solves_wall_time_ms",
        ),
        sa.CheckConstraint(
            "fixtures_placed IS NULL OR fixtures_placed >= 0",
            name="ck_schedule_solves_fixtures_placed",
        ),
        sa.CheckConstraint(
            "fixtures_pinned IS NULL OR fixtures_pinned >= 0",
            name="ck_schedule_solves_fixtures_pinned",
        ),
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
        sa.CheckConstraint(
            "infeasibility_reasons IS NULL OR "
            "jsonb_typeof(infeasibility_reasons) IN ('array', 'null')",
            name="ck_schedule_solves_infeasibility_reasons_array",
        ),
        sa.Column(
            "placement_conflicts",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.CheckConstraint(
            "placement_conflicts IS NULL OR "
            "jsonb_typeof(placement_conflicts) IN ('array', 'null')",
            name="ck_schedule_solves_placement_conflicts_array",
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
        sa.CheckConstraint("lifecycle_version >= 0", name="ck_event_lifecycle_version"),
        sa.CheckConstraint(
            "lifecycle_state <> 'unstarted' OR (started_at IS NULL AND first_recorded_play_at IS NULL)",
            name="ck_event_unstarted_has_no_play",
        ),
        sa.CheckConstraint(
            "started_at IS NULL OR first_recorded_play_at IS NULL OR started_at <= first_recorded_play_at",
            name="ck_event_play_chronology",
        ),
        sa.Column(
            "lifecycle_state",
            sa.Enum(
                "unstarted",
                "in_progress",
                "finished",
                "cancelled",
                name="event_lifecycle_state",
            ),
            nullable=False,
            server_default="unstarted",
        ),
        sa.Column(
            "lifecycle_version",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("first_recorded_play_at", sa.DateTime(timezone=True)),
        sa.Column("started_at", sa.DateTime(timezone=True)),
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
        sa.Column("draw_type_id", sa.UUID(), nullable=False),
        sa.Column(
            "draw_settings",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "jsonb_typeof(draw_settings) = 'object'",
            name="ck_tournament_events_draw_settings_object",
        ),
        sa.Column("max_players", sa.Integer(), nullable=True),
        sa.Column("entry_fee", sa.Numeric(precision=8, scale=2), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("slot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.CheckConstraint(
            "jsonb_typeof(slot) = 'object'", name="ck_tournament_events_slot_object"
        ),
        sa.Column(
            "match_settings", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.CheckConstraint(
            "jsonb_typeof(match_settings) = 'object'",
            name="ck_tournament_events_match_settings_object",
        ),
        sa.Column(
            "predicates",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "jsonb_typeof(predicates) = 'array'",
            name="ck_tournament_events_predicates_array",
        ),
        sa.Column(
            "lock_version", sa.Integer(), server_default=sa.text("1"), nullable=False
        ),
        sa.CheckConstraint(
            "lock_version >= 1", name="ck_tournament_events_lock_version"
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
            ["draw_type_id"],
            ["draw_types.id"],
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
        sa.Column("position", sa.Integer(), nullable=True),
        sa.CheckConstraint(
            "position IS NULL OR position >= 0",
            name="ck_tournament_tables_position",
        ),
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "(retired_at IS NULL) = (position IS NOT NULL)",
            name="ck_tournament_tables_retirement_position",
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
        "tournament_table_outages",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("tournament_id", sa.UUID(), nullable=False),
        sa.Column("table_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column(
            "effective_from",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("effective_until", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "effective_until IS NULL OR effective_until > effective_from",
            name="ck_tournament_table_outages_effective_interval",
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id", "table_id"],
            ["tournament_tables.tournament_id", "tournament_tables.id"],
            name="fk_tournament_table_outages_tournament_id_table_id",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_tournament_table_outages_active_table",
        "tournament_table_outages",
        ["tournament_id", "table_id"],
        unique=True,
        postgresql_where=sa.text("effective_until IS NULL"),
    )
    op.create_index(
        "ix_tournament_table_outages_tournament_id_table_id",
        "tournament_table_outages",
        ["tournament_id", "table_id"],
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
        sa.CheckConstraint("version >= 1", name="ck_match_game_scores_version"),
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
        sa.Column("superseded_by_entry_id", sa.UUID(), nullable=True),
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
        sa.CheckConstraint(
            "position >= 0", name="ck_tournament_event_reservations_position"
        ),
        sa.CheckConstraint(
            "slot_start < slot_end", name="ck_tournament_event_reservations_ordered"
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
        sa.CheckConstraint("position >= 0", name="ck_tournament_event_stages_position"),
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
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("tournament_id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("reservation_id", sa.UUID(), nullable=False),
        sa.Column("table_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("position", sa.Integer(), nullable=True),
        sa.CheckConstraint(
            "position IS NULL OR position >= 0",
            name="ck_tournament_event_reservation_tables_position",
        ),
        sa.Column(
            "effective_from",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("effective_until", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "effective_until IS NULL OR effective_until > effective_from",
            name="ck_tournament_event_reservation_tables_effective_interval",
        ),
        sa.CheckConstraint(
            "(effective_until IS NULL) = (position IS NOT NULL)",
            name="ck_tournament_event_reservation_tables_activity_position",
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
        sa.PrimaryKeyConstraint("id", name="pk_tournament_event_reservation_tables"),
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
    op.create_index(
        "ix_tournament_event_reservation_tables_event_id_reservation_id",
        "tournament_event_reservation_tables",
        ["event_id", "reservation_id"],
        unique=False,
    )
    op.create_index(
        "uq_tournament_event_reservation_tables_active_membership",
        "tournament_event_reservation_tables",
        ["event_id", "reservation_id", "table_id"],
        unique=True,
        postgresql_where=sa.text("effective_until IS NULL"),
    )
    op.create_table(
        "tournament_event_stage_groups",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("stage_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "position >= 0", name="ck_tournament_event_stage_groups_position"
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
    op.create_foreign_key(
        "fk_tournament_entries_superseded_same_event",
        "tournament_entries",
        "tournament_entries",
        ["event_id", "superseded_by_entry_id"],
        ["event_id", "id"],
        ondelete="RESTRICT",
    )
    op.create_check_constraint(
        "ck_tournament_entries_superseded_withdrawn",
        "tournament_entries",
        "superseded_by_entry_id IS NULL OR "
        "(superseded_by_entry_id <> id AND status = 'withdrawn')",
    )
    op.create_index(
        "ix_tournament_entries_superseded_by_entry_id",
        "tournament_entries",
        ["superseded_by_entry_id"],
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
        sa.CheckConstraint("round >= 1", name="ck_tournament_fixtures_round"),
        sa.CheckConstraint("position >= 1", name="ck_tournament_fixtures_position"),
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
        sa.CheckConstraint(
            "call_notified_count >= 0",
            name="ck_tournament_fixtures_call_notified_count",
        ),
        sa.UniqueConstraint(
            "scope_tournament_id",
            "id",
            name="uq_tournament_fixtures_scope_tournament_id_id",
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
            ["entry_a_id"],
            ["tournament_entries.id"],
            ondelete="NO ACTION",
            deferrable=True,
            initially="DEFERRED",
        ),
        sa.ForeignKeyConstraint(
            ["entry_b_id"],
            ["tournament_entries.id"],
            ondelete="NO ACTION",
            deferrable=True,
            initially="DEFERRED",
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
            ["table_id"],
            ["tournament_tables.id"],
            ondelete="NO ACTION",
            deferrable=True,
            initially="DEFERRED",
        ),
        sa.ForeignKeyConstraint(
            ["winner_entry_id"],
            ["tournament_entries.id"],
            ondelete="NO ACTION",
            deferrable=True,
            initially="DEFERRED",
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
    op.create_table(
        "tournament_table_call_history",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("tournament_id", sa.UUID(), nullable=False),
        sa.Column("table_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("fixture_id", sa.UUID(), nullable=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("scheduled_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('called', 'moved', 'cancelled')",
            name="ck_tournament_table_call_history_kind",
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id", "fixture_id"],
            ["tournament_fixtures.scope_tournament_id", "tournament_fixtures.id"],
            name="fk_tournament_table_call_history_tournament_id_fixture_id",
            ondelete="NO ACTION",
            deferrable=True,
            initially="DEFERRED",
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id"], ["tournaments.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id", "table_id"],
            ["tournament_tables.tournament_id", "tournament_tables.id"],
            name="fk_tournament_table_call_history_tournament_id_table_id",
            ondelete="NO ACTION",
            deferrable=True,
            initially="DEFERRED",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_tournament_table_call_history_tournament_id_table_id",
        "tournament_table_call_history",
        ["tournament_id", "table_id"],
        unique=False,
    )
    op.create_index(
        "ix_tournament_table_call_history_fixture_id_created_at",
        "tournament_table_call_history",
        ["fixture_id", "created_at"],
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
    op.create_table(
        "tournament_account_grants",
        sa.Column("id", sa.UUID(), nullable=False, primary_key=True),
        sa.Column(
            "tournament_id",
            sa.UUID(),
            sa.ForeignKey("tournaments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "account_id",
            sa.UUID(),
            sa.ForeignKey("accounts.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "role", sa.Enum("director", name="tournament_account_role"), nullable=False
        ),
        sa.Column(
            "granted_by_account_id",
            sa.UUID(),
            sa.ForeignKey("accounts.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column(
            "granted_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.clock_timestamp(),
            nullable=False,
        ),
        sa.Column(
            "reason",
            sa.Enum("explicit", "account_merge", name="authority_change_reason"),
            nullable=False,
        ),
        sa.Column(
            "revocation_reason",
            sa.Enum("explicit", "account_merge", name="authority_change_reason"),
            nullable=True,
        ),
        sa.Column(
            "inherited_from_grant_id",
            sa.UUID(),
            sa.ForeignKey(
                "tournament_account_grants.id",
                ondelete="NO ACTION",
                deferrable=True,
                initially="DEFERRED",
            ),
            nullable=True,
        ),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "revoked_by_account_id",
            sa.UUID(),
            sa.ForeignKey("accounts.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.CheckConstraint(
            "(revoked_at IS NULL) = (revocation_reason IS NULL) AND (revoked_at IS "
            "NOT NULL OR revoked_by_account_id IS NULL) AND (revocation_reason IS "
            "DISTINCT FROM 'explicit' OR revoked_by_account_id IS NOT NULL) AND "
            "(revocation_reason IS DISTINCT FROM 'account_merge' OR "
            "revoked_by_account_id IS NULL)",
            name="ck_tournament_account_grants_revocation_pair",
        ),
        sa.CheckConstraint(
            "(reason = 'explicit' AND granted_by_account_id IS NOT NULL AND "
            "inherited_from_grant_id IS NULL) OR (reason = 'account_merge' AND "
            "granted_by_account_id IS NULL AND inherited_from_grant_id IS NOT NULL)",
            name="ck_tournament_account_grants_provenance",
        ),
        sa.CheckConstraint(
            "revoked_at >= granted_at", name="ck_tournament_account_grants_chronology"
        ),
    )
    op.create_index(
        "ix_tournament_account_grants_account_active",
        "tournament_account_grants",
        ["account_id", "tournament_id"],
        postgresql_where=sa.text("revoked_at IS NULL"),
    )
    op.create_index(
        "uq_tournament_account_grants_active",
        "tournament_account_grants",
        ["tournament_id", "account_id", "role"],
        unique=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )
    op.create_table(
        "tournament_ownership_transfers",
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.UniqueConstraint(
            "tournament_id",
            "revision",
            name="uq_tournament_ownership_transfers_revision",
        ),
        sa.CheckConstraint(
            "revision >= 1", name="ck_tournament_ownership_transfers_revision"
        ),
        sa.Column("id", sa.UUID(), nullable=False, primary_key=True),
        sa.Column(
            "tournament_id",
            sa.UUID(),
            sa.ForeignKey("tournaments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "previous_owner_account_id",
            sa.UUID(),
            sa.ForeignKey("accounts.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "new_owner_account_id",
            sa.UUID(),
            sa.ForeignKey("accounts.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "actor_account_id",
            sa.UUID(),
            sa.ForeignKey("accounts.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column(
            "transferred_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.clock_timestamp(),
            nullable=False,
        ),
        sa.Column(
            "reason",
            sa.Enum("explicit", "account_merge", name="authority_change_reason"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(reason = 'explicit' AND actor_account_id IS NOT NULL) OR (reason = "
            "'account_merge' AND actor_account_id IS NULL)",
            name="ck_tournament_ownership_transfers_actor",
        ),
        sa.CheckConstraint(
            "previous_owner_account_id <> new_owner_account_id",
            name="ck_tournament_ownership_transfers_distinct",
        ),
    )
    op.execute("""
        CREATE TABLE tournament_entry_registrations (
        id UUID DEFAULT gen_random_uuid() NOT NULL,
        entry_id UUID NOT NULL,
        registered_at TIMESTAMP WITH TIME ZONE DEFAULT clock_timestamp() NOT NULL,
        registered_by_account_id UUID NOT NULL,
        withdrawn_at TIMESTAMP WITH TIME ZONE,
        withdrawn_by_account_id UUID,
        withdrawal_reason VARCHAR,
        withdrawal_explanation VARCHAR,
        PRIMARY KEY (id),
        CONSTRAINT ck_registration_interval CHECK (withdrawn_at IS NULL OR withdrawn_at
        >= registered_at),
        CONSTRAINT ck_registration_withdrawal_provenance CHECK ((withdrawn_at IS NULL
        AND withdrawn_by_account_id IS NULL AND withdrawal_reason IS NULL AND
        withdrawal_explanation IS NULL) OR (withdrawn_at IS NOT NULL AND
        withdrawn_by_account_id IS NOT NULL AND withdrawal_reason IS NOT NULL)),
        CONSTRAINT ck_registration_withdrawal_reason CHECK (withdrawal_reason IN (
        'self_withdrawal' , 'director_removal' , 'identity_reconciliation' )),
        FOREIGN KEY(entry_id) REFERENCES tournament_entries (id) ON DELETE CASCADE,
        FOREIGN KEY(registered_by_account_id) REFERENCES accounts (id) ON DELETE
        RESTRICT,
        FOREIGN KEY(withdrawn_by_account_id) REFERENCES accounts (id) ON DELETE RESTRICT
        )
        """)
    op.execute("""
        CREATE UNIQUE INDEX uq_registration_current_entry ON
        tournament_entry_registrations (entry_id) WHERE withdrawn_at IS NULL
        """)
    op.add_column(
        "tournament_fixtures",
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.drop_constraint(
        "uq_tournament_fixtures_stage_id_group_id_round_position",
        "tournament_fixtures",
        type_="unique",
    )
    op.create_index(
        "uq_tournament_fixtures_stage_id_group_id_round_position",
        "tournament_fixtures",
        ["stage_id", "group_id", "round", "position"],
        unique=True,
        postgresql_where=sa.text("retired_at IS NULL"),
    )
    op.execute("""
        CREATE TABLE tournament_entry_participations (
        id UUID DEFAULT gen_random_uuid() NOT NULL,
        event_id UUID NOT NULL,
        entry_id UUID NOT NULL,
        stage_id UUID NOT NULL,
        group_id UUID NOT NULL,
        started_at TIMESTAMP WITH TIME ZONE DEFAULT clock_timestamp() NOT NULL,
        ended_at TIMESTAMP WITH TIME ZONE,
        ended_by_account_id UUID,
        end_reason VARCHAR,
        end_explanation VARCHAR,
        PRIMARY KEY (id),
        CONSTRAINT fk_participation_event_entry FOREIGN KEY(event_id, entry_id)
        REFERENCES tournament_entries (event_id, id) ON DELETE CASCADE,
        CONSTRAINT fk_participation_event_stage FOREIGN KEY(event_id, stage_id)
        REFERENCES tournament_event_stages (event_id, id) ON DELETE CASCADE,
        CONSTRAINT fk_participation_stage_group FOREIGN KEY(stage_id, group_id)
        REFERENCES tournament_event_stage_groups (stage_id, id) DEFERRABLE INITIALLY
        DEFERRED,
        CONSTRAINT uq_participation_fixture_scope UNIQUE (id, entry_id, stage_id,
        group_id),
        CONSTRAINT ck_participation_interval CHECK (ended_at IS NULL OR ended_at >=
        started_at),
        CONSTRAINT ck_participation_ending CHECK ((ended_at IS NULL AND end_reason IS
        NULL AND ended_by_account_id IS NULL AND end_explanation IS NULL) OR (ended_at
        IS NOT NULL AND end_reason IS NOT NULL)),
        CONSTRAINT ck_participation_end_reason CHECK (end_reason IN ( 'self_withdrawal'
        , 'director_removal' , 'identity_reconciliation' , 'draw_retired' ,
        'stage_completed' , 'group_changed' )),
        CONSTRAINT ck_participation_withdrawal_actor CHECK (end_reason NOT IN (
        'self_withdrawal' , 'director_removal' , 'identity_reconciliation' ) OR
        ended_by_account_id IS NOT NULL),
        FOREIGN KEY(ended_by_account_id) REFERENCES accounts (id) ON DELETE RESTRICT
        )
        """)
    op.execute("""
        CREATE UNIQUE INDEX uq_participation_active_entry_stage ON
        tournament_entry_participations (entry_id, stage_id) WHERE ended_at IS NULL
        """)
    op.add_column(
        "tournament_fixtures", sa.Column("participation_a_id", sa.UUID(), nullable=True)
    )
    op.create_foreign_key(
        "fk_fixture_participation_a",
        "tournament_fixtures",
        "tournament_entry_participations",
        ["participation_a_id", "entry_a_id", "stage_id", "group_id"],
        ["id", "entry_id", "stage_id", "group_id"],
        deferrable=True,
        initially="DEFERRED",
    )
    op.create_check_constraint(
        "ck_fixture_participation_a_presence",
        "tournament_fixtures",
        "(participation_a_id IS NULL) = (entry_a_id IS NULL)",
    )
    op.add_column(
        "tournament_fixtures", sa.Column("participation_b_id", sa.UUID(), nullable=True)
    )
    op.create_foreign_key(
        "fk_fixture_participation_b",
        "tournament_fixtures",
        "tournament_entry_participations",
        ["participation_b_id", "entry_b_id", "stage_id", "group_id"],
        ["id", "entry_id", "stage_id", "group_id"],
        deferrable=True,
        initially="DEFERRED",
    )
    op.create_check_constraint(
        "ck_fixture_participation_b_presence",
        "tournament_fixtures",
        "(participation_b_id IS NULL) = (entry_b_id IS NULL)",
    )
    op.execute("""
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
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TABLE tournament_draw_revisions (
        id UUID DEFAULT gen_random_uuid() NOT NULL,
        event_id UUID NOT NULL,
        created_by_account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT clock_timestamp() NOT NULL,
        retired_at TIMESTAMP WITH TIME ZONE,
        retained_fixture_count BIGINT DEFAULT 0 NOT NULL,
        match_rules JSONB NOT NULL,
        format_rules JSONB NOT NULL,
        configuration JSONB DEFAULT '{}' ::jsonb NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT ck_draw_revision_fixture_count CHECK (retained_fixture_count >= 0),
        CONSTRAINT uq_draw_revision_event_id UNIQUE (event_id, id),
        CONSTRAINT ck_draw_revision_configuration_bytes
        CHECK (octet_length(configuration::text) <= 65536),
        CONSTRAINT ck_draw_revision_interval CHECK (retired_at IS NULL OR retired_at >=
        created_at),
        FOREIGN KEY(event_id) REFERENCES tournament_events (id) ON DELETE CASCADE
        )
        """)
    op.create_index(
        "ix_tournament_draw_revisions_created_by_account_id",
        "tournament_draw_revisions",
        ["created_by_account_id"],
    )
    op.execute("""
        CREATE UNIQUE INDEX uq_draw_revision_current_event ON tournament_draw_revisions
        (event_id) WHERE retired_at IS NULL
        """)
    op.add_column(
        "tournament_fixtures", sa.Column("draw_revision_id", sa.UUID(), nullable=False)
    )
    op.execute("""
        CREATE TRIGGER fixture_participation BEFORE INSERT OR UPDATE OF
        entry_a_id, entry_b_id, participation_a_id, participation_b_id,
        stage_id, group_id, draw_revision_id ON tournament_fixtures
        FOR EACH ROW EXECUTE FUNCTION fixture_participation()
        """)
    op.create_index(
        "ix_tournament_fixtures_draw_revision_id",
        "tournament_fixtures",
        ["draw_revision_id"],
    )
    op.create_foreign_key(
        "fk_fixture_draw_revision",
        "tournament_fixtures",
        "tournament_draw_revisions",
        ["scope_event_id", "draw_revision_id"],
        ["event_id", "id"],
        deferrable=True,
        initially="DEFERRED",
    )
    op.add_column(
        "tournament_event_stages",
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.drop_constraint(
        "uq_tournament_event_stages_event_id_position",
        "tournament_event_stages",
        type_="unique",
    )
    op.create_index(
        "uq_tournament_event_stages_event_id_position",
        "tournament_event_stages",
        ["event_id", "position"],
        unique=True,
        postgresql_where=sa.text("retired_at IS NULL"),
    )
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER fixture_z_draw_revision BEFORE INSERT ON tournament_fixtures
        FOR EACH ROW EXECUTE FUNCTION fixture_draw_revision()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER preserve_registration_history BEFORE UPDATE OR DELETE
        ON tournament_entry_registrations
        FOR EACH ROW EXECUTE FUNCTION preserve_registration_history()
        """)
    op.execute("""
        CREATE TABLE tournament_entry_withdrawals (
        id UUID DEFAULT gen_random_uuid() NOT NULL,
        event_id UUID NOT NULL,
        entry_id UUID NOT NULL,
        stage_id UUID,
        actor_account_id UUID NOT NULL,
        reason VARCHAR NOT NULL,
        explanation VARCHAR,
        withdrawn_at TIMESTAMP WITH TIME ZONE DEFAULT clock_timestamp() NOT NULL,
        restored_at TIMESTAMP WITH TIME ZONE,
        restored_by_account_id UUID,
        PRIMARY KEY (id),
        CONSTRAINT fk_withdrawal_event_entry FOREIGN KEY(event_id, entry_id) REFERENCES
        tournament_entries (event_id, id) ON DELETE CASCADE,
        CONSTRAINT fk_withdrawal_event_stage FOREIGN KEY(event_id, stage_id) REFERENCES
        tournament_event_stages (event_id, id),
        CONSTRAINT ck_withdrawal_restoration_actor CHECK ((restored_at IS NULL) =
        (restored_by_account_id IS NULL)),
        CONSTRAINT ck_withdrawal_interval CHECK (restored_at IS NULL OR restored_at >=
        withdrawn_at),
        FOREIGN KEY(actor_account_id) REFERENCES accounts (id) ON DELETE RESTRICT,
        FOREIGN KEY(restored_by_account_id) REFERENCES accounts (id) ON DELETE RESTRICT
        )
        """)
    op.execute("""
        CREATE UNIQUE INDEX uq_withdrawal_current_stage ON tournament_entry_withdrawals
        (entry_id, stage_id) WHERE stage_id IS NOT NULL AND restored_at IS NULL
        """)
    op.execute("""
        CREATE UNIQUE INDEX uq_withdrawal_current_event ON tournament_entry_withdrawals
        (entry_id) WHERE stage_id IS NULL AND restored_at IS NULL
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER check_participation_eligibility BEFORE INSERT
        ON tournament_entry_participations
        FOR EACH ROW EXECUTE FUNCTION check_participation_eligibility()
        """)
    # Draw history integrity (frozen baseline).
    op.execute("""
        ALTER TABLE tournament_entry_withdrawals ADD CONSTRAINT ck_withdrawal_reason
        CHECK (reason IN ( 'self_withdrawal' , 'director_removal' ,
        'identity_reconciliation' ));
        """)
    op.execute("""
        ALTER TABLE tournament_entry_participations ADD COLUMN draw_revision_id uuid NOT
        NULL;
        """)
    op.execute("""
        ALTER TABLE tournament_fixtures DROP CONSTRAINT fk_fixture_participation_a;
        """)
    op.execute("""
        ALTER TABLE tournament_fixtures DROP CONSTRAINT fk_fixture_participation_b;
        """)
    op.execute("""
        ALTER TABLE tournament_entry_participations DROP CONSTRAINT
        uq_participation_fixture_scope;
        """)
    op.execute("""
        ALTER TABLE tournament_entry_participations ADD CONSTRAINT
        uq_participation_fixture_scope UNIQUE (id, entry_id, stage_id, group_id,
        draw_revision_id);
        """)
    op.execute("""
        ALTER TABLE tournament_entry_participations ADD CONSTRAINT
        fk_participation_draw_revision FOREIGN KEY (event_id, draw_revision_id)
        REFERENCES tournament_draw_revisions(event_id,id) DEFERRABLE INITIALLY DEFERRED;
        """)
    op.execute("""
        ALTER TABLE tournament_fixtures ADD CONSTRAINT fk_fixture_participation_a
        FOREIGN KEY (participation_a_id,entry_a_id,stage_id,group_id,draw_revision_id)
        REFERENCES
        tournament_entry_participations(id,entry_id,stage_id,group_id,draw_revision_id)
        DEFERRABLE INITIALLY DEFERRED;
        """)
    op.execute("""
        ALTER TABLE tournament_fixtures ADD CONSTRAINT fk_fixture_participation_b
        FOREIGN KEY (participation_b_id,entry_b_id,stage_id,group_id,draw_revision_id)
        REFERENCES
        tournament_entry_participations(id,entry_id,stage_id,group_id,draw_revision_id)
        DEFERRABLE INITIALLY DEFERRED;
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER preserve_participation_history BEFORE UPDATE OR DELETE
        ON tournament_entry_participations FOR EACH ROW
        EXECUTE FUNCTION preserve_participation_history()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER preserve_draw_revision_history BEFORE UPDATE OR DELETE
        ON tournament_draw_revisions FOR EACH ROW
        EXECUTE FUNCTION preserve_draw_revision_history()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER a_assign_participation_revision BEFORE INSERT
        ON tournament_entry_participations FOR EACH ROW
        EXECUTE FUNCTION assign_participation_revision()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER a_preserve_retired_fixture_history BEFORE UPDATE OR DELETE
        ON tournament_fixtures FOR EACH ROW
        EXECUTE FUNCTION preserve_retired_fixture_history()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE CONSTRAINT TRIGGER check_fixture_draw_retirement
        AFTER INSERT OR UPDATE OF stage_id, draw_revision_id, retired_at
        ON tournament_fixtures
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION
        check_draw_retirement()
        """)
    op.execute("""
        CREATE CONSTRAINT TRIGGER check_revision_draw_retirement
        AFTER INSERT OR UPDATE OF retired_at ON tournament_draw_revisions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION
        check_draw_retirement()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER validate_new_fixture_seats AFTER UPDATE OF
        entry_a_id, entry_b_id, participation_a_id, participation_b_id,
        stage_id, group_id, draw_revision_id ON tournament_fixtures
        FOR EACH ROW EXECUTE FUNCTION
        validate_new_fixture_seats()
        """)
    op.execute("""
        CREATE CONSTRAINT TRIGGER check_participation_draw_retirement
        AFTER INSERT OR UPDATE ON tournament_entry_participations
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION
        check_draw_retirement()
        """)
    op.execute("""
        CREATE CONSTRAINT TRIGGER check_stage_draw_retirement
        AFTER UPDATE ON tournament_event_stages
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION
        check_draw_retirement()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER a_lock_draw_history_parent BEFORE INSERT OR DELETE
        ON tournament_draw_revisions FOR EACH ROW EXECUTE FUNCTION
        lock_draw_history_parent()
        """)
    op.execute("""
        CREATE TRIGGER a_lock_draw_history_parent BEFORE INSERT OR UPDATE OR DELETE
        ON tournament_entry_participations FOR EACH ROW EXECUTE FUNCTION
        lock_draw_history_parent()
        """)
    op.execute("""
        CREATE TRIGGER a_lock_draw_history_parent BEFORE INSERT OR UPDATE OR DELETE
        ON tournament_event_stages FOR EACH ROW EXECUTE FUNCTION
        lock_draw_history_parent()
        """)
    op.execute("""
        CREATE TRIGGER a_lock_draw_history_parent BEFORE INSERT OR UPDATE OR DELETE
        ON tournament_entry_withdrawals FOR EACH ROW EXECUTE FUNCTION
        lock_draw_history_parent()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER preserve_competition_withdrawal_history BEFORE UPDATE OR DELETE
        ON tournament_entry_withdrawals FOR EACH ROW
        EXECUTE FUNCTION preserve_competition_withdrawal_history()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER a_preserve_retired_stage_history BEFORE UPDATE OR DELETE
        ON tournament_event_stages FOR EACH ROW
        EXECUTE FUNCTION preserve_retired_stage_history()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER preserve_retired_table_history BEFORE UPDATE OR DELETE
        ON tournament_tables FOR EACH ROW
        EXECUTE FUNCTION preserve_retired_table_history()
        """)
    op.execute("""
        CREATE FUNCTION preserve_table_call_history() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
        RAISE EXCEPTION 'table call history is append-only' USING ERRCODE='23514';
        END $$
        """)
    op.execute("""
        CREATE TRIGGER preserve_table_call_history BEFORE UPDATE OR DELETE
        ON tournament_table_call_history FOR EACH ROW
        EXECUTE FUNCTION preserve_table_call_history()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER preserve_archived_group_history
        BEFORE INSERT OR UPDATE OR DELETE ON tournament_event_stage_groups
        FOR EACH ROW EXECUTE FUNCTION preserve_archived_group_history()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER preserve_archived_group_mapping
        BEFORE INSERT OR UPDATE OR DELETE ON tournament_event_group_reservations
        FOR EACH ROW EXECUTE FUNCTION preserve_archived_group_mapping()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER validate_fixture_insert_batch AFTER INSERT ON tournament_fixtures
        REFERENCING NEW TABLE AS inserted_fixtures FOR EACH STATEMENT
        EXECUTE FUNCTION validate_fixture_insert_batch()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE CONSTRAINT TRIGGER check_withdrawal_participation
        AFTER INSERT OR UPDATE ON tournament_entry_withdrawals
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION check_withdrawal_participation()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER lock_fixture_update_batch AFTER UPDATE ON tournament_fixtures
        REFERENCING OLD TABLE AS old_fixtures NEW TABLE AS new_fixtures
        FOR EACH STATEMENT EXECUTE FUNCTION lock_fixture_write_batch()
        """)
    op.execute("""
        CREATE TRIGGER lock_fixture_delete_batch AFTER DELETE ON tournament_fixtures
        REFERENCING OLD TABLE AS old_fixtures
        FOR EACH STATEMENT EXECUTE FUNCTION lock_fixture_write_batch()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE CONSTRAINT TRIGGER check_entry_lifecycle
        AFTER INSERT OR UPDATE ON tournament_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION check_entry_lifecycle()
        """)
    op.execute("""
        CREATE CONSTRAINT TRIGGER check_registration_entry_lifecycle
        AFTER INSERT OR UPDATE ON tournament_entry_registrations
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION check_entry_lifecycle()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER lock_registration_parent BEFORE INSERT OR UPDATE
        ON tournament_entry_registrations FOR EACH ROW
        EXECUTE FUNCTION lock_registration_parent()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER guard_draw_fixture_count
        BEFORE INSERT OR UPDATE OF retained_fixture_count ON tournament_draw_revisions
        FOR EACH ROW EXECUTE FUNCTION guard_draw_fixture_count()
        """)
    op.execute("""
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
        """)
    op.execute("""
        CREATE TRIGGER z_count_inserted_draw_fixtures AFTER INSERT
        ON tournament_fixtures
        REFERENCING NEW TABLE AS new_counted_fixtures FOR EACH STATEMENT
        EXECUTE FUNCTION update_draw_fixture_counts()
        """)
    op.execute("""
        CREATE TRIGGER a_lock_moved_fixture_revision
        BEFORE UPDATE OF draw_revision_id ON tournament_fixtures FOR EACH ROW
        WHEN (NEW.draw_revision_id IS DISTINCT FROM OLD.draw_revision_id)
        EXECUTE FUNCTION lock_draw_history_parent()
        """)
    op.execute("""
        CREATE TRIGGER z_count_updated_draw_fixtures AFTER UPDATE OF draw_revision_id
        ON tournament_fixtures FOR EACH ROW
        WHEN (NEW.draw_revision_id IS DISTINCT FROM OLD.draw_revision_id)
        EXECUTE FUNCTION update_draw_fixture_counts()
        """)
    op.execute("""
        CREATE TRIGGER z_count_deleted_draw_fixtures AFTER DELETE ON tournament_fixtures
        REFERENCING OLD TABLE AS old_counted_fixtures FOR EACH STATEMENT
        EXECUTE FUNCTION update_draw_fixture_counts()
        """)
    op.execute("""
        CREATE TRIGGER z_count_truncated_draw_fixtures AFTER TRUNCATE
        ON tournament_fixtures
        FOR EACH STATEMENT EXECUTE FUNCTION update_draw_fixture_counts()
        """)
    op.execute("""
        CREATE TRIGGER a_lock_draw_revision_update_parent
        BEFORE UPDATE ON tournament_draw_revisions FOR EACH ROW
        WHEN (NEW.retained_fixture_count = OLD.retained_fixture_count OR
        (to_jsonb(NEW) - 'retained_fixture_count') IS DISTINCT FROM
        (to_jsonb(OLD) - 'retained_fixture_count'))
        EXECUTE FUNCTION lock_draw_history_parent()
        """)
    # End draw history integrity.

    for statement in AUTHORITY_INTEGRITY_DDL:
        op.execute(statement)
    for statement in FIXTURE_INTEGRITY_DDL:
        op.execute(statement)
    for statement in ENTRY_SUPERSESSION_DDL:
        op.execute(statement)
    for statement in ENTRY_INTEGRITY_DDL:
        op.execute(statement)

    op.execute("""
        CREATE TABLE match_official_results (
            id uuid PRIMARY KEY,
            match_id uuid NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
            revision integer NOT NULL,
            predecessor_id uuid,
            restored_from_id uuid,
            proposal_id uuid,
            resolution_method varchar NOT NULL,
            actor_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
            recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            games jsonb NOT NULL,
            timeout_deadline timestamptz,
            timeout_policy varchar,
            reason varchar,
            tournament_id uuid REFERENCES tournaments(id) ON DELETE RESTRICT,
            owner_revision integer,
            director_grant_id uuid REFERENCES tournament_account_grants(id) ON DELETE RESTRICT,
            CONSTRAINT ck_official_results_method CHECK (resolution_method IN ('opponent_acceptance', 'timeout', 'administrator_ruling', 'immediate_finalization')),
            CONSTRAINT ck_official_results_actor CHECK ((resolution_method = 'timeout' AND actor_account_id IS NULL) OR (resolution_method <> 'timeout' AND actor_account_id IS NOT NULL)),
            CONSTRAINT ck_official_results_single_source CHECK (proposal_id IS NULL OR restored_from_id IS NULL),
            CONSTRAINT ck_official_results_source CHECK (resolution_method = 'administrator_ruling' OR (proposal_id IS NOT NULL AND predecessor_id IS NULL AND restored_from_id IS NULL)),
            CONSTRAINT ck_official_results_authority CHECK ((resolution_method = 'administrator_ruling' AND tournament_id IS NOT NULL AND reason IS NOT NULL AND reason ~ '[^[:space:]]' AND ((owner_revision IS NOT NULL AND owner_revision >= 0 AND director_grant_id IS NULL) OR (owner_revision IS NULL AND director_grant_id IS NOT NULL))) OR (resolution_method <> 'administrator_ruling' AND tournament_id IS NULL AND reason IS NULL AND owner_revision IS NULL AND director_grant_id IS NULL)),
            CONSTRAINT ck_official_results_timeout CHECK ((resolution_method = 'timeout' AND timeout_deadline IS NOT NULL AND timeout_policy IS NOT NULL AND timeout_policy = 'retirement_window_v1' AND recorded_at >= timeout_deadline) OR (resolution_method <> 'timeout' AND timeout_deadline IS NULL AND timeout_policy IS NULL)),
            CONSTRAINT ck_official_results_games CHECK (jsonb_typeof(games) = 'array' AND jsonb_array_length(games) > 0),
            CONSTRAINT uq_official_results_id_match UNIQUE(id, match_id),
            CONSTRAINT uq_official_results_revision UNIQUE(match_id, revision),
            CONSTRAINT uq_official_results_successor UNIQUE(predecessor_id),
            CONSTRAINT ck_official_results_root_number CHECK ((revision = 1 AND predecessor_id IS NULL) OR (revision > 1 AND predecessor_id IS NOT NULL)),
            CONSTRAINT ck_official_results_not_self CHECK (id <> predecessor_id),
            CONSTRAINT fk_official_results_predecessor FOREIGN KEY (predecessor_id, match_id) REFERENCES match_official_results(id, match_id) ON DELETE RESTRICT,
            CONSTRAINT fk_official_results_restored FOREIGN KEY (restored_from_id, match_id) REFERENCES match_official_results(id, match_id) ON DELETE RESTRICT,
            CONSTRAINT fk_official_results_proposal FOREIGN KEY (proposal_id, match_id) REFERENCES match_results(id, match_id) ON DELETE RESTRICT
        )
    """)
    op.add_column(
        "matches", sa.Column("current_official_result_id", sa.UUID(), nullable=True)
    )

    op.create_foreign_key(
        "fk_matches_current_official",
        "matches",
        "match_official_results",
        ["current_official_result_id", "id"],
        ["id", "match_id"],
    )

    op.execute("""
        CREATE FUNCTION preserve_official_result() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'official result history is immutable' USING ERRCODE = '23514';
        END; $$
    """)
    op.execute("""
        CREATE TRIGGER preserve_official_result BEFORE UPDATE OR DELETE ON match_official_results
        FOR EACH ROW EXECUTE FUNCTION preserve_official_result()
    """)
    op.execute("""
        CREATE FUNCTION guard_current_official_result() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE latest uuid;
        BEGIN
            SELECT id INTO latest FROM match_official_results
              WHERE match_id = NEW.id ORDER BY revision DESC LIMIT 1;
            IF NEW.current_official_result_id IS DISTINCT FROM latest THEN
                RAISE EXCEPTION 'current official result must be the latest revision'
                  USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END; $$
    """)
    op.execute("""
        CREATE TRIGGER guard_current_official_result BEFORE UPDATE OF current_official_result_id ON matches
        FOR EACH ROW EXECUTE FUNCTION guard_current_official_result()
    """)

    op.execute(
        "CREATE UNIQUE INDEX uq_official_results_root ON match_official_results(match_id) WHERE predecessor_id IS NULL"
    )
    op.execute("""
        CREATE FUNCTION append_official_result() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE current_id uuid; prior match_official_results;
            parent matches; settings match_settings; proposal match_results;
            tournament tournaments; game jsonb; n integer := 0;
            a integer; b integer; wins_a integer := 0; wins_b integer := 0; target integer;
        BEGIN
            -- Same parent ordering as backend transitions; NOWAIT avoids inverted
            -- locks held by arbitrary SQL callers and yields an explicit retry.
            BEGIN
                PERFORM id FROM accounts WHERE id = NEW.actor_account_id FOR KEY SHARE NOWAIT;
                SELECT t.* INTO tournament FROM tournaments t
                    JOIN tournament_events e ON e.tournament_id = t.id
                    JOIN tournament_event_stages s ON s.event_id = e.id
                    JOIN tournament_fixtures f ON f.stage_id = s.id
                    WHERE f.match_id = NEW.match_id FOR SHARE OF t NOWAIT;
                PERFORM e.id FROM tournament_events e
                    JOIN tournament_event_stages s ON s.event_id = e.id
                    JOIN tournament_fixtures f ON f.stage_id = s.id
                    WHERE f.match_id = NEW.match_id FOR UPDATE OF e NOWAIT;
                -- A grant can change without a new tournament row version.
                -- Lock its row so stale Repeatable Read snapshots fail too.
                PERFORM id FROM tournament_account_grants
                    WHERE id = NEW.director_grant_id FOR SHARE NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION 'official result requires parent locks; retry' USING ERRCODE = '40001';
            END;
            UPDATE matches SET id = id WHERE id = NEW.match_id RETURNING * INTO parent;
            current_id := parent.current_official_result_id;
            IF parent.id IS NULL OR parent.status = 'voided' THEN
                RAISE EXCEPTION 'official result requires a non-voided match' USING ERRCODE = '23514';
            END IF;
            NEW.recorded_at := clock_timestamp();
            IF NEW.actor_account_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM accounts WHERE id = NEW.actor_account_id AND merged_at IS NULL
            ) THEN
                RAISE EXCEPTION 'official actor must be active' USING ERRCODE = '23514';
            END IF;
            IF NEW.resolution_method = 'administrator_ruling' THEN
                IF tournament.id IS NULL OR NEW.tournament_id IS DISTINCT FROM tournament.id
                    OR NOT tournament_can_direct(tournament.id, NEW.actor_account_id) THEN
                    RAISE EXCEPTION 'ruling requires tournament authority' USING ERRCODE = '23514';
                END IF;
                IF NEW.owner_revision IS NOT NULL AND (
                    NEW.owner_revision <> tournament.ownership_revision
                    OR NEW.actor_account_id IS DISTINCT FROM tournament.owner_account_id
                ) THEN
                    RAISE EXCEPTION 'ruling ownership evidence is stale' USING ERRCODE = '23514';
                END IF;
                IF NEW.director_grant_id IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM tournament_account_grants WHERE id = NEW.director_grant_id
                    AND tournament_id = tournament.id AND account_id = NEW.actor_account_id
                    AND role = 'director' AND revoked_at IS NULL
                ) THEN
                    RAISE EXCEPTION 'ruling grant evidence is invalid' USING ERRCODE = '23514';
                END IF;
            END IF;
            SELECT * INTO settings FROM match_settings WHERE id = parent.match_settings_id;
            IF NEW.proposal_id IS NOT NULL THEN
                SELECT * INTO proposal FROM match_results WHERE id = NEW.proposal_id AND match_id = NEW.match_id;
                IF NOT FOUND OR NEW.games IS DISTINCT FROM proposal.games THEN
                    RAISE EXCEPTION 'adopted proposal must match its snapshot' USING ERRCODE = '23514';
                END IF;
            END IF;
            IF NEW.restored_from_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM match_official_results WHERE id = NEW.restored_from_id
                  AND match_id = NEW.match_id AND games = NEW.games
            ) THEN
                RAISE EXCEPTION 'restoration must copy an existing same-match score' USING ERRCODE = '23514';
            END IF;
            IF NEW.resolution_method <> 'administrator_ruling' THEN
                IF NOT proposal.participant_authorized THEN
                    RAISE EXCEPTION 'official result requires participant authority at submission'
                        USING ERRCODE = '23514';
                END IF;
                IF EXISTS (SELECT 1 FROM match_results WHERE supersedes_result_id = NEW.proposal_id) THEN
                    RAISE EXCEPTION 'only the proposal head may finalize' USING ERRCODE = '23514';
                END IF;
                IF NEW.resolution_method = 'opponent_acceptance' AND (
                    NEW.actor_account_id = proposal.submitted_by_user_id
                    OR proposal.accepted_by_user_id IS DISTINCT FROM NEW.actor_account_id
                    OR proposal.accepted_at IS NULL OR NOT EXISTS (
                        SELECT 1 FROM account_players ap JOIN match_side_players p ON p.user_id = ap.player_id
                        JOIN match_side_players submitter ON submitter.match_id = p.match_id
                        WHERE ap.account_id = NEW.actor_account_id AND ap.is_primary
                          AND p.match_id = NEW.match_id
                          AND submitter.user_id = proposal.submitted_for_player_id
                          AND p.match_side_id <> submitter.match_side_id
                    )
                ) THEN
                    RAISE EXCEPTION 'opponent acceptance requires recorded opposing consent' USING ERRCODE = '23514';
                END IF;
                IF NEW.resolution_method IN ('timeout', 'immediate_finalization') AND proposal.accepted_at IS NOT NULL THEN
                    RAISE EXCEPTION 'automatic finalization cannot record human acceptance' USING ERRCODE = '23514';
                END IF;
                IF NEW.resolution_method = 'immediate_finalization' AND NOT EXISTS (
                    SELECT 1 FROM account_players ap
                    JOIN match_side_players p ON p.user_id = ap.player_id
                    WHERE ap.account_id = NEW.actor_account_id
                      AND ap.player_id = proposal.submitted_for_player_id
                      AND p.match_id = NEW.match_id
                ) THEN
                    RAISE EXCEPTION 'immediate finalization requires a managed participant'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.resolution_method = 'immediate_finalization' AND (
                    NEW.actor_account_id IS DISTINCT FROM proposal.submitted_by_user_id
                    OR proposal.submitted_for_player_id IS NULL
                    OR (settings.affects_rating AND (SELECT count(DISTINCT match_side_id) FROM match_side_players WHERE match_id = NEW.match_id) >= 2)
                ) THEN
                    RAISE EXCEPTION 'immediate finalization requires the existing solo or unrated rule' USING ERRCODE = '23514';
                END IF;
                IF NEW.resolution_method = 'timeout' AND (
                    NOT settings.affects_rating OR
                    (SELECT count(DISTINCT match_side_id) FROM match_side_players WHERE match_id = NEW.match_id) < 2 OR
                    settings.retirement_window IS NULL OR
                    NEW.timeout_deadline IS DISTINCT FROM proposal.submitted_at + settings.retirement_window
                ) THEN
                    RAISE EXCEPTION 'timeout deadline must follow the proposal policy' USING ERRCODE = '23514';
                END IF;
            END IF;
            -- Parse the complete score snapshot before it can become immutable.
            target := settings.best_of / 2 + 1;
            IF jsonb_typeof(NEW.games) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.games) = 0 THEN
                RAISE EXCEPTION 'official score requires games' USING ERRCODE = '23514';
            END IF;
            FOR game IN SELECT value FROM jsonb_array_elements(NEW.games) LOOP
                n := n + 1;
                IF jsonb_typeof(game) IS DISTINCT FROM 'object'
                    OR NOT (game ?& ARRAY['game_number','side_1_points','side_2_points'])
                    OR game - ARRAY['game_number','side_1_points','side_2_points'] <> '{}'::jsonb
                    OR (game->>'game_number') !~ '^[0-9]+$'
                    OR (game->>'side_1_points') !~ '^[0-9]+$'
                    OR (game->>'side_2_points') !~ '^[0-9]+$'
                    OR jsonb_typeof(game->'game_number') <> 'number'
                    OR jsonb_typeof(game->'side_1_points') <> 'number'
                    OR jsonb_typeof(game->'side_2_points') <> 'number'
                    OR game->'game_number' = 'null'::jsonb
                    OR game->'side_1_points' = 'null'::jsonb
                    OR game->'side_2_points' = 'null'::jsonb THEN
                    RAISE EXCEPTION 'invalid official game shape' USING ERRCODE = '23514';
                END IF;
                BEGIN
                    a := (game->>'side_1_points')::integer;
                    b := (game->>'side_2_points')::integer;
                    IF (game->>'game_number')::integer <> n OR n > settings.best_of
                        OR wins_a >= target OR wins_b >= target
                        OR NOT ((greatest(a,b) = 11 AND least(a,b) <= 9)
                            OR (greatest(a,b) > 11 AND abs(a-b) = 2)) THEN
                        RAISE EXCEPTION 'invalid official score' USING ERRCODE = '23514';
                    END IF;
                EXCEPTION WHEN numeric_value_out_of_range THEN
                    RAISE EXCEPTION 'official score out of range' USING ERRCODE = '23514';
                END;
                IF a > b THEN wins_a := wins_a + 1; ELSE wins_b := wins_b + 1; END IF;
            END LOOP;
            IF greatest(wins_a, wins_b) <> target THEN
                RAISE EXCEPTION 'official score must decide the match' USING ERRCODE = '23514';
            END IF;
            IF NEW.predecessor_id IS DISTINCT FROM current_id THEN
                RAISE EXCEPTION 'stale official result predecessor' USING ERRCODE = '23514';
            END IF;
            IF NEW.predecessor_id IS NOT NULL THEN
                SELECT * INTO prior FROM match_official_results WHERE id = NEW.predecessor_id AND match_id = NEW.match_id;
                IF NOT FOUND OR NEW.revision <> prior.revision + 1 THEN
                    RAISE EXCEPTION 'official predecessor must already exist in sequence' USING ERRCODE = '23514';
                END IF;
            END IF;
            RETURN NEW;
        END; $$
    """)
    op.execute("""
        CREATE TRIGGER append_official_result BEFORE INSERT ON match_official_results
        FOR EACH ROW EXECUTE FUNCTION append_official_result()
    """)
    op.execute("""
        CREATE FUNCTION advance_official_result() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE game jsonb; game_id uuid; wins_a integer := 0; wins_b integer := 0;
        BEGIN
            -- Official appends change every public score representation in this
            -- same statement, including when the caller bypasses the service.
            DELETE FROM match_games WHERE match_id = NEW.match_id
                AND game_number > jsonb_array_length(NEW.games);
            FOR game IN SELECT value FROM jsonb_array_elements(NEW.games) LOOP
                INSERT INTO match_games (match_id, game_number)
                VALUES (NEW.match_id, (game->>'game_number')::integer)
                ON CONFLICT (match_id, game_number) DO UPDATE SET updated_at = clock_timestamp()
                RETURNING id INTO game_id;
                INSERT INTO match_game_scores (match_game_id, side_1_points, side_2_points)
                VALUES (game_id, (game->>'side_1_points')::integer, (game->>'side_2_points')::integer)
                ON CONFLICT (match_game_id) DO UPDATE SET
                    side_1_points = EXCLUDED.side_1_points,
                    side_2_points = EXCLUDED.side_2_points,
                    version = match_game_scores.version + 1,
                    updated_at = clock_timestamp()
                WHERE (match_game_scores.side_1_points, match_game_scores.side_2_points)
                    IS DISTINCT FROM (EXCLUDED.side_1_points, EXCLUDED.side_2_points);
                IF (game->>'side_1_points')::integer > (game->>'side_2_points')::integer THEN
                    wins_a := wins_a + 1;
                ELSE
                    wins_b := wins_b + 1;
                END IF;
            END LOOP;
            UPDATE match_sides SET
                score = CASE WHEN side_number = 1 THEN wins_a ELSE wins_b END,
                won = CASE WHEN side_number = 1 THEN wins_a > wins_b ELSE wins_b > wins_a END
                WHERE match_id = NEW.match_id;
            UPDATE matches SET current_official_result_id = NEW.id WHERE id = NEW.match_id;
            RETURN NEW;
        END; $$
    """)
    op.execute("""
        CREATE TRIGGER advance_official_result AFTER INSERT ON match_official_results
        FOR EACH ROW EXECUTE FUNCTION advance_official_result()
    """)

    op.execute("""
        CREATE FUNCTION require_official_completion() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE target_id uuid; parent matches;
        BEGIN
            IF TG_TABLE_NAME = 'matches' THEN target_id := NEW.id;
            ELSE target_id := NEW.match_id;
            END IF;
            SELECT * INTO parent FROM matches WHERE id = target_id;
            IF parent.current_official_result_id IS NOT NULL AND
                (parent.status NOT IN ('completed', 'voided') OR parent.completed_at IS NULL) THEN
                RAISE EXCEPTION 'official result requires a completed match by commit'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END; $$
    """)
    op.execute("""
        CREATE CONSTRAINT TRIGGER require_official_completion
        AFTER INSERT ON match_official_results DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION require_official_completion()
    """)
    op.execute("""
        CREATE CONSTRAINT TRIGGER preserve_official_completion
        AFTER UPDATE ON matches DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION require_official_completion()
    """)

    op.execute("""
        CREATE TABLE match_void_actions (
            id uuid PRIMARY KEY,
            match_id uuid NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
            official_result_id uuid,
            actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
            reason varchar NOT NULL,
            tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE RESTRICT,
            owner_revision integer,
            director_grant_id uuid REFERENCES tournament_account_grants(id) ON DELETE RESTRICT,
            recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT uq_match_void_actions_match UNIQUE(match_id),
            CONSTRAINT fk_match_void_actions_result FOREIGN KEY (official_result_id, match_id) REFERENCES match_official_results(id, match_id) ON DELETE RESTRICT,
            CONSTRAINT ck_match_void_actions_reason CHECK (reason ~ '[^[:space:]]'),
            CONSTRAINT ck_match_void_actions_authority CHECK ((owner_revision IS NOT NULL AND owner_revision >= 0 AND director_grant_id IS NULL) OR (owner_revision IS NULL AND director_grant_id IS NOT NULL))
        )
    """)
    op.execute("""
        CREATE TRIGGER preserve_void_action BEFORE UPDATE OR DELETE ON match_void_actions
        FOR EACH ROW EXECUTE FUNCTION preserve_official_result()
    """)

    op.execute("""
        CREATE FUNCTION guard_administrator_void() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE parent matches; tournament tournaments;
        BEGIN
            BEGIN
                PERFORM id FROM accounts WHERE id = NEW.actor_account_id FOR KEY SHARE NOWAIT;
                SELECT t.* INTO tournament FROM tournaments t
                    JOIN tournament_events e ON e.tournament_id = t.id
                    JOIN tournament_event_stages s ON s.event_id = e.id
                    JOIN tournament_fixtures f ON f.stage_id = s.id
                    WHERE f.match_id = NEW.match_id FOR SHARE OF t NOWAIT;
                PERFORM e.id FROM tournament_events e
                    JOIN tournament_event_stages s ON s.event_id = e.id
                    JOIN tournament_fixtures f ON f.stage_id = s.id
                    WHERE f.match_id = NEW.match_id FOR UPDATE OF e NOWAIT;
                -- A grant can change without a new tournament row version.
                -- Lock its row so stale Repeatable Read snapshots fail too.
                PERFORM id FROM tournament_account_grants
                    WHERE id = NEW.director_grant_id FOR SHARE NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION 'void action requires parent locks; retry' USING ERRCODE = '40001';
            END;
            UPDATE matches SET id = id WHERE id = NEW.match_id RETURNING * INTO parent;
            IF parent.id IS NULL OR parent.status = 'voided'
                OR NEW.official_result_id IS DISTINCT FROM parent.current_official_result_id
                OR tournament.id IS NULL OR NEW.tournament_id IS DISTINCT FROM tournament.id
                OR NOT tournament_can_direct(tournament.id, NEW.actor_account_id) THEN
                RAISE EXCEPTION 'void requires current match and tournament authority' USING ERRCODE = '23514';
            END IF;
            IF NEW.owner_revision IS NOT NULL AND (
                NEW.owner_revision <> tournament.ownership_revision
                OR NEW.actor_account_id IS DISTINCT FROM tournament.owner_account_id
            ) THEN
                RAISE EXCEPTION 'void ownership evidence is stale' USING ERRCODE = '23514';
            END IF;
            IF NEW.director_grant_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM tournament_account_grants WHERE id = NEW.director_grant_id
                AND tournament_id = tournament.id AND account_id = NEW.actor_account_id
                AND role = 'director' AND revoked_at IS NULL
            ) THEN
                RAISE EXCEPTION 'void grant evidence is invalid' USING ERRCODE = '23514';
            END IF;
            NEW.recorded_at := clock_timestamp();
            RETURN NEW;
        END; $$
    """)
    op.execute("""
        CREATE TRIGGER guard_administrator_void BEFORE INSERT ON match_void_actions
        FOR EACH ROW EXECUTE FUNCTION guard_administrator_void()
    """)
    op.execute("""
        CREATE FUNCTION apply_administrator_void() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            UPDATE matches SET status = 'voided' WHERE id = NEW.match_id;
            UPDATE match_sides SET won = NULL WHERE match_id = NEW.match_id;
            DELETE FROM rating_history WHERE match_id = NEW.match_id;
            RETURN NEW;
        END; $$
    """)
    op.execute("""
        CREATE TRIGGER apply_administrator_void AFTER INSERT ON match_void_actions
        FOR EACH ROW EXECUTE FUNCTION apply_administrator_void()
    """)

    op.create_check_constraint(
        "ck_rating_history_state_value",
        "rating_history",
        "(jsonb_typeof(rating_state) = 'object' AND jsonb_typeof(rating_state -> 'rating') = 'number' AND (rating_state ->> 'rating')::float8 = rating_value AND rating_value > '-Infinity'::float8 AND rating_value < 'Infinity'::float8) IS TRUE",
    )
    op.create_check_constraint(
        "ck_user_league_ratings_state_value",
        "user_league_ratings",
        "((rating_state IS NULL OR rating_state = 'null'::jsonb) AND rating_value IS NULL) OR ((jsonb_typeof(rating_state) = 'object' AND jsonb_typeof(rating_state -> 'rating') = 'number' AND (rating_state ->> 'rating')::float8 = rating_value AND rating_value > '-Infinity'::float8 AND rating_value < 'Infinity'::float8) IS TRUE)",
    )
    op.create_check_constraint(
        "ck_rating_history_source_provenance",
        "rating_history",
        "(source = 'match' AND match_id IS NOT NULL AND official_result_id IS NOT NULL AND rating_input_id IS NULL) OR (source IN ('manual', 'import') AND match_id IS NULL AND official_result_id IS NULL AND rating_input_id IS NOT NULL) OR (source = 'initial' AND match_id IS NULL AND official_result_id IS NULL AND rating_input_id IS NULL)",
    )
    op.create_foreign_key(
        "fk_rating_history_match_basis",
        "rating_history",
        "match_rating_bases",
        ["match_id", "rating_strategy_id"],
        ["match_id", "rating_strategy_id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_rating_history_official_result_match",
        "rating_history",
        "match_official_results",
        ["official_result_id", "match_id"],
        ["id", "match_id"],
        ondelete="RESTRICT",
    )
    op.execute("""
        CREATE FUNCTION guard_rating_input() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE previous rating_inputs;
        BEGIN
            IF TG_OP <> 'INSERT' THEN
                RAISE EXCEPTION 'rating inputs are immutable' USING ERRCODE = '23514';
            END IF;
            IF NEW.supersedes_id IS NOT NULL THEN
                SELECT * INTO previous FROM rating_inputs WHERE id = NEW.supersedes_id FOR UPDATE;
                IF NOT FOUND OR
                   (NEW.league_id, NEW.player_id, NEW.rating_strategy_id, NEW.source, NEW.effective_at)
                   IS DISTINCT FROM
                   (previous.league_id, previous.player_id, previous.rating_strategy_id, previous.source, previous.effective_at)
                THEN
                    RAISE EXCEPTION 'replacement must preserve input provenance and effective time' USING ERRCODE = '23514';
                END IF;
            END IF;
            RETURN NEW;
        END $$;
    """)
    op.execute("""
        CREATE TRIGGER rating_input_immutable BEFORE INSERT OR UPDATE OR DELETE ON rating_inputs
        FOR EACH ROW EXECUTE FUNCTION guard_rating_input();
    """)

    op.execute("""
        CREATE FUNCTION reject_rating_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'rating fact is immutable; create a new version' USING ERRCODE = '23514';
        END $$
    """)
    for table in ("rating_strategies", "match_rating_bases"):
        op.execute(
            f"CREATE TRIGGER immutable_rating_fact BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION reject_rating_fact_mutation()"
        )
    op.execute("""
        CREATE FUNCTION bind_match_rating_strategy() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW.revision = 1 THEN
                INSERT INTO match_rating_bases(match_id, rating_strategy_id)
                SELECT m.id, l.rating_strategy_id FROM matches m
                JOIN leagues l ON l.id = m.league_id
                JOIN match_settings settings ON settings.id = m.match_settings_id
                JOIN rating_strategies strategy ON strategy.id = l.rating_strategy_id
                WHERE m.id = NEW.match_id AND settings.affects_rating AND strategy.is_automatic;
            END IF;
            RETURN NEW;
        END $$
    """)
    op.execute(
        "CREATE TRIGGER official_rating_basis AFTER INSERT ON match_official_results FOR EACH ROW EXECUTE FUNCTION bind_match_rating_strategy()"
    )

    op.execute("""
        CREATE FUNCTION guard_rating_projection() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE fact rating_inputs; current_revision uuid; match_league uuid;
        BEGIN
            IF NEW.source IN ('manual', 'import') THEN
                SELECT * INTO fact FROM rating_inputs WHERE id = NEW.rating_input_id;
                IF NOT FOUND OR EXISTS (SELECT 1 FROM rating_inputs WHERE supersedes_id = fact.id)
                   OR (NEW.league_id, NEW.user_id, NEW.rating_strategy_id, NEW.source::text,
                       NEW.created_by_user_id, NEW.created_at, NEW.rating_value)
                   IS DISTINCT FROM
                      (fact.league_id, entry_canonical_player(fact.player_id), fact.rating_strategy_id,
                       fact.source, fact.actor_account_id, fact.effective_at, fact.rating)
                THEN
                    RAISE EXCEPTION 'projection must match its active rating input' USING ERRCODE = '23514';
                END IF;
            ELSIF NEW.source = 'match' THEN
                SELECT current_official_result_id, league_id INTO current_revision, match_league
                FROM matches WHERE id = NEW.match_id;
                IF NEW.official_result_id IS DISTINCT FROM current_revision OR NEW.league_id IS DISTINCT FROM match_league THEN
                    RAISE EXCEPTION 'projection must use the current official result and league' USING ERRCODE = '23514';
                END IF;
            END IF;
            RETURN NEW;
        END $$
    """)
    op.execute(
        "CREATE TRIGGER rating_projection_provenance BEFORE INSERT OR UPDATE ON rating_history FOR EACH ROW EXECUTE FUNCTION guard_rating_projection()"
    )

    op.execute("""
        CREATE FUNCTION rating_input_order(input_uuid uuid) RETURNS bigint
        LANGUAGE sql STABLE AS $$
            WITH RECURSIVE chain AS (
                SELECT id, supersedes_id, sequence FROM rating_inputs WHERE id = input_uuid
                UNION ALL
                SELECT prior.id, prior.supersedes_id, prior.sequence
                FROM rating_inputs prior JOIN chain ON prior.id = chain.supersedes_id
            )
            SELECT sequence FROM chain WHERE supersedes_id IS NULL
        $$
    """)

    op.execute("""
        CREATE FUNCTION require_rating_reconciliation() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE parent matches; participant uuid;
        BEGIN
            SELECT * INTO parent FROM matches WHERE id = NEW.match_id;
            IF NEW.revision = 1 OR parent.status <> 'completed'
               OR NOT EXISTS (SELECT 1 FROM match_rating_bases WHERE match_id = parent.id)
               OR NOT EXISTS (SELECT 1 FROM match_settings
                              WHERE id = parent.match_settings_id AND team_size = 1)
               OR (SELECT count(DISTINCT match_side_id) FROM match_side_players
                   WHERE match_id = parent.id) <> 2
            THEN
                RETURN NULL;
            END IF;
            FOR participant IN
                SELECT entry_canonical_player(user_id) FROM match_side_players
                WHERE match_id = parent.id
            LOOP
                IF NOT EXISTS (
                    SELECT 1 FROM rating_history
                    WHERE match_id = parent.id AND user_id = participant
                      AND official_result_id = parent.current_official_result_id
                ) OR NOT EXISTS (
                    SELECT 1 FROM user_league_ratings current_rating
                    JOIN LATERAL (
                        SELECT rating_state FROM rating_history
                        WHERE league_id = parent.league_id AND user_id = participant
                        ORDER BY created_at DESC, match_id DESC NULLS LAST,
                                 rating_input_order(rating_input_id) DESC NULLS LAST
                        LIMIT 1
                    ) latest ON current_rating.rating_state = latest.rating_state
                    WHERE current_rating.league_id = parent.league_id
                      AND current_rating.user_id = participant
                ) THEN
                    RAISE EXCEPTION 'rated correction requires rating reconciliation'
                        USING ERRCODE = '23514';
                END IF;
            END LOOP;
            RETURN NULL;
        END $$
    """)
    op.execute("""
        CREATE CONSTRAINT TRIGGER require_rating_reconciliation
        AFTER INSERT ON match_official_results DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION require_rating_reconciliation()
    """)

    for statement in (*ADVANCEMENT_TABLE_DDL, *ADVANCEMENT_INTEGRITY_DDL):
        op.execute(statement)

    op.create_table(
        "tournament_event_recorded_games",
        sa.Column(
            "match_id",
            sa.UUID(),
            sa.ForeignKey("matches.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
        sa.Column("game_number", sa.Integer(), primary_key=True),
        sa.Column(
            "event_id",
            sa.UUID(),
            sa.ForeignKey("tournament_events.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "observed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
    )
    op.create_table(
        "tournament_event_lifecycle_history",
        sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "event_id",
            sa.UUID(),
            sa.ForeignKey("tournament_events.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column(
            "from_state",
            postgresql.ENUM(
                "unstarted",
                "in_progress",
                "finished",
                "cancelled",
                name="event_lifecycle_state",
                create_type=False,
            ),
            nullable=False,
        ),
        sa.Column(
            "to_state",
            postgresql.ENUM(
                "unstarted",
                "in_progress",
                "finished",
                "cancelled",
                name="event_lifecycle_state",
                create_type=False,
            ),
            nullable=False,
        ),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint(
            "event_id", "version", name="uq_event_lifecycle_history_version"
        ),
        sa.CheckConstraint(
            "version > 0 AND from_state <> to_state",
            name="ck_event_lifecycle_transition",
        ),
        sa.CheckConstraint(
            "occurred_at IS NULL OR occurred_at <= observed_at",
            name="ck_event_lifecycle_chronology",
        ),
    )
    for statement in EVENT_LIFECYCLE_DDL:
        op.execute(statement)

    op.create_table(
        "tournament_archive_history",
        sa.Column(
            "tournament_id",
            sa.UUID(),
            sa.ForeignKey("tournaments.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True)),
    )
    for statement in ARCHIVE_DDL:
        op.execute(statement)

    op.create_table(
        "tournament_event_reconciliations",
        sa.Column(
            "event_id",
            sa.UUID(),
            sa.ForeignKey("tournament_events.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
        sa.Column("lifecycle_state", sa.String(), nullable=False),
        sa.Column("lifecycle_version", sa.Integer(), nullable=False),
        sa.Column("transaction_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "reconciled", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
    )
    for statement in RECONCILIATION_DDL:
        op.execute(statement)

    op.create_table(
        "required_repairs",
        sa.Column(
            "dispatch_after",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "available_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("failures", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text()),
        sa.CheckConstraint("failures >= 0", name="ck_required_repairs_failures"),
        sa.Column(
            "state",
            sa.Enum("pending", "running", "completed", "failed", name="repair_state"),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("claim_token", sa.UUID()),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "(state = 'running') = (claim_token IS NOT NULL AND lease_until IS NOT NULL) AND ((claim_token IS NULL) = (lease_until IS NULL))",
            name="ck_required_repairs_lease",
        ),
        sa.CheckConstraint(
            "(state = 'completed') = (requested_generation = completed_generation) AND ((state = 'completed') = (completed_at IS NOT NULL))",
            name="ck_required_repairs_completion",
        ),
        sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "player_id", sa.UUID(), sa.ForeignKey("players.id", ondelete="RESTRICT")
        ),
        sa.Column(
            "tournament_id",
            sa.UUID(),
            sa.ForeignKey("tournaments.id", ondelete="CASCADE"),
        ),
        sa.Column(
            "requested_generation", sa.Integer(), nullable=False, server_default="1"
        ),
        sa.Column(
            "completed_generation", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.CheckConstraint(
            "num_nonnulls(player_id, tournament_id) = 1",
            name="ck_required_repairs_target",
        ),
        sa.CheckConstraint(
            "requested_generation > 0 AND completed_generation >= 0 AND completed_generation <= requested_generation",
            name="ck_required_repairs_generations",
        ),
        sa.UniqueConstraint("player_id", name="uq_required_repairs_player"),
        sa.UniqueConstraint("tournament_id", name="uq_required_repairs_tournament"),
    )

    op.create_index(
        "ix_required_repairs_recovery", "required_repairs", ["state", "dispatch_after"]
    )
    op.create_table(
        "required_repair_attempts",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "repair_id",
            sa.UUID(),
            sa.ForeignKey("required_repairs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("outcome", sa.Text(), nullable=False, server_default="running"),
        sa.Column("error", sa.Text()),
        sa.CheckConstraint(
            "generation > 0", name="ck_required_repair_attempts_generation"
        ),
        sa.CheckConstraint(
            "outcome IN ('running', 'completed', 'expired', 'transient', 'permanent')",
            name="ck_required_repair_attempts_outcome",
        ),
        sa.CheckConstraint(
            "(outcome = 'running') = (finished_at IS NULL)",
            name="ck_required_repair_attempts_finished",
        ),
    )
    op.create_index(
        "ix_required_repair_attempts_repair_id",
        "required_repair_attempts",
        ["repair_id"],
    )

    op.add_column(
        "tournament_event_stages",
        sa.Column("rule_revision_id", sa.UUID(), nullable=True),
    )
    op.create_index(
        "ix_tournament_event_stages_rule_revision_id",
        "tournament_event_stages",
        ["rule_revision_id"],
    )
    op.create_foreign_key(
        "fk_stage_owned_rule_revision",
        "tournament_event_stages",
        "tournament_draw_revisions",
        ["event_id", "rule_revision_id"],
        ["event_id", "id"],
        ondelete="RESTRICT",
    )
    op.add_column(
        "match_settings", sa.Column("source_rule_revision_id", sa.UUID(), nullable=True)
    )
    op.create_index(
        "ix_match_settings_source_rule_revision_id",
        "match_settings",
        ["source_rule_revision_id"],
    )
    op.create_foreign_key(
        "fk_match_settings_source_rule_revision",
        "match_settings",
        "tournament_draw_revisions",
        ["source_rule_revision_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.add_column(
        "match_settings",
        sa.Column(
            "rule_version",
            sa.SmallInteger(),
            nullable=False,
            server_default=sa.text("1"),
        ),
    )
    op.create_check_constraint(
        "ck_match_settings_rule_version", "match_settings", "rule_version = 1"
    )
    op.create_unique_constraint(
        "uq_matches_match_settings_id", "matches", ["match_settings_id"]
    )
    for statement in COMPETITION_RULE_INTEGRITY_DDL:
        op.execute(statement)

    op.create_table(
        "match_recorded_play",
        sa.Column("match_id", sa.UUID(), primary_key=True),
        sa.Column(
            "recorded_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.ForeignKeyConstraint(["match_id"], ["matches.id"], ondelete="RESTRICT"),
    )
    op.create_table(
        "match_recorded_participants",
        sa.Column("match_id", sa.UUID(), primary_key=True),
        sa.Column("side_number", sa.SmallInteger(), primary_key=True),
        sa.Column("player_id", sa.UUID(), primary_key=True),
        sa.CheckConstraint(
            "side_number IN (1, 2)", name="ck_recorded_participant_side"
        ),
        sa.ForeignKeyConstraint(
            ["match_id"], ["match_recorded_play.match_id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["player_id"], ["players.id"], ondelete="RESTRICT"),
    )
    for statement in IDENTITY_RETENTION_DDL + SPORTING_RETENTION_DDL:
        op.execute(statement)


def downgrade() -> None:
    op.drop_table("match_recorded_participants")
    op.drop_table("match_recorded_play")
    op.execute("DROP FUNCTION require_event_reconciliation() CASCADE")
    op.execute("DROP FUNCTION preserve_event_reconciliation() CASCADE")
    op.execute("DROP FUNCTION invalidate_event_reconciliation() CASCADE")
    op.drop_table("tournament_event_reconciliations")
    op.execute("DROP FUNCTION preserve_recorded_score_identity() CASCADE")
    op.execute("DROP FUNCTION preserve_recorded_game_identity() CASCADE")
    op.execute("DROP FUNCTION retain_cancelled_event_counter() CASCADE")
    op.execute("DROP FUNCTION guard_cancelled_event_entry() CASCADE")
    op.execute("DROP FUNCTION observe_attached_event_play() CASCADE")
    op.drop_table("tournament_event_recorded_games")
    op.drop_table("tournament_archive_history")
    op.execute("DROP FUNCTION record_tournament_archive() CASCADE")
    op.execute("DROP FUNCTION append_tournament_archive() CASCADE")
    op.execute("DROP FUNCTION preserve_tournament_archive() CASCADE")
    op.execute("DROP FUNCTION preserve_archived_event() CASCADE")

    op.drop_table("tournament_event_lifecycle_history")
    for function in (
        "preserve_event_lifecycle",
        "append_event_lifecycle",
        "preserve_event_lifecycle_history",
    ):
        op.execute(f"DROP FUNCTION {function}() CASCADE")
    op.execute("DROP FUNCTION observe_recorded_event_play() CASCADE")
    op.execute("DROP FUNCTION record_event_play() CASCADE")

    op.execute("DROP FUNCTION bind_competition_stage_rules() CASCADE")
    op.execute("DROP FUNCTION check_fixture_rules() CASCADE")
    op.execute("DROP FUNCTION check_match_rule_source() CASCADE")
    op.execute("DROP FUNCTION check_match_rule_fixture() CASCADE")
    op.execute("DROP FUNCTION preserve_rule_sources_on_truncate() CASCADE")
    op.execute("DROP FUNCTION match_rules_agree(match_settings,jsonb) CASCADE")
    op.execute("DROP FUNCTION preserve_stage_rules() CASCADE")
    op.execute("DROP FUNCTION preserve_match_rule_reference() CASCADE")
    op.drop_column("match_settings", "source_rule_revision_id")
    op.drop_column("tournament_event_stages", "rule_revision_id")
    op.execute("DROP FUNCTION capture_competition_rules() CASCADE")
    op.execute("DROP FUNCTION preserve_match_rules() CASCADE")
    op.drop_table("required_repair_attempts")
    op.drop_table("required_repairs")
    postgresql.ENUM(name="repair_state").drop(op.get_bind(), checkfirst=True)
    op.execute("DROP FUNCTION IF EXISTS preserve_advancement_ownership() CASCADE")
    op.execute("DROP FUNCTION IF EXISTS preserve_advancement() CASCADE")
    op.execute("DROP FUNCTION IF EXISTS advancement_event_scope() CASCADE")
    op.execute("DROP FUNCTION IF EXISTS check_advancement() CASCADE")
    op.execute("DROP FUNCTION IF EXISTS guard_advancement_seat() CASCADE")
    op.execute("DROP FUNCTION IF EXISTS append_advancement() CASCADE")
    op.drop_table("advancement_decision_evidence")
    op.drop_table("fixture_advancement_decisions")
    # Drop draw history integrity.
    op.execute("DROP FUNCTION guard_draw_fixture_count() CASCADE")
    op.execute("DROP FUNCTION update_draw_fixture_counts() CASCADE")
    op.execute("DROP FUNCTION lock_registration_parent() CASCADE")
    op.execute("DROP FUNCTION check_entry_lifecycle() CASCADE")
    op.execute("DROP FUNCTION lock_fixture_write_batch() CASCADE")
    op.execute("DROP FUNCTION check_withdrawal_participation() CASCADE")
    op.execute("DROP FUNCTION validate_fixture_insert_batch() CASCADE")
    op.execute("DROP FUNCTION preserve_archived_group_mapping() CASCADE")
    op.execute("DROP FUNCTION preserve_archived_group_history() CASCADE")
    op.execute("DROP FUNCTION preserve_retired_table_history() CASCADE")
    op.execute("DROP FUNCTION preserve_table_call_history() CASCADE")
    op.execute("DROP FUNCTION preserve_retired_stage_history() CASCADE")
    op.execute("DROP FUNCTION preserve_participation_history() CASCADE")
    op.execute("DROP FUNCTION preserve_draw_revision_history() CASCADE")
    op.execute("DROP FUNCTION assign_participation_revision() CASCADE")
    op.execute("DROP FUNCTION preserve_retired_fixture_history() CASCADE")
    op.execute("DROP FUNCTION check_draw_retirement() CASCADE")
    op.execute("DROP FUNCTION validate_new_fixture_seats() CASCADE")
    op.execute("DROP FUNCTION lock_draw_history_parent() CASCADE")
    op.execute("DROP FUNCTION preserve_competition_withdrawal_history() CASCADE")
    op.drop_constraint(
        "fk_participation_draw_revision",
        "tournament_entry_participations",
        type_="foreignkey",
    )
    # End drop draw history integrity.
    op.execute("DROP FUNCTION check_participation_eligibility() CASCADE")
    op.drop_table("tournament_entry_withdrawals")
    op.execute("DROP FUNCTION preserve_registration_history() CASCADE")
    op.execute("DROP FUNCTION fixture_draw_revision() CASCADE")
    op.drop_constraint(
        "fk_fixture_draw_revision", "tournament_fixtures", type_="foreignkey"
    )
    op.drop_table("tournament_draw_revisions")
    op.execute("DROP FUNCTION fixture_participation() CASCADE")
    op.execute("DROP FUNCTION seat_participation(uuid, uuid, uuid) CASCADE")
    op.drop_constraint(
        "fk_fixture_participation_a", "tournament_fixtures", type_="foreignkey"
    )
    op.drop_constraint(
        "fk_fixture_participation_b", "tournament_fixtures", type_="foreignkey"
    )
    op.drop_table("tournament_entry_participations")
    op.drop_table("tournament_entry_registrations")
    op.execute("DROP FUNCTION require_rating_reconciliation() CASCADE")
    op.execute("DROP FUNCTION rating_input_order(uuid)")
    op.execute("DROP TRIGGER official_rating_basis ON match_official_results")
    op.execute("DROP FUNCTION bind_match_rating_strategy()")
    op.drop_constraint(
        "fk_rating_history_match_basis", "rating_history", type_="foreignkey"
    )
    op.drop_table("match_rating_bases")
    op.execute("DROP TRIGGER immutable_rating_fact ON rating_strategies")
    op.execute("DROP FUNCTION reject_rating_fact_mutation()")
    op.drop_constraint(
        "fk_rating_history_official_result_match", "rating_history", type_="foreignkey"
    )
    op.execute("DROP FUNCTION require_official_completion() CASCADE")
    op.execute("DROP FUNCTION guard_administrator_void() CASCADE")
    op.execute("DROP FUNCTION apply_administrator_void() CASCADE")
    op.drop_table("match_void_actions")
    op.execute("DROP FUNCTION append_official_result() CASCADE")
    op.execute("DROP FUNCTION advance_official_result() CASCADE")
    op.execute("DROP FUNCTION preserve_official_result() CASCADE")
    op.execute("DROP FUNCTION guard_current_official_result() CASCADE")
    op.drop_constraint("fk_matches_current_official", "matches", type_="foreignkey")
    op.drop_column("matches", "current_official_result_id")
    op.drop_table("match_official_results")
    op.execute("DROP FUNCTION prepare_tournament_transfer() CASCADE")
    op.execute("DROP FUNCTION apply_tournament_transfer() CASCADE")
    op.execute("DROP FUNCTION tournament_can_direct(uuid, uuid) CASCADE")
    op.execute("DROP FUNCTION check_tournament_grant_origin() CASCADE")
    op.execute("DROP FUNCTION preserve_tournament_creator() CASCADE")
    op.execute("DROP FUNCTION preserve_tournament_authority() CASCADE")
    op.drop_table("tournament_ownership_transfers")
    op.drop_table("tournament_account_grants")
    sa.Enum(name="authority_change_reason").drop(op.get_bind())
    sa.Enum(name="tournament_account_role").drop(op.get_bind())
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
    op.drop_index(
        "ix_tournament_table_call_history_fixture_id_created_at",
        table_name="tournament_table_call_history",
    )
    op.drop_index(
        "ix_tournament_table_call_history_tournament_id_table_id",
        table_name="tournament_table_call_history",
    )
    op.drop_table("tournament_table_call_history")
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
        "ix_tournament_table_outages_tournament_id_table_id",
        table_name="tournament_table_outages",
    )
    op.drop_index(
        "uq_tournament_table_outages_active_table",
        table_name="tournament_table_outages",
        postgresql_where=sa.text("effective_until IS NULL"),
    )
    op.drop_table("tournament_table_outages")
    op.drop_index(
        "ix_tournament_tables_tournament_id_position", table_name="tournament_tables"
    )
    op.drop_table("tournament_tables")
    op.drop_index(
        "ix_tournament_events_tournament_id_created_at", table_name="tournament_events"
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
    op.execute("DROP FUNCTION guard_rating_projection()")
    op.drop_table("rating_inputs")
    op.execute("DROP FUNCTION guard_rating_input()")
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
    op.drop_table("account_session_tokens")
    op.drop_table("account_email_tokens")
    op.drop_table("account_email_intents")
    op.drop_table("account_first_sign_in_intents")
    op.drop_table("user_roles")
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
    postgresql.ENUM(name="event_lifecycle_state").drop(op.get_bind(), checkfirst=True)
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
        "preserve_identity",
        "preserve_retired_username",
        "preserve_account_erasure",
        "check_erased_account_credentials",
        "guard_erased_account_credential",
        "revoke_deactivated_account_credentials",
        "guard_retired_player_admission",
        "guard_retired_registration",
        "preserve_published_tournament",
        "retain_match_play",
        "lock_recorded_participants",
        "check_recorded_participants",
        "preserve_match_play",
        "preserve_entry_supersession",
        "guard_proposal_insert",
        "guard_proposal_update",
        "prevent_proposal_delete",
        "apply_player_merge_to_proposals",
        "preserve_player_merge",
    ):
        op.execute(f"DROP FUNCTION {function}()")
