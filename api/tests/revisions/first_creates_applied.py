"""Records each time it runs, slowly, so concurrent upgrades overlap."""

from alembic import op

revision = "first"
down_revision = None


def upgrade() -> None:
    op.execute("CREATE TABLE applied (revision text)")
    op.execute("SELECT pg_sleep(2)")
    op.execute("INSERT INTO applied VALUES ('first')")
