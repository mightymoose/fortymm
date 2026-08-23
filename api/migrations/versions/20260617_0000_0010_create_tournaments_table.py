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

import uuid
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
# ``draw_types.id`` FK on an event's ``tournament_event_draw_settings`` row
# (ADR "an event's draw configuration is a row, not a column"; superseded in part
# by ADR 20260815 "draw_types gains a surrogate id primary key"), so the seeded
# lookup table below is the only place a draw type can be named — which is what
# makes the FK, rather than a hand-maintained enum type, the enforcement. Code
# still resolves a draw type by its ``key`` slug — the enum binds on ``key``, not
# on ``id`` — so the slug stays a UNIQUE NOT NULL column even though it is no
# longer the primary key.
# Seeded lookup rows: the draw types that RUN. A row means "this draw type has
# an implementation" — the set is exactly what ``app.draws.strategy_for``
# dispatches, which is also exactly the members of ``app.models.DrawType``.
# Migrations must stay self-contained (no app imports), so this list is a
# deliberate hand-copy of the enum; a test asserts the two agree.
#
# Each entry carries its OWN fixed id — NOT ``gen_random_uuid()``, even though the
# column's own default (below) is — for the same reason ``app.models.draw_type
# .DRAW_TYPE_IDS`` does on the app side: writing a settings row's ``draw_type_id``
# from a ``DrawType`` member is a plain, synchronous property assignment reached
# from dozens of call sites with no database session in scope (most of them test
# fixtures that build a whole ``TournamentEvent`` in one expression), so the app
# side needs the id for each draw type without a lookup. That map is hand-copied
# from this list for the mirror-image reason (migrations cannot import app code);
# ``tests/test_draw_type_seed_migration.py`` pins the two in agreement. See that
# map's own docstring for why this is not the same shape as migration 0005's
# ``GLICKO2_STRATEGY_ID`` / ``MANUAL_STRATEGY_ID``, which have no app-side copy.
# (id, key, name, description, display_order)
DRAW_TYPE_SEED = [
    (
        uuid.UUID("22222222-2222-2222-2222-222222220001"),
        "round-robin",
        "Round robin",
        "Everyone in a group plays everyone else in that group. Every entrant is "
        "guaranteed the same number of matches and the final standings rank the "
        "whole field, so it is the fairest read on form — but the match count "
        "climbs quickly with group size, and the event needs at least one group.",
        1,
    ),
    (
        uuid.UUID("22222222-2222-2222-2222-222222220002"),
        "single-elim",
        "Single elimination",
        "A knockout bracket: lose once and you are out. It crowns a champion in "
        "the fewest matches and the least table time, which suits a large field "
        "or a tight schedule — but half the entrants are finished after one "
        "match, and a field that is not a power of two gives the top seeds byes.",
        2,
    ),
    (
        uuid.UUID("22222222-2222-2222-2222-222222220003"),
        "rr-then-ko",
        # The director-facing copy is pinned by the ADR "rr-then-ko cuts both
        # stages upfront and seeds qualifiers rematch-free" — it is seed data, so
        # changing either string is a migration.
        "Round-robin then knockout",
        "Groups play all-play-all, then the top finishers from each group meet in a "
        "knockout bracket.",
        3,
    ),
    (
        uuid.UUID("22222222-2222-2222-2222-222222220004"),
        "swiss",
        # The director-facing copy is pinned by the ADR "swiss pre-cuts every
        # round and pairs each one on advance" — it is seed data, so changing
        # either string is a migration.
        "Swiss",
        "A fixed number of rounds, each pairing entrants who are on similar "
        "scores. Nobody is eliminated and everybody plays every round, so a "
        "large field is ranked in far fewer matches than a round robin — but a "
        "round's pairings are only known once the round before it has finished, "
        "and a long event may repeat a pairing.",
        4,
    ),
]


