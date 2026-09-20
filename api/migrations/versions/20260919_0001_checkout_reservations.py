"""combined checkout reservations

Revision ID: 20260919_0001
Revises: 20260919_0000
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260919_0001"
down_revision = "20260919_0000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    checkout_status = postgresql.ENUM(
        "active",
        "cancelled",
        "expired",
        "invalidated",
        name="tournament_checkout_status",
        create_type=False,
    )
    postgresql.ENUM(
        "active",
        "cancelled",
        "expired",
        "invalidated",
        name="tournament_checkout_status",
    ).create(op.get_bind())
    op.create_table(
        "tournament_checkouts",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("payer_account_id", sa.UUID(), nullable=False),
        sa.Column("entrant_player_id", sa.UUID(), nullable=False),
        sa.Column("tournament_id", sa.UUID(), nullable=False),
        sa.Column("merchant_account_id", sa.UUID(), nullable=False),
        sa.Column("registration_generation", sa.Integer(), nullable=False),
        sa.Column(
            "currency", sa.String(length=3), server_default="USD", nullable=False
        ),
        sa.Column("total_cents", sa.Integer(), nullable=False),
        sa.Column("status", checkout_status, server_default="active", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column(
            "expires_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp() + interval '10 minutes'"),
            nullable=False,
        ),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "currency = 'USD'", name="ck_tournament_checkouts_currency_usd"
        ),
        sa.CheckConstraint(
            "expires_at > created_at",
            name="ck_tournament_checkouts_deadline_after_create",
        ),
        sa.CheckConstraint(
            "total_cents > 0", name="ck_tournament_checkouts_total_positive"
        ),
        sa.ForeignKeyConstraint(
            ["entrant_player_id"], ["players.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["merchant_account_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["payer_account_id"], ["accounts.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id"], ["tournaments.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "payer_account_id",
            "request_id",
            name="uq_tournament_checkouts_payer_request",
        ),
    )
    op.create_index(
        "ix_tournament_checkouts_tournament_id",
        "tournament_checkouts",
        ["tournament_id"],
    )
    op.create_index(
        "uq_tournament_checkouts_active_player_tournament",
        "tournament_checkouts",
        ["entrant_player_id", "tournament_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_table(
        "tournament_checkout_lines",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("checkout_id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("event_name", sa.String(length=255), nullable=False),
        sa.Column("price_cents", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "price_cents >= 50", name="ck_tournament_checkout_lines_minimum_price"
        ),
        sa.ForeignKeyConstraint(
            ["checkout_id"], ["tournament_checkouts.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "checkout_id", "event_id", name="uq_tournament_checkout_lines_event"
        ),
    )
    op.create_index(
        "ix_tournament_checkout_lines_event_id",
        "tournament_checkout_lines",
        ["event_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_tournament_checkout_lines_event_id", table_name="tournament_checkout_lines"
    )
    op.drop_table("tournament_checkout_lines")
    op.drop_index(
        "uq_tournament_checkouts_active_player_tournament",
        table_name="tournament_checkouts",
    )
    op.drop_index(
        "ix_tournament_checkouts_tournament_id", table_name="tournament_checkouts"
    )
    op.drop_table("tournament_checkouts")
    sa.Enum(name="tournament_checkout_status").drop(op.get_bind())
