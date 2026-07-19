"""Unit tests for the transport-neutral match-creation service
(``app.match_creation.create_match``), constructed directly with a
``db_session`` — no FastAPI, no HTTP client. The HTTP wire contract is covered
separately by ``test_matches.py``; here we prove the service returns the loaded
domain ``Match`` on the happy paths and raises the domain exceptions (never
``HTTPException``) on the three rejection cases the HTTP adapter maps."""

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.match_creation import create_match
from app.models import Match, MatchStatus
from app.result_acceptance import (
    OpponentNotFoundError,
    RatedNeedsRegisteredOpponentError,
    SelfMatchError,
)
from tests._helpers import make_user


async def test_create_solo_match_returns_loaded_match(db_session: AsyncSession) -> None:
    creator = await make_user(db_session, "solo-creator")

    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=None,
        league_id=None,
        best_of=5,
        rated=False,
    )

    assert isinstance(match, Match)
    assert match.status is MatchStatus.in_progress
    assert match.created_by_user_id == creator.id
    assert match.match_settings.best_of == 5
    # A solo match is never rated (a rated one without an opponent is rejected).
    assert match.match_settings.affects_rating is False
    # Two sides: the creator, plus a player-less sentinel "No opponent" side.
    sides = sorted(match.sides, key=lambda s: s.side_number)
    assert len(sides) == 2
    assert [p.user_id for p in sides[0].players] == [creator.id]
    assert sides[1].players == []


async def test_create_rated_match_against_registered_opponent(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "rated-creator")
    opponent = await make_user(db_session, "rated-opponent")

    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=3,
        rated=True,
    )

    assert match.match_settings.best_of == 3
    assert match.match_settings.affects_rating is True
    sides = sorted(match.sides, key=lambda s: s.side_number)
    assert [p.user_id for p in sides[0].players] == [creator.id]
    assert [p.user_id for p in sides[1].players] == [opponent.id]


async def test_self_match_raises_self_match_error(db_session: AsyncSession) -> None:
    creator = await make_user(db_session, "self-player")

    with pytest.raises(SelfMatchError):
        await create_match(
            db_session,
            creator=creator,
            opponent_user_id=creator.id,
            league_id=None,
            best_of=5,
            rated=True,
        )


async def test_unknown_opponent_raises_opponent_not_found(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "seeking-creator")

    with pytest.raises(OpponentNotFoundError):
        await create_match(
            db_session,
            creator=creator,
            opponent_user_id=uuid.uuid4(),
            league_id=None,
            best_of=5,
            rated=True,
        )


async def test_rated_without_opponent_raises_needs_registered_opponent(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "rated-solo-creator")

    with pytest.raises(RatedNeedsRegisteredOpponentError):
        await create_match(
            db_session,
            creator=creator,
            opponent_user_id=None,
            league_id=None,
            best_of=5,
            rated=True,
        )
