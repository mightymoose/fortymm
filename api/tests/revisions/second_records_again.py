"""Records each time it runs."""

from alembic import op

revision = "second"
down_revision = "first"


def upgrade() -> None:
    op.execute("INSERT INTO applied VALUES ('second')")
