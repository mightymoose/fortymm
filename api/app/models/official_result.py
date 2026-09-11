"""Immutable official scores, separate from participant proposals."""

import uuid
from datetime import datetime
from typing import Literal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

type ResolutionMethod = Literal[
    "opponent_acceptance", "timeout", "administrator_ruling", "immediate_finalization"
]


class OfficialResult(Base):
    __tablename__ = "match_official_results"

    __table_args__ = (
        CheckConstraint(
            "resolution_method IN ('opponent_acceptance', 'timeout', "
            "'administrator_ruling', 'immediate_finalization')",
            name="ck_official_results_method",
        ),
        CheckConstraint(
            "(resolution_method = 'timeout' AND actor_account_id IS NULL) OR "
            "(resolution_method <> 'timeout' AND actor_account_id IS NOT NULL)",
            name="ck_official_results_actor",
        ),
        CheckConstraint(
            "proposal_id IS NULL OR restored_from_id IS NULL",
            name="ck_official_results_single_source",
        ),
        CheckConstraint(
            "resolution_method = 'administrator_ruling' OR (proposal_id IS NOT "
            "NULL AND predecessor_id IS NULL AND restored_from_id IS NULL)",
            name="ck_official_results_source",
        ),
        CheckConstraint(
            "(resolution_method = 'administrator_ruling' AND tournament_id IS "
            "NOT NULL AND reason IS NOT NULL AND reason ~ '[^[:space:]]' AND "
            "((owner_revision IS NOT NULL AND owner_revision >= 0 AND "
            "director_grant_id IS NULL) OR (owner_revision IS NULL AND "
            "director_grant_id IS NOT NULL))) OR (resolution_method <> "
            "'administrator_ruling' AND tournament_id IS NULL AND reason IS "
            "NULL AND owner_revision IS NULL AND director_grant_id IS NULL)",
            name="ck_official_results_authority",
        ),
        CheckConstraint(
            "(resolution_method = 'timeout' AND timeout_deadline IS NOT NULL "
            "AND timeout_policy IS NOT NULL AND timeout_policy = "
            "'retirement_window_v1' AND recorded_at >= timeout_deadline) OR "
            "(resolution_method <> 'timeout' AND timeout_deadline IS NULL AND "
            "timeout_policy IS NULL)",
            name="ck_official_results_timeout",
        ),
        CheckConstraint(
            "jsonb_typeof(games) = 'array' AND jsonb_array_length(games) > 0",
            name="ck_official_results_games",
        ),
        UniqueConstraint("id", "match_id", name="uq_official_results_id_match"),
        UniqueConstraint("match_id", "revision", name="uq_official_results_revision"),
        UniqueConstraint("predecessor_id", name="uq_official_results_successor"),
        CheckConstraint(
            "(revision = 1 AND predecessor_id IS NULL) OR (revision > 1 AND "
            "predecessor_id IS NOT NULL)",
            name="ck_official_results_root_number",
        ),
        CheckConstraint("id <> predecessor_id", name="ck_official_results_not_self"),
        Index(
            "uq_official_results_root",
            "match_id",
            unique=True,
            postgresql_where=text("predecessor_id IS NULL"),
        ),
        ForeignKeyConstraint(
            ["predecessor_id", "match_id"],
            ["match_official_results.id", "match_official_results.match_id"],
            name="fk_official_results_predecessor",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["restored_from_id", "match_id"],
            ["match_official_results.id", "match_official_results.match_id"],
            name="fk_official_results_restored",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["proposal_id", "match_id"],
            ["match_results.id", "match_results.match_id"],
            name="fk_official_results_proposal",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    match_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("matches.id", ondelete="RESTRICT")
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    predecessor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    restored_from_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    proposal_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    resolution_method: Mapped[ResolutionMethod] = mapped_column(String, nullable=False)
    actor_account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT")
    )
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.clock_timestamp()
    )
    reason: Mapped[str | None] = mapped_column(String)
    tournament_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tournaments.id", ondelete="RESTRICT")
    )
    owner_revision: Mapped[int | None] = mapped_column(Integer)
    director_grant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tournament_account_grants.id", ondelete="RESTRICT")
    )
    timeout_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    timeout_policy: Mapped[str | None] = mapped_column(String)
    games: Mapped[list[dict[str, int]]] = mapped_column(JSONB, nullable=False)


class MatchVoidAction(Base):
    """An administrator void is an audited action, not an undecided score."""

    __tablename__ = "match_void_actions"
    __table_args__ = (
        UniqueConstraint("match_id", name="uq_match_void_actions_match"),
        ForeignKeyConstraint(
            ["official_result_id", "match_id"],
            ["match_official_results.id", "match_official_results.match_id"],
            name="fk_match_void_actions_result",
            ondelete="RESTRICT",
        ),
        CheckConstraint("reason ~ '[^[:space:]]'", name="ck_match_void_actions_reason"),
        CheckConstraint(
            "(owner_revision IS NOT NULL AND owner_revision >= 0 AND "
            "director_grant_id IS NULL) OR (owner_revision IS NULL AND "
            "director_grant_id IS NOT NULL)",
            name="ck_match_void_actions_authority",
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    match_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("matches.id", ondelete="RESTRICT")
    )
    official_result_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    actor_account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT")
    )
    reason: Mapped[str] = mapped_column(String, nullable=False)
    tournament_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tournaments.id", ondelete="RESTRICT")
    )
    owner_revision: Mapped[int | None] = mapped_column(Integer)
    director_grant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tournament_account_grants.id", ondelete="RESTRICT")
    )
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.clock_timestamp()
    )
