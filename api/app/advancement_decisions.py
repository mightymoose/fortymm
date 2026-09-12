"""Record and inspect why a result-derived participant occupies a fixture seat.

Callers own the transaction. Decisions and their evidence are inserted together with
seating, and the only current decision is the head of each seat's linear history.
"""

import uuid
from dataclasses import dataclass
from typing import Literal

from pydantic import TypeAdapter
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import GroupAdvancement, KnockoutAdvancement, SideFill
from app.models import (
    Account,
    AdvancementDecision,
    AdvancementEvidence,
    Match,
    MatchLineup,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    OfficialResult,
    Tournament,
    TournamentEntryMember,
    TournamentEvent,
    TournamentFixture,
)

_RULE_SETTINGS = TypeAdapter(dict[str, int])


@dataclass(frozen=True)
class AdvancementView:
    id: uuid.UUID
    entry_id: uuid.UUID
    source_fixture_id: uuid.UUID | None
    source_group_id: uuid.UUID | None
    rule_version: str
    rule_settings: dict[str, int]
    official_result_ids: tuple[uuid.UUID, ...]
    actor_account_id: uuid.UUID | None
    reason: str | None
    unknown_reason: str | None
    current: bool
    evidence_status: Literal["current", "stale", "unknown"]


async def advancement_history(
    db: AsyncSession, fixture_id: uuid.UUID, side: Literal["a", "b"]
) -> list[AdvancementView]:
    decisions = (
        await db.scalars(
            select(AdvancementDecision)
            .where(
                AdvancementDecision.fixture_id == fixture_id,
                AdvancementDecision.side == side,
            )
            .order_by(AdvancementDecision.revision)
        )
    ).all()
    views = []
    for decision in decisions:
        evidence = (
            await db.scalars(
                select(AdvancementEvidence)
                .where(AdvancementEvidence.decision_id == decision.id)
                .order_by(AdvancementEvidence.match_id)
            )
        ).all()
        matches = (
            await db.execute(
                select(Match.id, Match.current_official_result_id, Match.status).where(
                    Match.id.in_([e.match_id for e in evidence])
                )
            )
        ).all()
        current_results = {m.id: m.current_official_result_id for m in matches}
        stale = any(
            current_results[e.match_id] != e.official_result_id for e in evidence
        ) or any(m.status == MatchStatus.voided for m in matches)
        views.append(
            AdvancementView(
                id=decision.id,
                entry_id=decision.entry_id,
                source_fixture_id=decision.source_fixture_id,
                source_group_id=decision.source_group_id,
                rule_version=decision.rule_version,
                rule_settings=_RULE_SETTINGS.validate_python(
                    decision.rule_settings, strict=True
                ),
                official_result_ids=tuple(e.official_result_id for e in evidence),
                actor_account_id=decision.actor_account_id,
                reason=decision.reason,
                unknown_reason=decision.unknown_reason,
                current=decision is decisions[-1],
                evidence_status="unknown"
                if decision.unknown_reason is not None
                else "stale"
                if stale
                else "current",
            )
        )
    return views


async def record_side_fill(db: AsyncSession, fill: SideFill) -> None:
    source_fixture_id: uuid.UUID | None
    source_group_id: uuid.UUID | None
    match fill.provenance:
        case None:
            return
        case KnockoutAdvancement(source_fixture_id=source_fixture_id):
            source_group_id = None
            settings = {}
            rule_version = "knockout_winner_v1"
        case GroupAdvancement() as group:
            source_fixture_id = None
            source_group_id = group.source_group_id
            settings = {
                "qualification_place": group.qualification_place,
                "qualifiers_per_group": group.qualifiers_per_group,
                "group_count": group.group_count,
                "group_index": group.group_index,
                "seed": group.seed,
            }
            rule_version = "group_finishing_order_v1"
    contributing = await _current_evidence(db, source_fixture_id, source_group_id)
    decision = AdvancementDecision(
        fixture_id=fill.fixture_id,
        side=fill.side.value,
        entry_id=fill.entry_id,
        source_fixture_id=source_fixture_id,
        source_group_id=source_group_id,
        evidence_count=len(contributing),
        rule_version=rule_version,
        rule_settings=settings,
    )
    db.add(decision)
    await db.flush()
    for match in contributing:
        if match.current_official_result_id is None:
            raise ValueError("Advancement requires complete official-result evidence")
        db.add(
            AdvancementEvidence(
                decision_id=decision.id,
                match_id=match.id,
                official_result_id=match.current_official_result_id,
            )
        )


@dataclass(frozen=True)
class _SupportingResult:
    id: uuid.UUID
    current_official_result_id: uuid.UUID


async def _current_evidence(
    db: AsyncSession,
    source_fixture_id: uuid.UUID | None,
    source_group_id: uuid.UUID | None,
) -> list[_SupportingResult]:
    rows = (
        await db.execute(
            select(Match.id, Match.status, Match.current_official_result_id)
            .select_from(TournamentFixture)
            .outerjoin(Match, Match.id == TournamentFixture.match_id)
            .where(
                (TournamentFixture.id == source_fixture_id)
                if source_fixture_id is not None
                else (TournamentFixture.group_id == source_group_id)
            )
        )
    ).all()
    contributing = []
    for match_id, status, revision_id in rows:
        if status == MatchStatus.voided:
            continue
        if match_id is None or status != MatchStatus.completed or revision_id is None:
            raise ValueError("Advancement requires complete official-result evidence")
        contributing.append(_SupportingResult(match_id, revision_id))
    if not contributing:
        raise ValueError("Advancement requires complete official-result evidence")
    return contributing


