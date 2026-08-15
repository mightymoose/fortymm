"""create tournament fixtures table

Revision ID: 0012
Revises: 0011
Create Date: 2026-07-12 00:00:00.000000

One table holds every draw type's fixtures (ADR-0786). Per the pre-deploy
convention in api/CLAUDE.md, edits to this migration happen in place. No
backfill — assumes a fresh / empty DB.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0012"
down_revision: Union[str, None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tournament_fixtures",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # A fixture names its STAGE, not its event (ADR 20260815 decision 5: "a fixture
        # names its stage"). The event is reachable through the stage, and ``ON DELETE
        # CASCADE`` flows event -> stage -> fixture. Every fixture belongs to exactly
        # one stage: a pooled fixture's stage is the stage owning its pool (always
        # position 0 — a director's pools never hang off any other stage, decision 3);
        # an un-pooled fixture's stage is the event's single stage for every
        # single-stage draw type, or the position-1 (knockout) stage for rr-then-ko —
        # see ``app.tournament_draws.cut_draw``, the one write seam that decides it.
        sa.Column(
            "stage_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tournament_event_stages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Half of the composite foreign key declared at the bottom of this table: a
        # fixture's pool is one of its OWN stage's pools (ADR 20260801, re-parented onto
        # the stage by ADR 20260815). NULL = the draw is un-pooled (single-elim), or
        # this is the KO stage of an rr-then-ko event — and a composite FK with a NULL
        # member is satisfied vacuously under MATCH SIMPLE, which is exactly what an
        # un-pooled fixture wants.
        sa.Column("pool_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("round", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        # NULL means exactly one thing: TBD — ``advance()`` fills it when the feeding
        # fixture is decided. A bye is NOT a NULL side; it is the *absence of a row*.
        # Hence no ``is_bye`` flag.
        #
        # CASCADE, not RESTRICT, because of the event-delete path: deleting an event
        # cascades to tournament_entries and tournament_fixtures in one statement, and
        # RESTRICT (checked immediately, undeferrable) would make that delete depend on
        # the order Postgres fires the two cascades in. NOTE: merge_user hard-deletes a
        # guest's duplicate active entry, which under this CASCADE would take its
        # fixtures with it — the merge path handles that by *un-cutting* the event's
        # draw, never by re-pointing these columns onto the survivor (that would seat one
        # human in two pool slots and silently pass the go-live currency check). See
        # ADR-786 and the model docstring; separate chore.
        sa.Column(
            "entry_a_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tournament_entries.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "entry_b_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tournament_entries.id", ondelete="CASCADE"),
            nullable=True,
        ),
        # Written back when this fixture's match completes (a later slice).
        sa.Column(
            "winner_entry_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tournament_entries.id", ondelete="CASCADE"),
            nullable=True,
        ),
        # Set when the fixture materializes into a real match, which only happens once
        # the tournament is live (ADR-0786).
        sa.Column(
            "match_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("matches.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # A *placement* (ADR-0790). ``table_id`` is a real FOREIGN KEY into
        # ``tournament_tables`` (created by 0010) — "the placement names a real table"
        # is the one placement claim that is an invariant rather than a flag-on-read
        # (ADR 20260801). NULL = unassigned.
        #
        # RESTRICT, not SET NULL: removing a table a fixture is placed at destroys
        # information on an unrelated write — the fixture would become
        # indistinguishable from one nobody ever placed — so the database refuses and
        # the director opts in explicitly. A *pool* that merely reserves the table gets
        # ON DELETE CASCADE on its own side instead; only a placement is loud.
        sa.Column(
            "table_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("tournament_tables.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        # ``scheduled_start`` is a placement's predicted start — a ``timestamptz``
        # instant (TIMESTAMP WITH TIME ZONE), composed server-side from the event's
        # Slot wall-clock components anchored by the event timezone. The 2026-07-19 ADR
        # "tournament times are timezone-aware instants" supersedes ADR-0790's
        # naive-wall-clock exemption on the representation question and moves this onto
        # timezone-aware instants. NULL = unassigned.
        sa.Column("scheduled_start", sa.DateTime(timezone=True), nullable=True),
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
        # The pin facts (ADR 2026-07-16 "the schedule is solved, the call is
        # pinned"). ``pinned_at`` is a ``timestamptz`` instant (TIMESTAMP WITH
        # TIME ZONE) — the call's ``now`` — like the ``scheduled_start`` above
        # it. The 2026-07-19 ADR "tournament times are timezone-aware instants"
        # governs both. NULL = unpinned.
        sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True),
        # How many times the players were told about this fixture's placement —
        # the initial call plus every moved/cancelled correction. 0 = never.
        sa.Column(
            "call_notified_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        # The identity a re-cut reconciles on. NULLS NOT DISTINCT (Postgres 15+):
        # under the default, a NULL pool_id compares unequal to itself, which would
        # leave un-pooled draws (single-elim — every row has pool_id IS NULL) with no
        # uniqueness guard whatsoever. NULL is a real domain value here ("this draw has
        # no pools"), so it is compared as one. Keyed on ``stage_id`` rather than
        # ``event_id`` (ADR 20260815 decision 5) — which is also what makes the
        # knockout stage's round numbering restarting at 1 fall out of the key, rather
        # than needing to be a documented namespace rule the way it was under a single
        # event-wide identity.
        sa.UniqueConstraint(
            "stage_id",
            "pool_id",
            "round",
            "position",
            name="uq_tournament_fixtures_stage_id_pool_id_round_position",
            postgresql_nulls_not_distinct=True,
        ),
        # "A fixture's pool belongs to that fixture's own stage", as one line of DDL
        # (ADR 20260801, re-parented onto the stage by ADR 20260815). It references
        # ``tournament_event_pools (stage_id, id)`` — a unique constraint that exists
        # purely to be this FK's target, since a plain FK to the pool's ``id`` alone
        # could not say the stage part, which is the whole claim. Added here in place
        # per the pre-deploy convention; the pools table is created by 0010, so it
        # exists by the time this runs.
        #
        # DEFERRABLE INITIALLY DEFERRED, with the default NO ACTION delete rule rather
        # than RESTRICT: deleting an event removes its pools through the ORM and its
        # fixtures through ``ON DELETE CASCADE``, in two separate statements, so an
        # immediately-checked constraint would fire between them on fixtures that are
        # about to be deleted anyway. Deferring checks the same pair, in full, before
        # COMMIT.
        sa.ForeignKeyConstraint(
            ["stage_id", "pool_id"],
            ["tournament_event_pools.stage_id", "tournament_event_pools.id"],
            name="fk_tournament_fixtures_stage_id_pool_id",
            deferrable=True,
            initially="DEFERRED",
        ),
    )
    # Every read of a draw is "the fixtures of this stage".
    op.create_index(
        "ix_tournament_fixtures_stage_id", "tournament_fixtures", ["stage_id"]
    )
    # A completed match writes ``winner_entry_id`` back and re-runs ``advance()``; that
    # path arrives holding a match id, not a fixture id.
    op.create_index(
        "ix_tournament_fixtures_match_id", "tournament_fixtures", ["match_id"]
    )
    # The index Postgres does not create for a REFERENCING column. Under RESTRICT every
    # delete of a ``tournament_tables`` row must prove no fixture references it, which
    # unindexed is a sequential scan of every fixture on the platform per table removed.
    op.create_index(
        "ix_tournament_fixtures_table_id", "tournament_fixtures", ["table_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_tournament_fixtures_table_id", table_name="tournament_fixtures")
    op.drop_index("ix_tournament_fixtures_match_id", table_name="tournament_fixtures")
    op.drop_index("ix_tournament_fixtures_stage_id", table_name="tournament_fixtures")
    op.drop_table("tournament_fixtures")
