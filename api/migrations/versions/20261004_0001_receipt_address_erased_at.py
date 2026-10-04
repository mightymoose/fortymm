"""receipt address erasure tombstone (#1810)

Revision ID: 20261004_0001
Revises: 20260927_0001
"""

import sqlalchemy as sa
from alembic import op

revision = "20261004_0001"
down_revision = "20260927_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Nullable: NULL means "never erased". The previous release does not
    # select the column, so existing rows need no default.
    op.add_column(
        "tournament_payments",
        sa.Column(
            "receipt_address_erased_at", sa.DateTime(timezone=True), nullable=True
        ),
    )
    # The previous release erased an account without touching its receipt
    # addresses, and ``erase_account`` rejects an account that is already erased,
    # so nothing could clear these later. Clean them here, before the check
    # constraint below. A payment is reached through its own payer or through
    # its checkout's payer: an account merge moves the first and not the second.
    op.add_column(
        "tournament_checkouts",
        sa.Column(
            "receipt_address_erased_at", sa.DateTime(timezone=True), nullable=True
        ),
    )
    op.execute(
        """
        UPDATE tournament_payments
        SET receipt_address = NULL, receipt_address_erased_at = clock_timestamp()
        WHERE receipt_address IS NOT NULL
          AND (
            payer_account_id IN (SELECT id FROM accounts WHERE erased_at IS NOT NULL)
            OR checkout_id IN (
              SELECT id FROM tournament_checkouts
              WHERE payer_account_id IN (
                SELECT id FROM accounts WHERE erased_at IS NOT NULL
              )
            )
          )
        """
    )
    op.execute(
        """
        UPDATE tournament_checkouts
        SET receipt_address = NULL, receipt_address_erased_at = clock_timestamp()
        WHERE receipt_address IS NOT NULL
          AND (
            payer_account_id IN (SELECT id FROM accounts WHERE erased_at IS NOT NULL)
            OR id IN (
              SELECT checkout_id FROM tournament_payments
              WHERE payer_account_id IN (
                SELECT id FROM accounts WHERE erased_at IS NOT NULL
              )
            )
          )
        """
    )
    op.create_check_constraint(
        "ck_tournament_checkouts_erased_receipt_has_no_address",
        "tournament_checkouts",
        "receipt_address IS NULL OR receipt_address_erased_at IS NULL",
    )
    op.create_check_constraint(
        "ck_tournament_payments_erased_receipt_has_no_address",
        "tournament_payments",
        "receipt_address IS NULL OR receipt_address_erased_at IS NULL",
    )

    # The previous release writes neither of these facts, and a rolling deploy
    # or a rollback keeps it running against this schema, so the database
    # carries both (api/CLAUDE.md: an upgraded schema supports both versions).
    #
    # 1. A late success the previous release records after a new pod erased the
    #    checkout: its ``_admit`` copies only the checkout's address, so the
    #    payment would end with neither an address nor a tombstone.
    op.execute(
        """
        CREATE FUNCTION propagate_checkout_receipt_erasure() RETURNS trigger AS $$
        DECLARE
          erased timestamptz;
        BEGIN
          IF NEW.status = 'succeeded'
             AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
             AND NEW.receipt_address_erased_at IS NULL THEN
            SELECT receipt_address_erased_at INTO erased
            FROM tournament_checkouts WHERE id = NEW.checkout_id;
            IF erased IS NOT NULL THEN
              NEW.receipt_address := NULL;
              NEW.receipt_address_erased_at := erased;
            END IF;
          END IF;
          RETURN NEW;
        END
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        """
        CREATE TRIGGER tournament_payments_propagate_receipt_erasure
        BEFORE INSERT OR UPDATE ON tournament_payments
        FOR EACH ROW EXECUTE FUNCTION propagate_checkout_receipt_erasure()
        """
    )
    # 2. An account the previous release erases after this migration: its
    #    ``erase_account`` knows nothing of receipt addresses, and the erased
    #    account is then too inert for the new release to repair.
    op.execute(
        """
        CREATE FUNCTION erase_receipt_addresses_of_erased_account()
        RETURNS trigger AS $$
        BEGIN
          IF OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL THEN
            UPDATE tournament_payments
            SET receipt_address = NULL,
                receipt_address_erased_at =
                  COALESCE(receipt_address_erased_at, clock_timestamp())
            WHERE status = 'succeeded'
              AND (
                payer_account_id = NEW.id
                OR checkout_id IN (
                  SELECT id FROM tournament_checkouts WHERE payer_account_id = NEW.id
                )
              );
            UPDATE tournament_checkouts
            SET receipt_address = NULL,
                receipt_address_erased_at =
                  COALESCE(receipt_address_erased_at, clock_timestamp())
            WHERE payer_account_id = NEW.id
               OR id IN (
                 SELECT checkout_id FROM tournament_payments
                 WHERE payer_account_id = NEW.id
               );
          END IF;
          RETURN NEW;
        END
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        """
        CREATE TRIGGER accounts_erase_receipt_addresses
        AFTER UPDATE OF erased_at ON accounts
        FOR EACH ROW EXECUTE FUNCTION erase_receipt_addresses_of_erased_account()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER accounts_erase_receipt_addresses ON accounts")
    op.execute("DROP FUNCTION erase_receipt_addresses_of_erased_account()")
    op.execute(
        "DROP TRIGGER tournament_payments_propagate_receipt_erasure "
        "ON tournament_payments"
    )
    op.execute("DROP FUNCTION propagate_checkout_receipt_erasure()")
    op.drop_constraint(
        "ck_tournament_checkouts_erased_receipt_has_no_address",
        "tournament_checkouts",
        type_="check",
    )
    op.drop_column("tournament_checkouts", "receipt_address_erased_at")
    op.drop_constraint(
        "ck_tournament_payments_erased_receipt_has_no_address",
        "tournament_payments",
        type_="check",
    )
    op.drop_column("tournament_payments", "receipt_address_erased_at")
