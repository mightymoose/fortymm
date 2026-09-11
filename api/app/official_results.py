"""Internal official-result interface. Callers own the transaction."""

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.schemas.match import MatchResultsGameWrite

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.match_errors import MatchNotFoundError
from app.models import (
    Match,
    MatchResult,
    Tournament,
    TournamentAccountGrant,
    TournamentEvent,
    TournamentEventStage,
    TournamentFixture,
)
from app.models.official_result import MatchVoidAction, OfficialResult, ResolutionMethod
from app.tournament_authority import can_direct


async def official_history(
    db: AsyncSession, match_id: uuid.UUID
) -> list[OfficialResult]:
    return list(
        (
            await db.scalars(
                select(OfficialResult)
                .where(OfficialResult.match_id == match_id)
                .order_by(OfficialResult.revision)
            )
        ).all()
    )


async def record_initial_result(
    db: AsyncSession,
    match: Match,
    proposal: MatchResult,
    *,
    method: ResolutionMethod,
    actor_account_id: uuid.UUID | None,
    timeout_deadline: datetime | None = None,
    timeout_policy: str | None = None,
) -> OfficialResult:
    """Record first resolution under the caller's match-transition lock.

    Does not commit or run completion effects. The caller completes the match
    in the same transaction after this append.
    """
    await db.flush()
    revision = OfficialResult(
        match_id=match.id,
        revision=1,
        proposal_id=proposal.id,
        resolution_method=method,
        actor_account_id=actor_account_id,
        games=proposal.games,
        timeout_deadline=timeout_deadline,
        timeout_policy=timeout_policy,
    )
    if method == "administrator_ruling":
        if actor_account_id is None:
            raise ValueError("ruling requires an actor")
        await _attribute_authority(db, revision, actor_account_id)
        revision.reason = "Result recorded by tournament director"
    db.add(revision)
    await db.flush()
    match.current_official_result_id = revision.id
    match.current_official_result = revision
    return revision


async def _attribute_authority(
    db: AsyncSession, revision: OfficialResult | MatchVoidAction, actor: uuid.UUID
) -> None:
    tournament = await db.scalar(
        select(Tournament)
        .join(TournamentEvent, TournamentEvent.tournament_id == Tournament.id)
        .join(TournamentEventStage, TournamentEventStage.event_id == TournamentEvent.id)
        .join(TournamentFixture, TournamentFixture.stage_id == TournamentEventStage.id)
        .where(TournamentFixture.match_id == revision.match_id)
        .execution_options(populate_existing=True)
    )
    if tournament is None or not await can_direct(db, tournament, actor):
        raise MatchNotFoundError()
    revision.tournament_id = tournament.id
    if tournament.owner_account_id == actor:
        revision.owner_revision = tournament.ownership_revision
    else:
        revision.director_grant_id = await db.scalar(
            select(TournamentAccountGrant.id).where(
                TournamentAccountGrant.tournament_id == tournament.id,
                TournamentAccountGrant.account_id == actor,
                TournamentAccountGrant.revoked_at.is_(None),
            )
        )


async def _stage_ruling_hints(db: AsyncSession, match: Match) -> None:
    from app.match_realtime import stage_match_participant_hints
    from app.tournament_realtime import stage_event_entrant_hints

    event_id = (
        await db.execute(
            select(TournamentEventStage.event_id)
            .join(
                TournamentFixture, TournamentFixture.stage_id == TournamentEventStage.id
            )
            .where(TournamentFixture.match_id == match.id)
        )
    ).scalar_one()
    await stage_match_participant_hints(db, match)
    await stage_event_entrant_hints(db, [event_id])


class StaleOfficialResultError(ValueError):
    """The author must review the current official result before retrying."""


