"""keep a login attempt when its session ends

Revision ID: e88c34e67214
Revises: 5326680b29ca
Create Date: 2026-11-01 10:15:50.798670

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e88c34e67214"
down_revision: str | Sequence[str] | None = "5326680b29ca"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.add_column(
        "login_attempts",
        sa.Column("started_with_session", sa.Boolean(), nullable=True),
    )
    op.execute(
        "UPDATE login_attempts SET started_with_session = session_id IS NOT NULL"
    )
    op.alter_column("login_attempts", "started_with_session", nullable=False)
    op.create_check_constraint(
        op.f("ck_login_attempts_session_only_if_started_with_one"),
        "login_attempts",
        "session_id IS NULL OR started_with_session",
    )
    op.drop_constraint(
        op.f("fk_login_attempts_session_id_sessions"),
        "login_attempts",
        type_="foreignkey",
    )
    op.create_foreign_key(
        op.f("fk_login_attempts_session_id_sessions"),
        "login_attempts",
        "sessions",
        ["session_id"],
        ["id"],
        ondelete="SET NULL",
    )
