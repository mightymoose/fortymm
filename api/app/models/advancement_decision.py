"""Immutable reasons for result-derived fixture seating."""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    FetchedValue,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class AdvancementDecision(Base):
    __tablename__ = "fixture_advancement_decisions"
    __table_args__ = (
        CheckConstraint("id <> predecessor_id", name="ck_advancement_not_self"),
        CheckConstraint(
            "(source_group_id IS NULL AND rule_settings = '{}'::jsonb) OR "
            "(source_group_id IS NOT NULL AND "
            "(jsonb_typeof(rule_settings->'qualification_place') = 'number' "
            "AND (rule_settings->>'qualification_place') ~ '^[1-9][0-9]*$' "
            "AND jsonb_typeof(rule_settings->'qualifiers_per_group') = "
            "'number' AND (rule_settings->>'qualifiers_per_group') ~ "
            "'^[1-9][0-9]*$' AND jsonb_typeof(rule_settings->'group_count') = "
            "'number' AND (rule_settings->>'group_count') ~ '^[1-9][0-9]*$' "
            "AND jsonb_typeof(rule_settings->'group_index') = 'number' AND "
            "(rule_settings->>'group_index') ~ '^(0|[1-9][0-9]*)$' AND "
            "jsonb_typeof(rule_settings->'seed') = 'number' AND "
            "(rule_settings->>'seed') ~ '^[1-9][0-9]*$' AND rule_settings - "
            "ARRAY['qualification_place','qualifiers_per_group','group_count',"
            "'group_index','seed'] = '{}'::jsonb) IS TRUE)",
            name="ck_advancement_rule_settings",
        ),
        CheckConstraint(
            "(unknown_reason IS NOT NULL AND length(trim(unknown_reason)) > 0 "
            "AND source_fixture_id IS NULL AND source_group_id IS NULL AND "
            "evidence_count = 0 AND rule_version = 'unknown') OR "
            "(unknown_reason IS NULL AND num_nonnulls(source_fixture_id, "
            "source_group_id) = 1 AND evidence_count > 0 AND rule_version <> "
            "'unknown')",
            name="ck_advancement_provenance",
        ),
        CheckConstraint(
            "jsonb_typeof(rule_settings) = 'object'", name="ck_advancement_settings"
        ),
        CheckConstraint(
            "predecessor_id IS NULL OR (actor_account_id IS NOT NULL AND "
            "reason IS NOT NULL AND length(trim(reason)) > 0)",
            name="ck_advancement_replacement_actor",
        ),
        CheckConstraint("evidence_count >= 0", name="ck_advancement_evidence_count"),
        CheckConstraint("side IN ('a', 'b')", name="ck_advancement_side"),
        CheckConstraint("length(trim(rule_version)) > 0", name="ck_advancement_rule"),
        CheckConstraint(
            "revision >= 1 AND ((revision = 1) = (predecessor_id IS NULL))",
            name="ck_advancement_revision",
        ),
        UniqueConstraint("id", "fixture_id", "side", name="uq_advancement_seat"),
        UniqueConstraint(
            "fixture_id", "side", "revision", name="uq_advancement_revision"
        ),
        UniqueConstraint("predecessor_id", name="uq_advancement_successor"),
        ForeignKeyConstraint(
            ["predecessor_id", "fixture_id", "side"],
            [
                "fixture_advancement_decisions.id",
                "fixture_advancement_decisions.fixture_id",
                "fixture_advancement_decisions.side",
            ],
            name="fk_advancement_predecessor",
        ),
        Index(
            "uq_advancement_root",
            "fixture_id",
            "side",
            unique=True,
            postgresql_where=text("predecessor_id IS NULL"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tournament_events.id"), server_default=FetchedValue(), index=True
    )
    fixture_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tournament_fixtures.id"))
    side: Mapped[str]
    entry_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tournament_entries.id"))
    source_fixture_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tournament_fixtures.id")
    )
    source_group_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tournament_event_stage_groups.id")
    )
    rule_version: Mapped[str]
    rule_settings: Mapped[dict[str, int]] = mapped_column(JSONB)
    evidence_count: Mapped[int] = mapped_column(server_default=text("1"))
    revision: Mapped[int] = mapped_column(server_default=text("1"))
    predecessor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    actor_account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("accounts.id")
    )
    reason: Mapped[str | None]
    unknown_reason: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AdvancementEvidence(Base):
    __tablename__ = "advancement_decision_evidence"
    __table_args__ = (
        ForeignKeyConstraint(
            ["official_result_id", "match_id"],
            ["match_official_results.id", "match_official_results.match_id"],
            name="fk_advancement_evidence_result",
        ),
    )
    decision_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("fixture_advancement_decisions.id"), primary_key=True
    )
    match_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("matches.id"), primary_key=True
    )
    official_result_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
