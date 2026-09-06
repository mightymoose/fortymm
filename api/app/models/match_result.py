import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.account import Account
    from app.models.match import Match


class MatchResult(Base):
    """A proposed result — the "claim" created by ``POST /v1/matches/{id}/results``.

    One row per proposal, carrying who submitted it, when, an **immutable JSONB
    snapshot of the claimed board**, and (once agreed) who accepted it and when.
    A counter-proposal is a new row whose ``supersedes_result_id`` points at the
    proposal it replaces, so the full negotiation history survives as a linear
    chain instead of being mutated away on the working ``match_games`` scratchpad.

    Alembic installs the append-order, immutable-write and deletion guards;
    metadata alone does not define a complete application database.

    Derived roles (never stored): a result is *accepted* iff
    ``accepted_by_user_id IS NOT NULL``; *superseded* iff some other row's
    ``supersedes_result_id`` equals its id; the *head* of the chain is the one
    result nothing supersedes; the *standing* proposal is the head when it is not
    yet accepted.
    """

    __tablename__ = "match_results"
    __table_args__ = (
        CheckConstraint("supersedes_result_id <> id", name="ck_match_results_not_self"),
        UniqueConstraint("id", "match_id", name="uq_match_results_id_match"),
        ForeignKeyConstraint(
            ["supersedes_result_id", "match_id"],
            ["match_results.id", "match_results.match_id"],
            name="fk_match_results_predecessor_match",
            ondelete="RESTRICT",
        ),
        Index("ix_match_results_match_id", "match_id"),
        Index(
            "uq_match_results_root",
            "match_id",
            unique=True,
            postgresql_where=text("supersedes_result_id IS NULL"),
        ),
        # The acceptance columns are written together (propose's self-accept,
        # accept's stamp), so a row with exactly one of them set is an illegal
        # state — forbid it at the DB rather than trusting every write path.
        CheckConstraint(
            "(accepted_by_user_id IS NULL) = (accepted_at IS NULL)",
            name="ck_match_results_accepted_pair",
        ),
        # Bounds each proposal to at most one successor so the negotiation chain
        # stays linear: two concurrent counters to the same parent collide and
        # one 409s on the IntegrityError. Mirrors the production migration.
        UniqueConstraint(
            "supersedes_result_id",
            name="uq_match_results_supersedes_result_id",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    match_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("matches.id", ondelete="RESTRICT"),
        nullable=False,
    )
    # Preserve the original acting Account, including after a same-person merge.
    submitted_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="RESTRICT"),
        nullable=False,
    )
    submitted_for_player_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("players.id", ondelete="RESTRICT"), nullable=True
    )
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # The proposal this row counters, forming a linear negotiation chain. NULL
    # for the first proposal on a match. A UNIQUE constraint (migration) bounds
    # each proposal to at most one successor, so two concurrent counters to the
    # same parent collide and one 409s.
    supersedes_result_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        nullable=True,
    )
    # The opposing-side participant who accepted this proposal. NULL while the
    # proposal is still standing. RESTRICT mirrors ``submitted_by_user_id`` so an
    # account merge preserves the original actor.
    accepted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="RESTRICT"),
        nullable=True,
    )
    accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Dedupe marker for the "your retirement deadline is nearing" reminder
    # (task #6 / O7): stamped once the daily sweep sends the single ~24h-before
    # reminder so a later tick doesn't re-send. NULL until sent. It lives on the
    # standing result (not the match) so that a counter-proposal — a *new* result
    # row with its own NULL marker — legitimately re-arms the reminder for the
    # freshly-restarted retirement window. See app/retirement_jobs.py.
    reminder_sent_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Immutable snapshot of the claimed board, frozen at post time. A list of
    # ``{"game_number", "side_1_points", "side_2_points"}`` objects (decode into
    # a typed model at read time, per "parse, don't validate"). The working
    # ``match_games`` scratchpad stays the live, editable board; this is the
    # write-once record of what this proposal claimed.
    games: Mapped[list[dict[str, int]]] = mapped_column(JSONB, nullable=False)

    match: Mapped["Match"] = relationship(back_populates="results")
    # Two FKs point at ``accounts`` (submitted_by_user_id, accepted_by_user_id), so
    # both relationships MUST pin foreign_keys explicitly or SQLAlchemy raises
    # AmbiguousForeignKeysError.
    submitted_by: Mapped["Account"] = relationship(
        "Account", foreign_keys=[submitted_by_user_id]
    )
    accepted_by: Mapped["Account | None"] = relationship(
        "Account", foreign_keys=[accepted_by_user_id]
    )
