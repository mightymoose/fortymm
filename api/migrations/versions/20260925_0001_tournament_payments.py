"""tournament payments (#1816)

Revision ID: 20260925_0001
Revises: 20260919_0001
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260925_0001"
down_revision = "20260919_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Each enum is created explicitly, then referenced with ``create_type=False``
    # inside its table's column so the table's own create/drop DDL does not ALSO
    # try to create/drop the type (the pattern the checkout migration set).
    provider_create_state = postgresql.ENUM(
        "not_started",
        "committed",
        "created",
        name="tournament_payment_provider_create_state",
        create_type=False,
    )
    postgresql.ENUM(
        "not_started",
        "committed",
        "created",
        name="tournament_payment_provider_create_state",
    ).create(op.get_bind())

    payment_status = postgresql.ENUM(
        "preparing",
        "ready",
        "checking",
        "action_required",
        "succeeded",
        "failed",
        "expired",
        "canceled",
        "cancel_requested",
        "quarantined",
        name="tournament_payment_status",
        create_type=False,
    )
    postgresql.ENUM(
        "preparing",
        "ready",
        "checking",
        "action_required",
        "succeeded",
        "failed",
        "expired",
        "canceled",
        "cancel_requested",
        "quarantined",
        name="tournament_payment_status",
    ).create(op.get_bind())

    line_outcome = postgresql.ENUM(
        "pending",
        "admitted",
        "refund_due",
        name="tournament_payment_line_outcome",
        create_type=False,
    )
    postgresql.ENUM(
        "pending",
        "admitted",
        "refund_due",
        name="tournament_payment_line_outcome",
    ).create(op.get_bind())

    refund_reason = postgresql.ENUM(
        "quarantine",
        "line_could_not_admit",
        "superseded_by_director_entry",
        "checkout_superseded",
        name="tournament_payment_refund_reason",
        create_type=False,
    )
    postgresql.ENUM(
        "quarantine",
        "line_could_not_admit",
        "superseded_by_director_entry",
        "checkout_superseded",
        name="tournament_payment_refund_reason",
    ).create(op.get_bind())

    op.create_table(
        "tournament_payments",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("checkout_id", sa.UUID(), nullable=False),
        sa.Column("payer_account_id", sa.UUID(), nullable=False),
        sa.Column("tournament_id", sa.UUID(), nullable=False),
        sa.Column("payee_stripe_account", sa.String(length=255), nullable=True),
        sa.Column("payee_fortymm_account_id", sa.UUID(), nullable=False),
        sa.Column("reference", sa.String(length=12), nullable=False),
        sa.Column("idempotency_key", sa.String(length=255), nullable=False),
        sa.Column(
            "provider_create_state",
            provider_create_state,
            server_default="not_started",
            nullable=False,
        ),
        sa.Column("provider_payment_intent_id", sa.String(length=255), nullable=True),
        sa.Column("status", payment_status, server_default="preparing", nullable=False),
        sa.Column("amount_cents", sa.BigInteger(), nullable=False),
        sa.Column(
            "currency", sa.String(length=3), server_default="USD", nullable=False
        ),
        sa.Column("last_error_code", sa.String(length=64), nullable=True),
        sa.Column(
            "amount_unverified",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column("cancel_requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "amount_cents > 0", name="ck_tournament_payments_amount_positive"
        ),
        sa.CheckConstraint(
            "currency = 'USD'", name="ck_tournament_payments_currency_usd"
        ),
        sa.ForeignKeyConstraint(
            ["checkout_id"], ["tournament_checkouts.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["payer_account_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["payee_fortymm_account_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id"], ["tournaments.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("checkout_id", name="uq_tournament_payments_checkout"),
        sa.UniqueConstraint("reference", name="uq_tournament_payments_reference"),
        sa.UniqueConstraint(
            "idempotency_key", name="uq_tournament_payments_idempotency_key"
        ),
        sa.UniqueConstraint(
            "provider_payment_intent_id",
            name="uq_tournament_payments_provider_intent",
        ),
    )
    op.create_index(
        "ix_tournament_payments_payer_account_id",
        "tournament_payments",
        ["payer_account_id"],
    )

    op.create_table(
        "tournament_payment_lines",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("payment_id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("price_cents", sa.Integer(), nullable=False),
        sa.Column("outcome", line_outcome, server_default="pending", nullable=False),
        sa.Column("entry_id", sa.UUID(), nullable=True),
        sa.ForeignKeyConstraint(
            ["payment_id"], ["tournament_payments.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["event_id"], ["tournament_events.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["entry_id"], ["tournament_entries.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "payment_id", "event_id", name="uq_tournament_payment_lines_event"
        ),
    )
    op.create_index(
        "ix_tournament_payment_lines_event_id",
        "tournament_payment_lines",
        ["event_id"],
    )

    op.create_table(
        "tournament_payment_refund_obligations",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("payment_id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=True),
        sa.Column("amount_cents", sa.BigInteger(), nullable=False),
        sa.Column("reason", refund_reason, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "amount_cents > 0", name="ck_tournament_payment_refund_obligations_amount"
        ),
        sa.ForeignKeyConstraint(
            ["payment_id"], ["tournament_payments.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["event_id"], ["tournament_events.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_tournament_payment_refund_obligations_payment_id",
        "tournament_payment_refund_obligations",
        ["payment_id"],
    )

    op.create_table(
        "tournament_payment_provider_events",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("provider_event_id", sa.String(length=255), nullable=False),
        sa.Column("event_type", sa.String(length=255), nullable=False),
        sa.Column("payment_id", sa.UUID(), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["payment_id"], ["tournament_payments.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "provider_event_id", name="uq_tournament_payment_provider_events_id"
        ),
    )

    # "Registered before payments" stamp (#1816 acceptance criteria). Adding
    # the NOT NULL column with a ``true`` default stamps every registration
    # that exists at deploy time, as a metadata-only change on PostgreSQL 11+.
    # The default then drops to ``false``, so a registration created after
    # this migration, by any path, is never stamped as pre-payments.
    op.add_column(
        "tournament_entry_registrations",
        sa.Column(
            "pre_payments_registration",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
    )
    op.alter_column(
        "tournament_entry_registrations",
        "pre_payments_registration",
        server_default=sa.text("false"),
    )

    # A verified payment consumes its checkout's hold (#1816). ``cancelled``
    # already means the player's own cancellation, which a late success must
    # never reverse, so admission needs its own status. ADD VALUE only extends
    # the type: no existing row or merged migration changes.
    op.execute(
        "ALTER TYPE tournament_checkout_status ADD VALUE IF NOT EXISTS 'completed'"
    )


def downgrade() -> None:
    # PostgreSQL cannot drop an enum value. Move completed checkouts to
    # ``cancelled`` (both mean "no longer holds capacity") and leave the value
    # on the type, which is harmless to the previous revision.
    op.execute(
        "UPDATE tournament_checkouts SET status = 'cancelled' "
        "WHERE status = 'completed'"
    )
    op.drop_column("tournament_entry_registrations", "pre_payments_registration")
    op.drop_table("tournament_payment_provider_events")
    op.drop_index(
        "ix_tournament_payment_refund_obligations_payment_id",
        table_name="tournament_payment_refund_obligations",
    )
    op.drop_table("tournament_payment_refund_obligations")
    op.drop_index(
        "ix_tournament_payment_lines_event_id", table_name="tournament_payment_lines"
    )
    op.drop_table("tournament_payment_lines")
    op.drop_index(
        "ix_tournament_payments_payer_account_id", table_name="tournament_payments"
    )
    op.drop_table("tournament_payments")
    sa.Enum(name="tournament_payment_refund_reason").drop(op.get_bind())
    sa.Enum(name="tournament_payment_line_outcome").drop(op.get_bind())
    sa.Enum(name="tournament_payment_status").drop(op.get_bind())
    sa.Enum(name="tournament_payment_provider_create_state").drop(op.get_bind())
