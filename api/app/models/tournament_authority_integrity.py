"""PostgreSQL protection for immutable tournament authority provenance."""

from typing import Any

from sqlalchemy import Connection, MetaData, event

from app.db import Base

AUTHORITY_INTEGRITY_DDL = (
    """
    CREATE FUNCTION tournament_can_direct(tournament_uuid uuid, account_uuid uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
            SELECT 1 FROM tournaments t JOIN accounts a ON a.id = account_uuid
            WHERE t.id = tournament_uuid AND a.merged_at IS NULL
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
            WHERE id IN (NEW.account_id, NEW.granted_by_account_id,
                NEW.revoked_by_account_id)
            ORDER BY id FOR KEY SHARE NOWAIT;
            PERFORM id FROM tournaments WHERE id = NEW.tournament_id FOR UPDATE NOWAIT;
        EXCEPTION WHEN lock_not_available THEN
            RAISE EXCEPTION 'authority changes require parent locks; retry'
                USING ERRCODE = '40001';
        END;
        IF TG_OP = 'INSERT' AND NOT EXISTS (
            SELECT 1 FROM accounts WHERE id = NEW.account_id AND merged_at IS NULL
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
    CREATE FUNCTION preserve_tournament_creator() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF TG_OP = 'INSERT' THEN
            NEW.owner_account_id := COALESCE(
                NEW.owner_account_id, NEW.created_by_user_id);
        ELSIF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
            RAISE EXCEPTION 'tournament creator is immutable' USING ERRCODE = '23514';
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
                WHERE id = NEW.owner_account_id AND merged_at IS NULL) THEN
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


def install_authority_integrity(
    metadata: MetaData, connection: Connection, **kwargs: Any
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in AUTHORITY_INTEGRITY_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_authority_integrity)