def upgrade() -> None:
    bind = op.get_bind()
    tournament_status_enum.create(bind, checkfirst=True)
    event_format_enum.create(bind, checkfirst=True)

    # A surrogate ``id`` primary key (ADR 20260815 "draw_types gains a surrogate id
    # primary key"), superseding the slug-as-PK stance of the ADR this migration
    # originally implemented. ``key`` stays UNIQUE and NOT NULL: it is still the only
    # spelling ``app.models.tournament.DrawType`` binds on, and renaming it is still a
    # migration, but the FK target for the event's draw settings is ``id`` now. No
    # ``is_active`` column on purpose: an unimplemented draw type has no row, which is
    # what makes that FK the enforcement (see the ADR).
    draw_types = op.create_table(
        "draw_types",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("key", sa.String(length=32), nullable=False),
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
        sa.UniqueConstraint("key", name="uq_draw_types_key"),
    )
    op.bulk_insert(
        draw_types,
        [
            {
                "id": id_,
                "key": key,
                "name": name,
                "description": description,
                "display_order": display_order,
            }
            for id_, key, name, description, display_order in DRAW_TYPE_SEED
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
        # from under it, and a settings row cannot name an id with no seeded row —
        # i.e. no draw type the product cannot actually run. FKs ``draw_types.id``
        # rather than its ``key`` (ADR 20260815) — the app still resolves the draw
        # type BY key, through the join this FK makes possible, or through
        # ``app.models.draw_type.DRAW_TYPE_IDS`` on the write side.
        sa.Column(
            "draw_type_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("draw_types.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        # The draw type's settings, as ONE NOT NULL JSON object (ADR "a draw
        # type's settings are one NOT NULL JSON object"). ``{}`` for a draw type
        # that takes no configuration — ``round-robin`` and ``single-elim`` —
        # ``{"qualifiers_per_group": K}`` for ``rr-then-ko``, and
        # ``{"rounds": R}`` for ``swiss``. A draw type with no configuration
        # stores the empty object and never NULL, so no reader has to test for
        # absence before it reads.
        #
        # It replaces a nullable ``qualifiers_per_group`` integer column and the
        # CASE constraint that paired it with its draw type. Which settings a
        # draw type has is a union, and a union modelled as a wide row of
        # nullable columns is what forced that constraint to exist: each new
        # setting cost a column, a branch and a migration. Edited in place per
        # the pre-deploy convention (api/CLAUDE.md), not as a chained ALTER —
        # revision ids and the down_revision chain stay frozen.
        sa.Column(
            "settings",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
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
        # All the database has an opinion on: ``settings`` is a JSON **object**.
        # A list, a number, a string or a JSON ``null`` would each be a stored
        # "settings" that means nothing, so they are refused here.
        #
        # Deliberately weaker than the CASE constraint it replaces, which knew
        # that only ``rr-then-ko`` carries a qualifier count. Which settings
        # belong to which draw type now lives in the discriminated union at the
        # request boundary (``app.schemas.tournament.DrawSettingsWrite``), which
        # refuses a mismatched pair with a 422. That trade is the ADR's, made on
        # purpose: the constraint grew one branch per draw type per setting, and
        # a migration cannot import the enum it would have to keep agreeing with.
        sa.CheckConstraint(
            "jsonb_typeof(settings) = 'object'",
            name="ck_tournament_event_draw_settings_settings_object",
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
        # so it is a column — the same remedy ``tournament_events.reservations`` got in
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
        # Redundant against the primary key, and here for exactly one purpose: SQL can
        # only reference a UNIQUE set of columns, so this is the target
        # ``tournament_event_reservation_tables`` foreign-keys ``(tournament_id, table_id)``
        # against — the leg that says the table a reservation reserves is its OWN
        # tournament's (ADR 20260801). Added in place per the pre-deploy convention.
        sa.UniqueConstraint(
            "tournament_id", "id", name="uq_tournament_tables_tournament_id_id"
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
        # The event's optimistic-concurrency token (#1499). NOT NULL, server default
        # 1, and bumped by one on every accepted PATCH of this event; a PATCH stating
        # a stale number is refused with a 409 before anything is written. It exists
        # instead of leaning on ``updated_at`` because a reservations-only edit writes
        # only child rows, never dirtying this one, so ``updated_at`` does not move on
        # exactly the edit the lost update was found on. Added here in place per the
        # pre-deploy convention, not as a chained ALTER.
        sa.Column(
            "lock_version", sa.Integer(), nullable=False, server_default=sa.text("1")
        ),
        sa.CheckConstraint(
            "max_players > 0", name="ck_tournament_events_max_players_positive"
        ),
        sa.CheckConstraint(
            "entry_fee >= 0", name="ck_tournament_events_entry_fee_non_negative"
        ),
        # Redundant against the primary key, and here for exactly one purpose: it is the
        # target ``tournament_event_reservation_tables`` foreign-keys ``(tournament_id,
        # event_id)`` against, which is what forces a reservation's denormalized
        # ``tournament_id`` to be the tournament its group's event really belongs to.
        # The other two legs of that row are satisfiable by a cross-tournament
        # reservation without it (ADR 20260801). Added in place per the pre-deploy
        # convention.
        sa.UniqueConstraint(
            "tournament_id", "id", name="uq_tournament_events_tournament_id_id"
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
        # There is deliberately NO ``reservations`` column. An event's groups were a
        # NOT NULL JSONB list of ``{id, name, slot, table_ids}`` objects keyed by
        # client-supplied strings; they are the ``tournament_event_stage_groups`` and
        # ``tournament_event_reservations`` tables created below (ADR
        # 20260801, on what belongs to an event rather than to its draw settings), so
        # a fixture can foreign-key the group it names — and specifically one of its OWN
        # event's groups. Edited out of this migration in place, per the pre-deploy
        # convention in api/CLAUDE.md — revision ids and the ``down_revision`` chain
        # stay frozen.
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

    # An event's stages, as rows the system mints from its draw type (ADR 20260815
    # "an event's stages are rows and a composite draw type is a template"). Created
    # immediately after ``tournament_events`` because it FKs it, and before
    # ``tournament_event_stage_groups`` only for readability — the two tables do not
    # reference each other in this migration; a later revision is what re-parents a
    # group's composite FK onto a stage (see the ADR's "Sequencing with #1338"
    # consequence). Added here in place per the pre-deploy convention — revision ids
    # and the ``down_revision`` chain stay frozen.
    #
    # A director never authors these rows; ``app.tournament_event_stages`` mints and
    # re-mints them from a template keyed on the event's draw type. ``id`` is a
    # server-minted uuid, same default as every other row in this migration.
    op.create_table(
        "tournament_event_stages",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # CASCADE: deleting an event takes its stages with it, exactly as it takes its
        # groups, entries and fixtures.
        sa.Column(
            "event_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tournament_events.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Where this stage sits in the event's draw, 0-based: position 0 (the ADR's
        # "stage 1") feeds position 1. Minted by the template, never client-supplied,
        # and never re-ordered once minted — a re-mint only appends past or truncates
        # from the template's old length (ADR 20260815 decision 3), so unlike the
        # group/table position columns this one needs no DEFERRABLE trick.
        sa.Column("position", sa.Integer(), nullable=False),
        # RESTRICT, exactly as ``tournament_event_draw_settings.draw_type_id`` is: a
        # draw type a stage is running cannot be deleted out from under it.
        sa.Column(
            "draw_type_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("draw_types.id", ondelete="RESTRICT"),
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
        # Redundant against the primary key, and here for exactly one purpose (ADR
        # 20260815 decision 1): "``UNIQUE (event_id, id)`` exists purely as a
        # composite-FK target, as on groups" — something attached to a stage, later,
        # foreign-keys this pair rather than a bare ``id``, so it can say "my stage is
        # my own event's stage".
        sa.UniqueConstraint(
            "event_id", "id", name="uq_tournament_event_stages_event_id_id"
        ),
        # Two stages of one event never share a place in its order.
        sa.UniqueConstraint(
            "event_id",
            "position",
            name="uq_tournament_event_stages_event_id_position",
        ),
    )
    # No separate ``ix_`` index here, matching ``tournament_event_stage_groups``
    # immediately
    # below rather than ``tournament_events``/``tournament_tables`` above: the
    # ``event_id`` FK is ``ON DELETE CASCADE``, not ``RESTRICT``, so its
    # referential-integrity check never runs a query the ``uq_..._event_id_id``
    # constraint's own (``event_id``-leading) index does not already serve.

    # A stage's GROUPS, as rows. This table carried both faces under one name until
    # that row split into the two things it had always meant at once: a **group** is
    # an ordered set of entrants who play all-play-all, and a **reservation** (created
    # below) is a set of tables held for a window of time. The five columns that
    # described the venue side — ``name``, ``slot_date``, ``slot_start``, ``slot_end``
    # and the tables relationship — moved to the reservation; what is left here is
    # identity and order. Renamed and re-shaped in place per the pre-deploy convention,
    # not as a chained ALTER.
    #
    # The parent stays the STAGE (ADR 20260815, "Sequencing with #1338", whose
    # consequence re-parents the group face onto the stage), and it has to: a
    # fixture's composite foreign key names this row, and a fixture carries ``stage_id``
    # and no ``event_id`` at all. A director's groups always hang off the event's stage 0
    # (decision 3) — this migration does not enforce that placement itself,
    # ``app.tournament_reservations.apply_event_reservations`` does, by resolving the
    # event's first stage before it writes. Created after ``tournament_event_stages``
    # because it FKs it, and before ``tournament_fixtures`` (0012), which carries the
    # composite foreign key onto the ``(stage_id, id)`` unique constraint below.
    #
    # ``id`` is a server-minted uuid — ``gen_random_uuid()``, exactly as
    # ``tournament_tables.id`` is — and it is **the id the wire serves**:
    # ``groups[].id`` and ``fixture.group_id`` are both this column. A reservation's
    # own id is a separate uuid the wire's ``reservations[].id`` names instead.
    op.create_table(
        "tournament_event_stage_groups",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        # CASCADE: deleting an event takes its stages with it, and a stage's deletion
        # takes its groups with it in turn.
        sa.Column(
            "stage_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tournament_event_stages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Where the group sits in its stage's order: 0-based, contiguous, server-assigned
        # from the order the reservations were sent in. The snake seeds against this
        # order (ADR 20260801, on carrying an explicit ``position``), and this is what
        # the wire's ``groups[].position`` reports, and what a group's derived label
        # (``group_label`` — "Group A", "Group B", …) is a function of.
        sa.Column("position", sa.Integer(), nullable=False),
        # There is deliberately NO ``name`` column. A group's label is DERIVED from its
        # ``position`` (``group_label``), never stored — what the wire calls
        # ``reservations[].name`` is the mapped reservation's own name, projected. Nor a
        # window, nor tables — all four moved to ``tournament_event_reservations``
        # below.
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
        sa.PrimaryKeyConstraint("id", name="pk_tournament_event_stage_groups"),
        # ``UNIQUE (stage_id, id)`` — "redundant against the primary key and exists purely
        # as the target that composite FK needs". SQL can only reference a unique set of
        # columns, and the *pair* is what carries "my group is my own stage's group" —
        # for ``tournament_fixtures`` (0012) and for the join table below.
        #
        # Its index earns its keep besides: ``stage_id`` leads, so it answers every read
        # of "this stage's groups", the stage-delete cascade's lookup, and both foreign
        # keys' referential checks — none of which the single-column primary key serves.
        sa.UniqueConstraint(
            "stage_id", "id", name="uq_tournament_event_stage_groups_stage_id_id"
        ),
        # Two groups of one stage never share a place in its order.
        #
        # DEFERRABLE INITIALLY DEFERRED, exactly as ``tournament_tables``' position
        # constraint is: the groups are written as an id-keyed diff, and a diff re-orders
        # — sending C, A, B back as B, C, A moves each row onto a position its neighbour
        # has not vacated yet. An immediately-checked constraint would refuse that
        # intermediate state and so forbid reordering, though the transaction's END state
        # is perfectly unique.
        sa.UniqueConstraint(
            "stage_id",
            "position",
            name="uq_tournament_event_stage_groups_stage_id_position",
            deferrable=True,
            initially="DEFERRED",
        ),
    )

    # An event's RESERVATIONS — the other half of that split row: a set of tables held
    # for a window of time, carrying the ``name``, ``position``, ``slot_date``,
    # ``slot_start`` and ``slot_end`` that used to sit beside a group's identity.
    #
    # The parent is the EVENT, not the stage, and that asymmetry with the group above is
    # deliberate. Nothing names a reservation through a composite key rooted in a
    # fixture, so the constraint that pins a group to its stage does not apply; and a
    # stage-parented reservation would hand every stage a reservation set before anything
    # exists to edit one. On the event, an rr-then-ko draw's two stages read one set, and
    # a knockout stage can later point at a reservation its event already holds.
    #
    # The window is ``date``/``time``, NOT ``timestamptz``, and that is the ADR's call
    # rather than an oversight (api/CLAUDE.md's "datetimes are timezone-aware, always"
    # governs datetimes, and these are not datetimes). A window is wall-clock in the
    # venue's own frame, which ``tournament_events.timezone`` carries and the solver
    # anchors; storing an instant would bake that anchoring into the column, so a
    # timezone correction would have to rewrite every window instead of re-reading the
    # same wall-clock in the new zone.
    op.create_table(
        "tournament_event_reservations",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        # CASCADE: an event's reservations go with the event, exactly as its stages do.
        sa.Column(
            "event_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tournament_events.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        # Where the reservation sits in its event's own order. NOT what the wire reports
        # — ``groups[].position`` is the group's — but a stable read order of its own,
        # since ordering by a random uuid would shuffle a director's list on every read.
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("slot_date", sa.Date(), nullable=False),
        sa.Column("slot_start", sa.Time(), nullable=False),
        sa.Column("slot_end", sa.Time(), nullable=False),
        # There is deliberately NO ``table_ids`` column. The tables were a NOT NULL JSONB
        # array of table-id strings — which could name another tournament's table, or no
        # table at all — and they are the ``tournament_event_reservation_tables`` rows
        # created below (ADR 20260801, "the tournament-scoping stops at the join table").
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
        sa.PrimaryKeyConstraint("id", name="pk_tournament_event_reservations"),
        # The target of the join row's reservation leg and of the reservation tables'
        # own — the same "unique pair as composite-FK target" trick the group above uses,
        # one parent along.
        sa.UniqueConstraint(
            "event_id", "id", name="uq_tournament_event_reservations_event_id_id"
        ),
        # Two reservations of one event never share a place in its order. DEFERRABLE for
        # the reason every sibling position constraint is: the reservations are written
        # as a diff keyed on their group's id, and a diff re-orders.
        sa.UniqueConstraint(
            "event_id",
            "position",
            name="uq_tournament_event_reservations_event_id_position",
            deferrable=True,
            initially="DEFERRED",
        ),
    )

    # The tables a reservation holds, as rows (ADR 20260801, "the tournament-scoping
    # stops at the join table"). This is the old per-slot table join, re-pointed: its
    # first leg becomes a reservation leg, and because a reservation hangs off the
    # event directly, the ``stage_id`` column and the FOURTH leg ADR 20260815 needed to
    # close the stage indirection's gap both disappear. Three legs again, as before that
    # ADR.
    #
    # ``tournament_id`` is DENORMALIZED, and it is the whole mechanism: a reservation
    # hangs off its event and a table hangs off its tournament, so the two sides share no
    # column until this row supplies one for them to agree on. **The ``tournament_id``
    # leg is the cross-tournament guard and is not droppable**: with only the reservation
    # and table legs, a row could say ``tournament_id = X`` while its reservation's event
    # belonged to tournament ``Y`` — both satisfied, and exactly the cross-tournament
    # reservation the ADR forbids.
    #
    # All three are ON DELETE CASCADE. The one that carries a decision is the table leg:
    # removing a venue table a fixture is PLACED at is refused (``ON DELETE RESTRICT``
    # on ``tournament_fixtures.table_id``) and the director opts in on purpose, while
    # removing one a reservation merely HOLDS is silent — a reservation is a preference,
    # a placement is a commitment (ADR 20260801, "a placement names a real table").
    op.create_table(
        "tournament_event_reservation_tables",
        sa.Column("tournament_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("reservation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("table_id", postgresql.UUID(as_uuid=True), nullable=False),
        # Where the table sits in the reservation's list: 0-based, contiguous,
        # server-assigned from the order the ids were sent in. The JSONB array carried
        # this for free and the wire shape is still an array; ordering by the random
        # ``table_id`` instead would shuffle a director's list on every read.
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
        # A reservation holds a table at most once. ``event_id`` leads so the key's own
        # index answers the reservation leg's referential check and the event-delete
        # cascade — which is why, unlike the pre-split version, this table needs no
        # second ``ix_`` for its parent leg.
        sa.PrimaryKeyConstraint(
            "event_id",
            "reservation_id",
            "table_id",
            name="pk_tournament_event_reservation_tables",
        ),
        # "My reservation is my own event's reservation" — replacing the pre-split
        # ``(stage_id, group_id)`` leg.
        sa.ForeignKeyConstraint(
            ["event_id", "reservation_id"],
            [
                "tournament_event_reservations.event_id",
                "tournament_event_reservations.id",
            ],
            name="fk_tournament_event_reservation_tables_event_id_reservation_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id", "table_id"],
            ["tournament_tables.tournament_id", "tournament_tables.id"],
            name="fk_tournament_event_reservation_tables_tournament_id_table_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id", "event_id"],
            ["tournament_events.tournament_id", "tournament_events.id"],
            name="fk_tournament_event_reservation_tables_tournament_id_event_id",
            ondelete="CASCADE",
        ),
        # Two tables of one reservation never share a place in its order. DEFERRABLE
        # INITIALLY DEFERRED for the reason every sibling position constraint is: the
        # tables are written as a diff keyed on the table id, and a diff re-orders —
        # moving a table up the list puts it on a position its neighbour has not vacated
        # yet, though the transaction's END state is perfectly unique.
        sa.UniqueConstraint(
            "event_id",
            "reservation_id",
            "position",
            name="uq_tournament_event_reservation_tables_reservation_position",
            deferrable=True,
            initially="DEFERRED",
        ),
    )
    # Postgres indexes the REFERENCED key of a foreign key, never the referencing
    # columns. The primary key covers both legs that lead with ``event_id``; this is the
    # one on a routine DELETE path — every venue table removed cascades through it, which
    # unindexed is a sequential scan of every reservation table on the platform per table
    # removed.
    op.create_index(
        "ix_tournament_event_reservation_tables_tournament_id_table_id",
        "tournament_event_reservation_tables",
        ["tournament_id", "table_id"],
    )

    # The row that maps one GROUP to the RESERVATION it plays in. Created last because it
    # references three of the tables above.
    #
    # THREE legs, because two cannot say it. A group is parented on its stage and a
    # reservation on its event, so the two sides share no column at all; one composite key
    # cannot assert that both belong to one event. The first two legs say each side is
    # real and correctly parented. The third — ``(event_id, stage_id)`` — is the one that
    # matters: without it, ``event_id`` and ``stage_id`` may name two different events
    # while both other legs stay satisfied, and the row hands one event's stage a
    # different event's reservation. ``tournament_fixtures`` carries four legs for exactly
    # this reason after ADR 20260815, so the shape is idiomatic here.
    #
    # The primary key is ``group_id`` ALONE, and that IS the 1:1: one group maps to at
    # most one reservation. There is deliberately NO uniqueness on ``reservation_id`` —
    # two groups of one event naming one reservation is a state the database accepts and
    # no application path in this slice produces. ``reservation_id`` is NOT NULL because
    # under today's write paths a reservation-less group is unreachable; the column states
    # what is true rather than what a later change will allow.
    #
    # All three delete rules are CASCADE: the mapping exists only while both ends do.
    op.create_table(
        "tournament_event_group_reservations",
        sa.Column("group_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("stage_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("reservation_id", postgresql.UUID(as_uuid=True), nullable=False),
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
        sa.PrimaryKeyConstraint(
            "group_id", name="pk_tournament_event_group_reservations"
        ),
        # "My group is my own stage's group".
        sa.ForeignKeyConstraint(
            ["stage_id", "group_id"],
            [
                "tournament_event_stage_groups.stage_id",
                "tournament_event_stage_groups.id",
            ],
            name="fk_tournament_event_group_reservations_stage_id_group_id",
            ondelete="CASCADE",
        ),
        # "My reservation is my own event's reservation".
        sa.ForeignKeyConstraint(
            ["event_id", "reservation_id"],
            [
                "tournament_event_reservations.event_id",
                "tournament_event_reservations.id",
            ],
            name="fk_tournament_event_group_reservations_event_id_reservation_id",
            ondelete="CASCADE",
        ),
        # "My stage is my own event's stage" — the leg that ties the other two together.
        sa.ForeignKeyConstraint(
            ["event_id", "stage_id"],
            ["tournament_event_stages.event_id", "tournament_event_stages.id"],
            name="fk_tournament_event_group_reservations_event_id_stage_id",
            ondelete="CASCADE",
        ),
    )
    # The primary key (``group_id``) covers nothing that leads with ``event_id``, so both
    # remaining legs — and the reservation-delete and stage-delete cascades through them
    # — would otherwise be sequential scans.
    op.create_index(
        "ix_tournament_event_group_reservations_event_id_reservation_id",
        "tournament_event_group_reservations",
        ["event_id", "reservation_id"],
    )
    op.create_index(
        "ix_tournament_event_group_reservations_event_id_stage_id",
        "tournament_event_group_reservations",
        ["event_id", "stage_id"],
    )


def downgrade() -> None:
    # Dropped before all three of the tables it references.
    op.drop_index(
        "ix_tournament_event_group_reservations_event_id_stage_id",
        table_name="tournament_event_group_reservations",
    )
    op.drop_index(
        "ix_tournament_event_group_reservations_event_id_reservation_id",
        table_name="tournament_event_group_reservations",
    )
    op.drop_table("tournament_event_group_reservations")

    # Dropped before the reservations, events and tables it references.
    op.drop_index(
        "ix_tournament_event_reservation_tables_tournament_id_table_id",
        table_name="tournament_event_reservation_tables",
    )
    op.drop_table("tournament_event_reservation_tables")

    # Dropped before the events it references.
    op.drop_table("tournament_event_reservations")

    # Dropped before the stages it references (and before the fixtures of 0012 reference
    # it — that migration is torn down first by the chain).
    op.drop_table("tournament_event_stage_groups")

    # Dropped before the events it references, mirroring the groups immediately above —
    # the two do not reference each other, so their relative order here does not matter.
    op.drop_table("tournament_event_stages")

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
