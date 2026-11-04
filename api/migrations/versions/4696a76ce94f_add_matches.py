"""add matches

Revision ID: 4696a76ce94f
Revises: 179ec4bf5c8e
Create Date: 2026-11-04 01:22:31.061263

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "4696a76ce94f"
down_revision: str | Sequence[str] | None = "179ec4bf5c8e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.create_table(
        "match_settings",
        sa.Column(
            "id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("team_size", sa.SmallInteger(), nullable=False),
        sa.Column("best_of", sa.SmallInteger(), nullable=False),
        sa.Column("rated", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "best_of IN (1, 3, 5, 7)", name=op.f("ck_match_settings_best_of")
        ),
        sa.CheckConstraint(
            "team_size = 1", name=op.f("ck_match_settings_singles_only")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_match_settings")),
    )
    op.create_table(
        "matches",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("settings_id", sa.Uuid(), nullable=False),
        sa.Column("league_id", sa.Uuid(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("current_result_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(
            ["created_by"], ["accounts.id"], name=op.f("fk_matches_created_by_accounts")
        ),
        sa.ForeignKeyConstraint(
            ["league_id"],
            ["leagues.id"],
            name=op.f("fk_matches_league_id_leagues"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["settings_id"],
            ["match_settings.id"],
            name=op.f("fk_matches_settings_id_match_settings"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_matches")),
        sa.UniqueConstraint("settings_id", name=op.f("uq_matches_settings_id")),
    )
    op.create_index(
        "ix_matches_created_at",
        "matches",
        [sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_index(
        op.f("ix_matches_league_id"), "matches", ["league_id"], unique=False
    )
    op.create_table(
        "match_results",
        sa.Column(
            "id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("match_id", sa.Uuid(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.Column("replaces_id", sa.Uuid(), nullable=True),
        sa.Column("override_reason", sa.Text(), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "override_reason = btrim(override_reason) AND override_reason <> ''",
            name=op.f("ck_match_results_override_reason_trimmed"),
        ),
        sa.CheckConstraint(
            "replaces_id <> id", name=op.f("ck_match_results_not_replacing_itself")
        ),
        sa.ForeignKeyConstraint(
            ["match_id"], ["matches.id"], name=op.f("fk_match_results_match_id_matches")
        ),
        sa.ForeignKeyConstraint(
            ["replaces_id", "match_id"],
            ["match_results.id", "match_results.match_id"],
            name="fk_match_results_replaces_id_match_results",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_match_results")),
        sa.UniqueConstraint("id", "match_id", name="uq_match_results_id_match_id"),
    )
    op.create_index(
        "match_results_by_hash",
        "match_results",
        [sa.literal_column("sha256(payload)")],
        unique=True,
    )
    # matches and match_results refer to each other, so this one comes after both.
    op.create_foreign_key(
        "fk_matches_current_result_id_match_results",
        "matches",
        "match_results",
        ["current_result_id", "id"],
        ["id", "match_id"],
    )
    op.create_index(
        "one_successor",
        "match_results",
        ["match_id", "replaces_id"],
        unique=True,
        postgresql_nulls_not_distinct=True,
    )
    op.create_table(
        "match_sides",
        sa.Column(
            "id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("match_id", sa.Uuid(), nullable=False),
        sa.Column("side", sa.SmallInteger(), nullable=False),
        sa.CheckConstraint("side IN (0, 1)", name=op.f("ck_match_sides_side")),
        sa.ForeignKeyConstraint(
            ["match_id"], ["matches.id"], name=op.f("fk_match_sides_match_id_matches")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_match_sides")),
        sa.UniqueConstraint("id", "match_id", name="uq_match_sides_id_match_id"),
        sa.UniqueConstraint("match_id", "side", name=op.f("uq_match_sides_match_id")),
    )
    op.create_table(
        "match_side_players",
        sa.Column("match_side_id", sa.Uuid(), nullable=False),
        sa.Column("match_id", sa.Uuid(), nullable=False),
        sa.Column("player_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["match_side_id", "match_id"],
            ["match_sides.id", "match_sides.match_id"],
            name="fk_match_side_players_match_side_id_match_sides",
        ),
        sa.ForeignKeyConstraint(
            ["player_id"],
            ["players.id"],
            name=op.f("fk_match_side_players_player_id_players"),
        ),
        sa.PrimaryKeyConstraint(
            "match_side_id", "player_id", name=op.f("pk_match_side_players")
        ),
        sa.UniqueConstraint(
            "match_id", "player_id", name=op.f("uq_match_side_players_match_id")
        ),
    )
    op.create_index(
        op.f("ix_match_side_players_player_id"),
        "match_side_players",
        ["player_id"],
        unique=False,
    )
    op.create_table(
        "match_submissions",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("match_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("body", sa.LargeBinary(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=True),
        sa.Column("network", postgresql.CIDR(), nullable=True),
        sa.Column("outcome", sa.Text(), nullable=False),
        sa.Column("result_id", sa.Uuid(), nullable=True),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('board', 'result', 'override')",
            name=op.f("ck_match_submissions_kind"),
        ),
        sa.CheckConstraint(
            "outcome ~ '^[a-z_]+$'", name=op.f("ck_match_submissions_outcome_is_a_code")
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name=op.f("fk_match_submissions_account_id_accounts"),
        ),
        sa.ForeignKeyConstraint(
            ["match_id"],
            ["matches.id"],
            name=op.f("fk_match_submissions_match_id_matches"),
        ),
        sa.ForeignKeyConstraint(
            ["result_id", "match_id"],
            ["match_results.id", "match_results.match_id"],
            name="fk_match_submissions_result_id_match_results",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_match_submissions")),
        sa.UniqueConstraint(
            "id", "result_id", name="uq_match_submissions_id_result_id"
        ),
    )
    op.create_index(
        "ix_match_submissions_match_id_kind",
        "match_submissions",
        ["match_id", "kind", sa.literal_column("id DESC")],
        unique=False,
    )
    op.create_index(
        "ix_match_submissions_result_id",
        "match_submissions",
        ["result_id"],
        unique=False,
    )
    op.create_table(
        "match_approvals",
        sa.Column("result_id", sa.Uuid(), nullable=False),
        sa.Column("key_id", sa.LargeBinary(), nullable=False),
        sa.Column("side", sa.SmallInteger(), nullable=False),
        sa.Column("signature", sa.LargeBinary(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("player_id", sa.Uuid(), nullable=False),
        sa.Column("authority", sa.Text(), nullable=False),
        sa.Column("submission_id", sa.BigInteger(), nullable=False),
        sa.CheckConstraint(
            "authority IN ('self', 'representative')",
            name=op.f("ck_match_approvals_authority"),
        ),
        sa.CheckConstraint(
            "octet_length(signature) = 64",
            name=op.f("ck_match_approvals_signature_length"),
        ),
        sa.CheckConstraint("side IN (0, 1)", name=op.f("ck_match_approvals_side")),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name=op.f("fk_match_approvals_account_id_accounts"),
        ),
        sa.ForeignKeyConstraint(
            ["key_id"],
            ["signing_keys.id"],
            name=op.f("fk_match_approvals_key_id_signing_keys"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["player_id"],
            ["players.id"],
            name=op.f("fk_match_approvals_player_id_players"),
        ),
        sa.ForeignKeyConstraint(
            ["result_id"],
            ["match_results.id"],
            name=op.f("fk_match_approvals_result_id_match_results"),
        ),
        sa.ForeignKeyConstraint(
            ["submission_id", "result_id"],
            ["match_submissions.id", "match_submissions.result_id"],
            name="fk_match_approvals_submission_id_match_submissions",
        ),
        sa.PrimaryKeyConstraint(
            "result_id", "key_id", "side", name=op.f("pk_match_approvals")
        ),
    )
    op.execute(
        """
        CREATE FUNCTION refuse_match_record_change() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION '% rows never change', TG_TABLE_NAME;
        END $$
        """
    )
    for table in (
        "match_settings",
        "match_sides",
        "match_side_players",
        "match_submissions",
        "match_approvals",
    ):
        op.execute(
            f"CREATE TRIGGER {table}_never_change BEFORE UPDATE OR DELETE ON {table}"
            " FOR EACH ROW EXECUTE FUNCTION refuse_match_record_change()"
        )
    # A match's settings and sides are fixed, so only its current result moves.
    # It starts empty, and once set it only moves forward along the chain: to
    # an accepted result that nothing replaces.
    op.execute(
        """
        CREATE FUNCTION guard_match() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'matches are never deleted';
          END IF;
          IF TG_OP = 'INSERT' THEN
            IF NEW.current_result_id IS NOT NULL THEN
              RAISE EXCEPTION 'a match starts with no current result';
            END IF;
            RETURN NEW;
          END IF;
          IF (NEW.id, NEW.settings_id, NEW.league_id, NEW.created_by, NEW.created_at)
             IS DISTINCT FROM
             (OLD.id, OLD.settings_id, OLD.league_id, OLD.created_by, OLD.created_at)
          THEN
            RAISE EXCEPTION 'a match changes only its current result';
          END IF;
          IF NEW.current_result_id IS NOT DISTINCT FROM OLD.current_result_id THEN
            RETURN NEW;
          END IF;
          IF NEW.current_result_id IS NULL THEN
            RAISE EXCEPTION 'a final match stays final';
          END IF;
          IF NOT EXISTS (
            SELECT FROM match_results
            WHERE id = NEW.current_result_id AND accepted_at IS NOT NULL
          ) OR EXISTS (
            SELECT FROM match_results WHERE replaces_id = NEW.current_result_id
          ) THEN
            RAISE EXCEPTION 'a match''s current result is its accepted head';
          END IF;
          RETURN NEW;
        END $$
        """
    )
    op.execute(
        "CREATE TRIGGER matches_guard BEFORE INSERT OR UPDATE OR DELETE ON matches"
        " FOR EACH ROW EXECUTE FUNCTION guard_match()"
    )
    op.execute(
        """
        CREATE FUNCTION guard_match_result() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'match results are never deleted';
          END IF;
          -- A row trigger sees the rows its statement inserted before it, so
          -- naming a later row of the same INSERT is refused, and no chain
          -- can loop.
          IF TG_OP = 'INSERT' THEN
            IF NEW.replaces_id IS NOT NULL AND NOT EXISTS (
              SELECT FROM match_results WHERE id = NEW.replaces_id
            ) THEN
              RAISE EXCEPTION 'a result replaces one that already exists';
            END IF;
            RETURN NEW;
          END IF;
          IF OLD.accepted_at IS NOT NULL OR NEW.accepted_at IS NULL
             OR (NEW.id, NEW.match_id, NEW.payload, NEW.replaces_id,
                 NEW.override_reason)
             IS DISTINCT FROM
             (OLD.id, OLD.match_id, OLD.payload, OLD.replaces_id,
              OLD.override_reason)
          THEN
            RAISE EXCEPTION 'a match result changes only when it is accepted';
          END IF;
          RETURN NEW;
        END $$
        """
    )
    op.execute(
        "CREATE TRIGGER match_results_guard"
        " BEFORE INSERT OR UPDATE OR DELETE ON match_results"
        " FOR EACH ROW EXECUTE FUNCTION guard_match_result()"
    )
    # Deferred, so one transaction can insert the match, its sides and their
    # players in any order before the check runs at commit.
    op.execute(
        """
        CREATE FUNCTION check_match_sides() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
          match uuid;
        BEGIN
          IF TG_TABLE_NAME = 'matches' THEN
            match := NEW.id;
          ELSE
            match := NEW.match_id;
          END IF;
          IF (SELECT count(*) FROM match_sides WHERE match_id = match) <> 2
             OR EXISTS (
               SELECT FROM match_sides AS side
               JOIN matches ON matches.id = side.match_id
               JOIN match_settings AS settings ON settings.id = matches.settings_id
               WHERE side.match_id = match
                 AND (SELECT count(*) FROM match_side_players AS player
                      WHERE player.match_side_id = side.id) <> settings.team_size
             )
          THEN
            RAISE EXCEPTION 'a match has two sides of team_size players each'
              USING ERRCODE = 'check_violation';
          END IF;
          RETURN NULL;
        END $$
        """
    )
    for table in ("matches", "match_sides", "match_side_players"):
        op.execute(
            f"CREATE CONSTRAINT TRIGGER {table}_have_two_full_sides"
            f" AFTER INSERT ON {table} DEFERRABLE INITIALLY DEFERRED"
            " FOR EACH ROW EXECUTE FUNCTION check_match_sides()"
        )
