"""create tournaments tables

Revision ID: 0010
Revises: 0009
Create Date: 2026-06-17 00:00:00.000000

Per the pre-deploy convention in api/CLAUDE.md, edits to this migration
happen in place. No backfill — assumes a fresh / empty DB.

The ``draw_types`` lookup table is created and seeded here, first, for the same
reason 0009 creates and seeds ``notification_types`` ahead of the tables that
reference it: it is the FK target for the tournament event's draw settings, so
it has to exist before the event tables in this very migration. Adding it in
place — rather than as a chained ALTER at the head of the chain — is what keeps
that ordering true; a later revision would land *after* the tables that point at
it. Revision ids and the ``down_revision`` chain stay frozen.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Enum types are created explicitly in upgrade() via `.create(...)` and
# referenced with create_type=False so neither op.create_table nor Alembic
# autogenerate attempts to create them a second time. The hyphenated values
# mirror the front-end prototype's wire strings (the ORM persists the enum
# *value*, not the member name, via values_callable).
tournament_status_enum = postgresql.ENUM(
    "draft",
    "published",
    "live",
    "archived",
    name="tournament_status",
    create_type=False,
)
event_format_enum = postgresql.ENUM(
    "singles",
    "doubles",
    "teams",
    name="event_format",
    create_type=False,
)


# There is deliberately NO ``draw_type`` Postgres enum type here, and no
# ``tournament_events.draw_type`` column. A draw type is persisted as the
# ``draw_types.key`` slug on an event's ``tournament_event_draw_settings`` row
# (ADR "an event's draw configuration is a row, not a column"), so the seeded
# lookup table below is the only place a draw type can be named — which is what
# makes the FK, rather than a hand-maintained enum type, the enforcement.
# Seeded lookup rows: the draw types that RUN. A row means "this draw type has
# an implementation" — the set is exactly what ``app.draws.strategy_for``
# dispatches, which is also exactly the members of ``app.models.DrawType``.
# Migrations must stay self-contained (no app imports), so this list is a
# deliberate hand-copy of the enum; a test asserts the two agree.
# (key, name, description, display_order)
DRAW_TYPE_SEED = [
    (
        "round-robin",
        "Round robin",
        "Everyone in a pool plays everyone else in that pool. Every entrant is "
        "guaranteed the same number of matches and the final standings rank the "
        "whole field, so it is the fairest read on form — but the match count "
        "climbs quickly with pool size, and the event needs at least one pool.",
        1,
    ),
    (
        "single-elim",
        "Single elimination",
        "A knockout bracket: lose once and you are out. It crowns a champion in "
        "the fewest matches and the least table time, which suits a large field "
        "or a tight schedule — but half the entrants are finished after one "
        "match, and a field that is not a power of two gives the top seeds byes.",
        2,
    ),
]


def upgrade() -> None:
    bind = op.get_bind()
    tournament_status_enum.create(bind, checkfirst=True)
    event_format_enum.create(bind, checkfirst=True)

    # The slug is the primary key — no surrogate id, unlike notification_types.
    # It is the FK target for the event's draw settings, so changing a slug is a
    # migration. No ``is_active`` column on purpose: an unimplemented draw type
    # has no row, which is what makes that FK the enforcement (see the ADR).
    draw_types = op.create_table(
        "draw_types",
        sa.Column("key", sa.String(length=32), primary_key=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column(
            "display_order", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.bulk_insert(
        draw_types,
        [
            {
                "key": key,
                "name": name,
                "description": description,
                "display_order": display_order,
            }
            for key, name, description, display_order in DRAW_TYPE_SEED
        ],
    )

    # The event's draw configuration, as a row (ADR "an event's draw configuration
    # is a row, not a column"). Created BETWEEN its two neighbours on purpose: it
    # FKs ``draw_types`` above, and ``tournament_events`` below FKs it. Its own
    # UUID id, and no ``event_id`` — the parent holds the NOT NULL FK, the
    # ``match_settings`` shape, which is what makes "every event has exactly one"
    # a database fact rather than a convention.
    op.create_table(
        "tournament_event_draw_settings",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # RESTRICT: a draw type an event is configured with cannot be deleted out
        # from under it, and a settings row cannot name a slug with no seeded row
        # — i.e. no draw type the product cannot actually run.
        sa.Column(
            "draw_type_key",
            sa.String(length=32),
            sa.ForeignKey("draw_types.key", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    op.create_table(
        "tournaments",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "status",
            tournament_status_enum,
            nullable=False,
            server_default="draft",
        ),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("address", postgresql.JSONB(), nullable=False),
        sa.Column(
            "table_catalogue",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        # The rating ladder a tournament's eligibility is judged on (ADR-0783).
        # NOT NULL: every tournament names its league, so no read of an entry
        # decision has to ask "rated against *what*?". Resolved at create — an
        # omitted league becomes the default one — so the caller never has to
        # supply it. RESTRICT, like ``matches.league_id``: a league that judges a
        # tournament cannot be deleted out from under it. Added here in place per
        # the pre-deploy convention, not as a chained ALTER.
        sa.Column(
            "league_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("leagues.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "created_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_tournaments_created_by_user_id_created_at",
        "tournaments",
        ["created_by_user_id", sa.text("created_at DESC")],
    )

    op.create_table(
        "tournament_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "tournament_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tournaments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("format", event_format_enum, nullable=False),
        # NOT NULL: the event's draw configuration is a row, and every event has
        # one. RESTRICT so the settings row cannot be deleted while an event
        # points at it. This is the event's ONLY draw type — there is no
        # ``draw_type`` column beside it, so the two cannot disagree.
        sa.Column(
            "draw_settings_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tournament_event_draw_settings.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        # ``max_players`` is nullable: NULL is the "no cap" sentinel (ADR-0935).
        # The CHECK guarantees a *present* cap is positive — a SQL CHECK passes on
        # NULL, so "no cap" and "a positive cap" are the only representable states,
        # never zero or negative.
        sa.Column("max_players", sa.Integer(), nullable=True),
        sa.Column("entry_fee", sa.Numeric(precision=8, scale=2), nullable=False),
        # The venue timezone (IANA name, e.g. ``America/Chicago``) that anchors this
        # event's wall-clock ``slot`` windows to real instants (ADR "tournament times
        # are timezone-aware instants"). NOT NULL with no server default: every event
        # names its venue frame, and the client supplies a browser-derived default at
        # create — "UTC" is a guess no single-venue tournament wants made silently.
        # Added here in place per the pre-deploy convention, not as a chained ALTER.
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.CheckConstraint(
            "max_players > 0", name="ck_tournament_events_max_players_positive"
        ),
        sa.CheckConstraint(
            "entry_fee >= 0", name="ck_tournament_events_entry_fee_non_negative"
        ),
        # No ``entered`` column: an event's entry count is DERIVED from a live
        # count of its active ``tournament_entries`` rows (ADR-0016). A stored
        # counter is a second copy of the truth that can drift from the rows it
        # counts — edited out of this migration in place, per the pre-deploy
        # convention in api/CLAUDE.md.
        sa.Column("slot", postgresql.JSONB(), nullable=False),
        sa.Column("match_settings", postgresql.JSONB(), nullable=False),
        sa.Column(
            "predicates",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "pools",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_tournament_events_tournament_id_created_at",
        "tournament_events",
        ["tournament_id", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_tournament_events_tournament_id_created_at",
        table_name="tournament_events",
    )
    op.drop_table("tournament_events")

    op.drop_index(
        "ix_tournaments_created_by_user_id_created_at", table_name="tournaments"
    )
    op.drop_table("tournaments")

    # Symmetric with upgrade(): dropped after the events that reference it and
    # before the draw types it references.
    op.drop_table("tournament_event_draw_settings")

    # Dropped last, mirroring its create-first position: the tables that will
    # reference it must go first.
    op.drop_table("draw_types")

    bind = op.get_bind()
    event_format_enum.drop(bind, checkfirst=True)
    tournament_status_enum.drop(bind, checkfirst=True)
