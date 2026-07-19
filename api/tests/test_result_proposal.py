"""Unit tests for the transport-neutral result-proposal service
(``app.result_proposal.propose_result``) — the first verb of the propose/accept
negotiation, covering both a first proposal and a counter. Constructed directly
with a ``db_session`` (no FastAPI, no HTTP client): the HTTP wire contract is
covered by ``test_matches.py``; here we prove the service self-accepts +
finalizes solo/unrated matches, leaves a rated two-human match standing, honours
the counter chain, and raises the domain exceptions (never ``HTTPException``)
the adapters map."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.match_creation import create_match
from app.models import MatchStatus
from app.result_acceptance import (
    MatchClosedError,
    NegotiationConflictError,
    UndecidedBoardError,
)
from app.result_chain import accepted_result, standing_result
from app.result_proposal import propose_result
from app.schemas.match import MatchResultsGameWrite
from tests._helpers import make_user


def _decisive_board(winner_side: int = 1) -> list[MatchResultsGameWrite]:
    """A single decided game for a best-of-1 board (``winner_side`` takes it)."""
    if winner_side == 1:
        return [MatchResultsGameWrite(game_number=1, side_1_points=11, side_2_points=4)]
    return [MatchResultsGameWrite(game_number=1, side_1_points=4, side_2_points=11)]


async def test_first_proposal_on_solo_match_self_accepts_and_finalizes(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "solo-proposer")
    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )

    outcome = await propose_result(
        db_session,
        match.id,
        creator.id,
        games=_decisive_board(winner_side=1),
        supersedes_result_id=None,
    )

    # No second human to accept — the proposer self-accepts and the match
    # finalizes immediately.
    assert outcome.awaiting_acceptance is False
    assert outcome.match.status is MatchStatus.completed
    sides = sorted(outcome.match.sides, key=lambda s: s.side_number)
    assert sides[0].won is True
    assert sides[1].won is False
    # A finalized result is accepted (not "standing"): the proposer self-accepts.
    assert standing_result(outcome.match) is None
    result = accepted_result(outcome.match)
    assert result is not None
    assert result.accepted_by_user_id == creator.id
    assert result.accepted_at is not None


async def test_first_proposal_on_rated_match_stays_standing(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "rated-proposer")
    opponent = await make_user(db_session, "rated-recipient")
    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=1,
        rated=True,
    )

    outcome = await propose_result(
        db_session,
        match.id,
        creator.id,
        games=_decisive_board(winner_side=1),
        supersedes_result_id=None,
    )

    # A rated two-human match leaves the result standing for the opposing side.
    assert outcome.awaiting_acceptance is True
    assert outcome.match.status is MatchStatus.in_progress
    standing = standing_result(outcome.match)
    assert standing is not None
    assert standing.submitted_by_user_id == creator.id
    assert standing.accepted_by_user_id is None
    # No W/L stamped until acceptance.
    assert all(side.won is None for side in outcome.match.sides)


async def test_counter_supersedes_the_standing_result(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "counter-proposer")
    opponent = await make_user(db_session, "counter-recipient")
    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=1,
        rated=True,
    )

    first = await propose_result(
        db_session,
        match.id,
        creator.id,
        games=_decisive_board(winner_side=1),
        supersedes_result_id=None,
    )
    first_id = standing_result(first.match)
    assert first_id is not None

    countered = await propose_result(
        db_session,
        match.id,
        opponent.id,
        games=_decisive_board(winner_side=2),
        supersedes_result_id=first_id.id,
    )

    # The counter mints a superseding result; still standing (rated), chain length 2.
    assert countered.awaiting_acceptance is True
    assert countered.match.status is MatchStatus.in_progress
    assert len(countered.match.results) == 2
    new_standing = standing_result(countered.match)
    assert new_standing is not None
    assert new_standing.supersedes_result_id == first_id.id
    assert new_standing.submitted_by_user_id == opponent.id


async def test_counter_targeting_a_stale_id_raises_negotiation_conflict(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "stale-proposer")
    opponent = await make_user(db_session, "stale-recipient")
    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=1,
        rated=True,
    )

    first = await propose_result(
        db_session,
        match.id,
        creator.id,
        games=_decisive_board(winner_side=1),
        supersedes_result_id=None,
    )
    first_result = standing_result(first.match)
    assert first_result is not None

    # A counter moves the head off ``first_result``.
    await propose_result(
        db_session,
        match.id,
        opponent.id,
        games=_decisive_board(winner_side=2),
        supersedes_result_id=first_result.id,
    )

    # Superseding the now-stale (already-superseded) id is the lost-race case.
    with pytest.raises(NegotiationConflictError) as excinfo:
        await propose_result(
            db_session,
            match.id,
            creator.id,
            games=_decisive_board(winner_side=1),
            supersedes_result_id=first_result.id,
        )
    # It carries the loaded match so the adapter can build the moved-on snapshot.
    assert excinfo.value.match.id == match.id


async def test_first_proposal_colliding_with_existing_result_conflicts(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "collide-proposer")
    opponent = await make_user(db_session, "collide-recipient")
    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=1,
        rated=True,
    )

    await propose_result(
        db_session,
        match.id,
        creator.id,
        games=_decisive_board(winner_side=1),
        supersedes_result_id=None,
    )

    # A second first-post (no supersedes) against an existing chain loses.
    with pytest.raises(NegotiationConflictError):
        await propose_result(
            db_session,
            match.id,
            opponent.id,
            games=_decisive_board(winner_side=2),
            supersedes_result_id=None,
        )


async def test_undecided_board_raises_undecided_board_error(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "undecided-proposer")
    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=None,
        league_id=None,
        best_of=3,
        rated=False,
    )

    # Best-of-3 needs two game wins; one game is undecided.
    with pytest.raises(UndecidedBoardError):
        await propose_result(
            db_session,
            match.id,
            creator.id,
            games=[
                MatchResultsGameWrite(game_number=1, side_1_points=11, side_2_points=4)
            ],
            supersedes_result_id=None,
        )


async def test_terminal_match_raises_match_closed_error(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "terminal-proposer")
    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )

    # First proposal finalizes the solo match (completed).
    first = await propose_result(
        db_session,
        match.id,
        creator.id,
        games=_decisive_board(winner_side=1),
        supersedes_result_id=None,
    )
    assert first.match.status is MatchStatus.completed

    # A completed match is closed to new proposals.
    with pytest.raises(MatchClosedError):
        await propose_result(
            db_session,
            match.id,
            creator.id,
            games=_decisive_board(winner_side=1),
            supersedes_result_id=None,
        )
