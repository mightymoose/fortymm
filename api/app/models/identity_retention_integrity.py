"""Stable identity retention, including identities without references."""

from sqlalchemy import MetaData, event
from sqlalchemy.engine import Connection

from app.db import Base

IDENTITY_RETENTION_DDL = (
    """
    CREATE FUNCTION preserve_retired_username() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF OLD.retired_at IS NOT NULL
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
)


def install_identity_retention(
    metadata: MetaData, connection: Connection, **kwargs: object
) -> None:
    if connection.dialect.name == "postgresql" and kwargs.get("tables"):
        for statement in IDENTITY_RETENTION_DDL:
            connection.exec_driver_sql(statement)


event.listen(Base.metadata, "after_create", install_identity_retention)
