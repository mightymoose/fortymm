"""Stable identity retention, including identities without references."""

from sqlalchemy import MetaData, event
from sqlalchemy.engine import Connection

from app.db import Base

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
                UNION
                SELECT (to_jsonb(OLD)->>'account_id')::uuid
                WHERE TG_TABLE_NAME='login_identities' AND TG_OP='UPDATE'
            ) ORDER BY a.id FOR SHARE
        LOOP
            IF account_row.erased_at IS NOT NULL THEN
                RAISE EXCEPTION 'erased account credentials cannot be attached'
                    USING ERRCODE='23514';
            END IF;
            -- A foreign guest reference does not grant access to that guest.
            -- Existing login identities survive deactivation, but a writer
            -- cannot introduce a new credential while its owner is suspended.
            IF account_row.deactivated_at IS NOT NULL
                AND TG_TABLE_NAME='login_identities'
                AND (TG_OP='INSERT' OR
                    (to_jsonb(NEW) - 'id') IS DISTINCT FROM (to_jsonb(OLD) - 'id'))
            THEN
                RAISE EXCEPTION 'inactive account credentials cannot be attached'
                    USING ERRCODE='23514';
            END IF;
            -- Device registrations survive deactivation.
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
    """
    CREATE FUNCTION lock_match_player_admission() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP='UPDATE' AND (NEW.match_id, NEW.match_side_id, NEW.user_id)
            IS NOT DISTINCT FROM (OLD.match_id, OLD.match_side_id, OLD.user_id)
        THEN RETURN NEW; END IF;
        PERFORM id FROM players WHERE id IN
            (NEW.user_id, entry_canonical_player(NEW.user_id))
            ORDER BY id FOR SHARE;
        -- Standalone inserts cannot create their own historical authority.
        IF TG_OP='INSERT'
            AND EXISTS (SELECT 1 FROM players WHERE id IN
                (NEW.user_id, entry_canonical_player(NEW.user_id))
                AND retired_at IS NOT NULL)
            AND EXISTS (SELECT 1 FROM matches m JOIN match_settings rules
                ON rules.id=m.match_settings_id WHERE m.id=NEW.match_id
                AND rules.source_rule_revision_id IS NULL)
            AND NOT EXISTS (SELECT 1 FROM match_recorded_participants r
                WHERE r.match_id=NEW.match_id AND
                    entry_canonical_player(r.player_id)=
                    entry_canonical_player(NEW.user_id)) THEN
            RAISE EXCEPTION 'retired Player cannot be admitted to a new match'
                USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END $$
    """,
    """CREATE TRIGGER lock_match_player_admission BEFORE INSERT OR UPDATE
    ON match_side_players FOR EACH ROW
    EXECUTE FUNCTION lock_match_player_admission()""",
    """
    CREATE FUNCTION check_retired_match_admission() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE participant match_side_players%ROWTYPE;
    BEGIN
        SELECT * INTO participant FROM match_side_players WHERE id=NEW.id;
        IF NOT FOUND OR (participant.match_id, participant.user_id)
            IS DISTINCT FROM (NEW.match_id, NEW.user_id) THEN
            -- A removed/transient row still matters if first play retained it.
            IF EXISTS (SELECT 1 FROM match_recorded_participants r
                WHERE r.match_id=NEW.match_id AND r.player_id=NEW.user_id) THEN
                participant := NEW;
            ELSIF NOT FOUND THEN RETURN NULL; END IF;
        END IF;
        IF TG_OP='INSERT' AND EXISTS (
            SELECT 1 FROM matches m JOIN match_settings rules
                ON rules.id=m.match_settings_id WHERE m.id=participant.match_id
                AND rules.source_rule_revision_id IS NULL
        ) THEN RETURN NULL; END IF;
        IF TG_OP='UPDATE' AND participant.match_id=OLD.match_id
            AND entry_canonical_player(participant.user_id)=
                entry_canonical_player(OLD.user_id) THEN RETURN NULL; END IF;
        IF NOT EXISTS (SELECT 1 FROM players WHERE id IN
            (participant.user_id, entry_canonical_player(participant.user_id))
            AND retired_at IS NOT NULL) THEN RETURN NULL; END IF;
        -- Materialization links its fixture after flushing the match. Validate
        -- the exact final fixture side and its already-held member at commit.
        IF EXISTS (
            SELECT 1 FROM tournament_fixtures f
            JOIN match_sides side ON side.id=participant.match_side_id
            JOIN tournament_entry_members member ON member.entry_id=
                CASE WHEN side.side_number=1 THEN f.entry_a_id ELSE f.entry_b_id END
            JOIN tournament_entries entry ON entry.id=member.entry_id
            WHERE f.match_id=participant.match_id AND entry.status='entered'
              AND member.left_at IS NULL
              AND entry_canonical_player(member.player_id)=
                  entry_canonical_player(participant.user_id)
        ) THEN RETURN NULL; END IF;
        IF EXISTS (
            SELECT 1 FROM match_lineups lineup
            JOIN match_lineup_players p ON p.lineup_id=lineup.id
            JOIN match_sides side ON side.id=participant.match_side_id
            WHERE lineup.match_id=participant.match_id AND lineup.revision > 1
              AND p.side_number=side.side_number AND p.player_id=participant.user_id
        ) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'retired Player cannot be admitted to a new match'
            USING ERRCODE='23514';
    END $$
    """,
    """CREATE CONSTRAINT TRIGGER check_retired_match_admission
    AFTER INSERT OR UPDATE ON match_side_players DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_retired_match_admission()""",
)


def install_identity_retention(
    metadata: MetaData, connection: Connection, **kwargs: object
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in IDENTITY_RETENTION_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_identity_retention)
