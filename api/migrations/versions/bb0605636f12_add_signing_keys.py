"""Add signing keys

Revision ID: bb0605636f12
Revises: c71172de2728
Create Date: 2026-11-02 12:51:55.740963

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "bb0605636f12"
down_revision: str | Sequence[str] | None = "c71172de2728"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.create_table(
        "signing_keys",
        sa.Column("id", sa.LargeBinary(), nullable=False),
        sa.Column("public_key", sa.LargeBinary(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("signed_out_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "id = sha256(public_key)", name=op.f("ck_signing_keys_id_is_thumbprint")
        ),
        sa.CheckConstraint(
            "octet_length(public_key) = 75",
            name=op.f("ck_signing_keys_public_key_length"),
        ),
        sa.CheckConstraint(
            "label = btrim(label) AND label <> ''",
            name=op.f("ck_signing_keys_label_trimmed"),
        ),
        sa.CheckConstraint(
            "char_length(label) <= 50", name=op.f("ck_signing_keys_label_length")
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name=op.f("fk_signing_keys_account_id_accounts"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_signing_keys")),
    )
    op.create_index(
        op.f("ix_signing_keys_account_id"), "signing_keys", ["account_id"], unique=False
    )