async def replace_advancement(
    db: AsyncSession,
    fixture_id: uuid.UUID,
    side: Literal["a", "b"],
    *,
    expected_current_id: uuid.UUID,
    actor_account_id: uuid.UUID,
    reason: str,
    entry_id: uuid.UUID,
    official_result_ids: tuple[uuid.UUID, ...],
) -> uuid.UUID:
    """Append an explicit replacement using the same source and rule snapshot.

    The caller supplies reviewed evidence and owns the transaction. An expected head
    prevents lost updates; the tournament/fixture locks follow materialization order.
    This does not recalculate qualification or expose a director workflow.
    """
    if not reason.strip():
        raise ValueError("An advancement replacement requires a reason")
    async with db.begin_nested():
        fixture = (
            await db.scalars(
                select(TournamentFixture).where(TournamentFixture.id == fixture_id)
            )
        ).one()
        locked_match_id = fixture.match_id
        await db.execute(
            select(Account.id)
            .where(Account.id == actor_account_id)
            .with_for_update(read=True, key_share=True)
        )
        await db.execute(
            select(Tournament.id)
            .where(Tournament.id == fixture.scope_tournament_id)
            .with_for_update()
        )
        await db.execute(
            select(TournamentEvent.id)
            .where(TournamentEvent.id == fixture.scope_event_id)
            .with_for_update()
        )
        if locked_match_id is not None:
            await db.execute(
                select(Match.id).where(Match.id == locked_match_id).with_for_update()
            )
        fixture = (
            await db.scalars(
                select(TournamentFixture)
                .where(TournamentFixture.id == fixture_id)
                .with_for_update(of=TournamentFixture)
                .execution_options(populate_existing=True)
            )
        ).one()
        if fixture.match_id != locked_match_id:
            raise ValueError("The current target match changed; retry replacement")
        previous = (
            await db.scalars(
                select(AdvancementDecision)
                .where(
                    AdvancementDecision.fixture_id == fixture_id,
                    AdvancementDecision.side == side,
                )
                .order_by(AdvancementDecision.revision.desc())
                .limit(1)
            )
        ).one_or_none()
        if previous is None or previous.id != expected_current_id:
            raise ValueError("Expected advancement is no longer current")
        if entry_id != previous.entry_id and fixture.match_id is not None:
            recorded = await db.scalar(
                select(MatchLineup.id).where(MatchLineup.match_id == fixture.match_id)
            )
            if recorded is not None:
                raise ValueError(
                    "Advancement cannot change a participant after recorded play"
                )
        expected = await _current_evidence(
            db, previous.source_fixture_id, previous.source_group_id
        )
        if set(official_result_ids) != {m.current_official_result_id for m in expected}:
            raise ValueError(
                "Replacement requires complete current official-result evidence"
            )
        results = (
            await db.scalars(
                select(OfficialResult).where(OfficialResult.id.in_(official_result_ids))
            )
        ).all()
        if not official_result_ids or len(results) != len(official_result_ids):
            raise ValueError("Replacement requires complete official-result evidence")
        decision = AdvancementDecision(
            fixture_id=fixture_id,
            side=side,
            entry_id=entry_id,
            source_fixture_id=previous.source_fixture_id,
            source_group_id=previous.source_group_id,
            rule_version=previous.rule_version,
            rule_settings=previous.rule_settings,
            revision=previous.revision + 1,
            predecessor_id=previous.id,
            actor_account_id=actor_account_id,
            reason=reason.strip(),
            evidence_count=len(results),
        )
        db.add(decision)
        await db.flush()
        for result in results:
            db.add(
                AdvancementEvidence(
                    decision_id=decision.id,
                    match_id=result.match_id,
                    official_result_id=result.id,
                )
            )
        if side == "a":
            fixture.entry_a_id = entry_id
        else:
            fixture.entry_b_id = entry_id
        if fixture.match_id is not None and previous.entry_id != entry_id:
            match_side_id = (
                await db.scalars(
                    select(MatchSide.id).where(
                        MatchSide.match_id == fixture.match_id,
                        MatchSide.side_number == (1 if side == "a" else 2),
                    )
                )
            ).one()
            players = (
                await db.scalars(
                    select(TournamentEntryMember.player_id).where(
                        TournamentEntryMember.entry_id == entry_id,
                        TournamentEntryMember.left_at.is_(None),
                    )
                )
            ).all()
            if not players:
                raise ValueError("Replacement entry has no current participants")
            await db.execute(
                delete(MatchSidePlayer).where(
                    MatchSidePlayer.match_side_id == match_side_id
                )
            )
            db.add_all(
                [
                    MatchSidePlayer(
                        match_side_id=match_side_id,
                        match_id=fixture.match_id,
                        user_id=player_id,
                    )
                    for player_id in players
                ]
            )
        await db.flush()
        await db.execute(
            text(
                "SET CONSTRAINTS check_advancement, check_advancement_evidence, "
                "guard_advancement_seat, guard_fixture_advancement IMMEDIATE"
            )
        )
        await db.execute(
            text(
                "SET CONSTRAINTS check_advancement, check_advancement_evidence, "
                "guard_advancement_seat, guard_fixture_advancement DEFERRED"
            )
        )
        return decision.id
