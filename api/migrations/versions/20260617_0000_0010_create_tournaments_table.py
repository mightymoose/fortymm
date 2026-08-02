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
    (
        "rr-then-ko",
        # The director-facing copy is pinned by the ADR "rr-then-ko cuts both
        # stages upfront and seeds qualifiers rematch-free" — it is seed data, so
        # changing either string is a migration.
        "Round-robin then knockout",
        "Pools play all-play-all, then the top finishers from each pool meet in a "
        "knockout bracket.",
        3,
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
        # **K** — how many of each pool's finishers advance into the knockout
        # stage. Only ``rr-then-ko`` has one, so the column is NULLABLE and the
        # CHECK below is what pairs it with the draw type: NOT NULL and >= 1 for
        # ``rr-then-ko``, NULL for every other slug. Added in place per the
        # pre-deploy convention (api/CLAUDE.md), not as a chained ALTER —
        # revision ids and the down_revision chain stay frozen.
        sa.Column("qualifiers_per_pool", sa.Integer(), nullable=True),
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
        sa.CheckConstraint(
            "CASE WHEN draw_type_key = 'rr-then-ko'"
            " THEN qualifiers_per_pool IS NOT NULL AND qualifiers_per_pool >= 1"
            " ELSE qualifiers_per_pool IS NULL"
            " END",
            name="ck_tournament_event_draw_settings_qualifiers_per_pool",
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
        # Nullable: a tournament may have no venue at all, at every status
        # (announced before the venue is booked; a private tournament whose
        # address is deliberately withheld). Per the 2026-07-26 amendment to
        # ADR ``20260725-a-venues-coordinates-are-geocoded-server-side-and-not-null``
        # the invariant is "an address, *when present*, has NOT NULL
        # coordinates" — so SQL NULL is the single representation of "no venue"
        # and a stored address is always fully geocoded. Nullability relaxed
        # here in place per the pre-deploy convention, not as a chained ALTER.
        #
        # ``jsonb NULL`` is the whole of the DDL side; there is no ``none_as_null``
        # to express here. That flag (see ``Tournament.address``) is a SQLAlchemy
        # *bind* processor — it decides whether Python ``None`` is sent as SQL NULL
        # or as the JSON ``null`` literal, which this column would accept either
        # way. The single-representation invariant is therefore enforced by the
        # model, not by this schema.
        sa.Column("address", postgresql.JSONB(), nullable=True),
        # There is deliberately NO ``table_catalogue`` column. The venue catalogue was
        # a NOT NULL JSONB list of ``{id, label, court}`` objects keyed by
        # client-supplied strings; it is the ``tournament_tables`` table created below
        # (ADR 20260801 "a placement names a real table, and only that is an
        # invariant"), so a placement can foreign-key the table it names and the id is
        # the database's to mint. Edited out of this migration in place, per the
        # pre-deploy convention in api/CLAUDE.md — revision ids and the
        # ``down_revision`` chain stay frozen.
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

    # The venue catalogue, as rows (ADR 20260801 "a placement names a real table").
    # Created immediately after ``tournaments`` because it FKs it, and before
    # ``tournament_events`` only for readability — nothing in this migration references
    # it. Added here in place per the pre-deploy convention, not as a chained ALTER.
    #
    # ``id`` is a server-minted UUID with the same ``gen_random_uuid()`` default every
    # other id in this migration has: a table's identity is the database's to mint. It
    # used to be a client-supplied string inside ``tournaments.table_catalogue``, which
    # is exactly why a ``tournament_fixtures.table_id`` naming no table could be stored
    # rather than refused — there was no key to point at.
    op.create_table(
        "tournament_tables",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # CASCADE: deleting a tournament takes its catalogue with it, in the same
        # statement, exactly as it takes its events (below).
        sa.Column(
            "tournament_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tournaments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("court", sa.String(length=255), nullable=False),
        # Where the table sits in the director's catalogue order: 0-based, contiguous,
        # server-assigned from the order the catalogue was sent in. The JSONB array
        # carried this for free; under random UUID primary keys neither ``id`` nor
        # ``created_at`` (every row of one write shares the transaction timestamp) can,
        # so it is a column — the same remedy ``tournament_events.pools`` got in
        # ADR 20260801 for the same reason.
        sa.Column("position", sa.Integer(), nullable=False),
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
        # Two tables of one tournament never share a place in its order.
        #
        # DEFERRABLE INITIALLY DEFERRED: the catalogue is written as an id-keyed diff
        # (ADR 20260801), and a diff re-orders — dragging one table above another moves
        # it onto a position the other has not vacated yet. An immediately-checked
        # constraint refuses that intermediate state and so forbids reordering outright,
        # though the transaction's END state is perfectly unique. Deferred here in
        # place per the pre-deploy convention, not as a chained ALTER.
        sa.UniqueConstraint(
            "tournament_id",
            "position",
            name="uq_tournament_tables_tournament_position",
            deferrable=True,
            initially="DEFERRED",
        ),
    )
    # Postgres indexes the REFERENCED key of a foreign key, never the referencing
    # column, so this is what keeps the tournament-delete cascade from sequentially
    # scanning every table row on the platform — and it is the catalogue's read order
    # besides.
    op.create_index(
        "ix_tournament_tables_tournament_id_position",
        "tournament_tables",
        ["tournament_id", "position"],
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
    # Postgres indexes the REFERENCED key of a foreign key, never the referencing
    # column — so this index is not redundant with the FK above, it is what makes
    # the FK's own referential-integrity check cheap. ``draw_settings_id`` is on a
    # routine DELETE path: every ``tournament_event_draw_settings`` row removed (the
    # delete-orphan when an event is deleted, and ``reap_draw_settings`` when a
    # tournament is) makes the RESTRICT trigger run ``SELECT 1 FROM
    # tournament_events WHERE draw_settings_id = $1 FOR KEY SHARE``, which without
    # this index sequentially scans EVERY event on the platform — a cost linear in
    # total events, not in the tournament's own (measured at 50k events: 7.9ms →
    # 0.08ms per settings row deleted, and the reap's ``NOT EXISTS`` anti-join
    # 7.0ms → 0.08ms). The sibling ``matches.match_settings_id`` is deliberately
    # left unindexed; the difference is that match settings rows are never deleted,
    # so their RI check never runs.
    op.create_index(
        "ix_tournament_events_draw_settings_id",
        "tournament_events",
        ["draw_settings_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_tournament_events_draw_settings_id",
        table_name="tournament_events",
    )
    op.drop_index(
        "ix_tournament_events_tournament_id_created_at",
        table_name="tournament_events",
    )
    op.drop_table("tournament_events")

    # Symmetric with upgrade(): dropped before the tournaments it references.
    op.drop_index(
        "ix_tournament_tables_tournament_id_position",
        table_name="tournament_tables",
    )
    op.drop_table("tournament_tables")

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