async def correct_result(
    db: AsyncSession,
    match_id: uuid.UUID,
    actor_account_id: uuid.UUID,
    *,
    expected_revision_id: uuid.UUID,
    reason: str,
    games: list["MatchResultsGameWrite"] | None = None,
    proposal_id: uuid.UUID | None = None,
    restore_revision_id: uuid.UUID | None = None,
) -> OfficialResult:
    """Append a decisive administrator ruling. Exactly one score source is required.

    Uses the caller's transaction; never repeats first-completion side effects.
    The expected revision is mandatory, including when restoring an older score.
    """
    from app.match_scoring import load_match_for_write
    from app.match_serialization import validate_finalize_games
    from app.models import MatchStatus
    from app.schemas.match import MatchResultsGameWrite

    async with db.begin_nested():
        if not reason.strip():
            raise ValueError("A correction requires a reason")
        if (
            sum(
                source is not None
                for source in (games, proposal_id, restore_revision_id)
            )
            != 1
        ):
            raise ValueError("Supply exactly one score source")
        match = await load_match_for_write(db, match_id, actor_account_id, lock=True)
        if match.status != MatchStatus.completed:
            raise ValueError("Only a completed, non-voided match can be corrected")
        current = match.current_official_result
        if current is None or current.id != expected_revision_id:
            raise StaleOfficialResultError("The official result changed")
        revision = OfficialResult(
            match_id=match_id,
            revision=current.revision + 1,
            predecessor_id=current.id,
            proposal_id=proposal_id,
            restored_from_id=restore_revision_id,
            reason=reason.strip(),
            resolution_method="administrator_ruling",
            actor_account_id=actor_account_id,
        )
        await _attribute_authority(db, revision, actor_account_id)
        if proposal_id is not None:
            proposal = await db.scalar(
                select(MatchResult).where(
                    MatchResult.id == proposal_id, MatchResult.match_id == match_id
                )
            )
            if proposal is None:
                raise ValueError("Proposal must belong to this match")
            games = [MatchResultsGameWrite.model_validate(g) for g in proposal.games]
        if restore_revision_id is not None:
            source = await db.scalar(
                select(OfficialResult).where(
                    OfficialResult.id == restore_revision_id,
                    OfficialResult.match_id == match_id,
                )
            )
            if source is None:
                raise ValueError("Restored revision must belong to this match")
            games = [MatchResultsGameWrite.model_validate(g) for g in source.games]
        assert games is not None
        games = sorted(games, key=lambda g: g.game_number)
        validate_finalize_games(games, match.match_settings.best_of)
        revision.games = [g.model_dump() for g in games]
        db.add(revision)
        await db.flush()
        # The append trigger synchronizes the canonical board for every writer.
        match = await load_match_for_write(db, match_id, actor_account_id, lock=False)
        from app.ratings.recompute import recompute_league_ratings

        await recompute_league_ratings(
            db,
            match.league_id,
            {player.user_id for side in match.sides for player in side.players},
        )
        match = await load_match_for_write(db, match_id, actor_account_id, lock=False)
        await _stage_ruling_hints(db, match)
        await db.flush()
        return revision


async def void_official_match(
    db: AsyncSession,
    match_id: uuid.UUID,
    actor_account_id: uuid.UUID,
    *,
    reason: str,
) -> MatchVoidAction:
    """Record an administrator void, preserving scores. Caller owns the transaction."""
    from app.match_scoring import load_match_for_write
    from app.match_voiding import void_match
    from app.models import MatchStatus

    async with db.begin_nested():
        if not reason.strip():
            raise ValueError("Voiding requires a reason")
        match = await load_match_for_write(db, match_id, actor_account_id, lock=True)
        if match.status == MatchStatus.voided:
            raise ValueError("Match is already voided")
        action = MatchVoidAction(
            match_id=match_id,
            actor_account_id=actor_account_id,
            reason=reason.strip(),
            official_result_id=match.current_official_result_id,
        )
        await _attribute_authority(db, action, actor_account_id)
        db.add(action)
        await db.flush()
        await void_match(db, match)
        from app.ratings.recompute import recompute_league_ratings

        await recompute_league_ratings(
            db,
            match.league_id,
            {player.user_id for side in match.sides for player in side.players},
        )
        match = await load_match_for_write(db, match_id, actor_account_id, lock=False)
        await _stage_ruling_hints(db, match)
        await db.flush()
        return action
