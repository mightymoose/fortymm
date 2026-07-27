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
        sa.Column(
            "event_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tournament_events.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # A *string ref* into the event's ``pools`` JSONB value-objects, deliberately
        # NOT a foreign key — pools are value-objects on the event, not rows, so there
        # is nothing to point at (ADR-0786). Integrity is procedural: the event's pool
        # id set freezes while a draw exists. NULL = the draw is un-pooled
        # (single-elim), or this is the KO stage of an rr-then-ko event.
        sa.Column("pool_id", sa.Text(), nullable=True),
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
        # A *placement* (ADR-0790). ``table_id`` is a string ref into the tournament's
        # ``table_catalogue`` JSONB (a ``TournamentTable.id``), the same pattern as
        # ``pool_id`` — NOT a foreign key, there is no tables table. NULL = unassigned.
        sa.Column("table_id", sa.Text(), nullable=True),
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
        # no pools"), so it is compared as one.
        sa.UniqueConstraint(
            "event_id",
            "pool_id",
            "round",
            "position",
            name="uq_tournament_fixtures_event_id_pool_id_round_position",
            postgresql_nulls_not_distinct=True,
        ),
    )
    # Every read of a draw is "the fixtures of this event".
    op.create_index(
        "ix_tournament_fixtures_event_id", "tournament_fixtures", ["event_id"]
    )
    # A completed match writes ``winner_entry_id`` back and re-runs ``advance()``; that
    # path arrives holding a match id, not a fixture id.
    op.create_index(
        "ix_tournament_fixtures_match_id", "tournament_fixtures", ["match_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_tournament_fixtures_match_id", table_name="tournament_fixtures")
    op.drop_index("ix_tournament_fixtures_event_id", table_name="tournament_fixtures")
    op.drop_table("tournament_fixtures")
