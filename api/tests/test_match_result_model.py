import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import get_default_league
from app.models import (
    Match,
    MatchResult,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    User,
)


async def _make_match(db: AsyncSession, creator: User) -> Match:
    league = await get_default_league(db)
    settings = MatchSettings(team_size=1, best_of=5, affects_rating=False)
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=creator.id,
        status=MatchStatus.in_progress,
    )
    side = MatchSide(match=match, side_number=1)
    side.players.append(MatchSidePlayer(match=match, user=creator.primary_player))
    db.add(match)
    await db.commit()
    await db.refresh(match)
    return match


async def test_supersedes_result_id_is_unique(db_session: AsyncSession):
    """The database must encode the linear result-chain invariant:
    a proposal can have at most one successor. Two counters pointing at the same
    parent violate ``uq_match_results_supersedes_result_id`` and one collides —
    the same IntegrityError the concurrent-counter code path relies on."""
    creator = User(username="alice")
    db_session.add(creator)
    await db_session.commit()

    match = await _make_match(db_session, creator)

    base = MatchResult(
        match_id=match.id,
        submitted_for_player_id=creator.id,
        submitted_by_user_id=creator.id,
        games=[],
    )
    db_session.add(base)
    await db_session.commit()
    await db_session.refresh(base)

    db_session.add(
        MatchResult(
            match_id=match.id,
            submitted_for_player_id=creator.id,
            submitted_by_user_id=creator.id,
            games=[],
            supersedes_result_id=base.id,
        )
    )
    db_session.add(
        MatchResult(
            match_id=match.id,
            submitted_for_player_id=creator.id,
            submitted_by_user_id=creator.id,
            games=[],
            supersedes_result_id=base.id,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()
