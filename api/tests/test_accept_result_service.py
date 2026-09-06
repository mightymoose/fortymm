"""Unit tests for the transport-neutral result-acceptance service
(``app.result_acceptance.accept_result``) — the second verb of the propose/accept
negotiation. Constructed directly with a ``db_session`` (no FastAPI, no HTTP
client): the HTTP wire contract is covered by ``test_matches.py``; here we prove
the service finalizes on the opposing side's acceptance (completing the match,
stamping ``side.won``, applying the rating), and raises the domain exceptions
(never ``HTTPException``) the adapters map — the submitter-side self-accept guard,
the unknown-``result_id`` 404 gate, and the moved-on negotiation conflict."""

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.match_creation import create_match
from app.models import MatchResult, MatchStatus, RatingHistory
from app.result_acceptance import (
    CannotAcceptOwnProposalError,
    NegotiationConflictError,
    ResultNotFoundError,
    accept_result,
)
from app.result_chain import standing_result
from app.result_proposal import propose_result
from app.schemas.match import MatchResultsGameWrite
from tests._helpers import attach_match_to_director_tournament, make_user


def _decisive_board(winner_side: int = 1) -> list[MatchResultsGameWrite]:
    """A single decided game for a best-of-1 board (``winner_side`` takes it)."""
    if winner_side == 1:
        return [MatchResultsGameWrite(game_number=1, side_1_points=11, side_2_points=4)]
    return [MatchResultsGameWrite(game_number=1, side_1_points=4, side_2_points=11)]


async def _propose_standing(
    db_session: AsyncSession, *, creator_name: str, opponent_name: str
) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """Create a rated two-human best-of-1 match and post a first proposal by the
    creator, leaving it standing. Returns ``(match_id, standing_result_id,
    opponent_id)``."""
    creator = await make_user(db_session, creator_name)
    opponent = await make_user(db_session, opponent_name)
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
    standing = standing_result(outcome.match)
    assert standing is not None
    return match.id, standing.id, opponent.id


async def test_opposing_side_accept_completes_and_applies_rating(
    db_session: AsyncSession,
) -> None:
    match_id, result_id, opponent_id = await _propose_standing(
        db_session, creator_name="accept-svc-proposer", opponent_name="accept-svc-opp"
    )

    reloaded = await accept_result(
        db_session,
        match_id,
        opponent_id,
        result_id=result_id,
    )

    # The match completes and the agreed board stamps the W/L (creator's side 1
    # won on the 11-4 board).
    assert reloaded.status is MatchStatus.completed
    sides = sorted(reloaded.sides, key=lambda s: s.side_number)
    assert sides[0].won is True
    assert sides[1].won is False
    # The accepted head records the acceptor.
    standing = standing_result(reloaded)
    assert standing is None  # accepted, no longer "standing"

    # The rating update ran: one glicko2 rating_history row per side.
    history = (
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.match_id == match_id)
            )
        )
        .scalars()
        .all()
    )
    assert len(history) == 2


async def test_submitter_side_self_accept_raises_cannot_accept_own(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "self-accept-proposer")
    opponent = await make_user(db_session, "self-accept-opp")
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
    standing = standing_result(outcome.match)
    assert standing is not None

    # The proposer accepting their own standing proposal is the self-accept guard.
    with pytest.raises(CannotAcceptOwnProposalError):
        await accept_result(
            db_session,
            match.id,
            creator.id,
            result_id=standing.id,
        )


async def test_a_bystander_submitter_cannot_accept_their_own_standing_proposal(
    db_session: AsyncSession,
) -> None:
    """The self-accept guard holds for a submitter who is on NEITHER side.

    Since #1523 the write gate admits a tournament director, who is not a
    participant, so ``my_side`` returns ``None`` for a director-submitted
    proposal and the submitter-SIDE check alone does nothing. The guard
    therefore also compares the submitter's identity.

    ``_requires_confirmation`` (``app.result_proposal``) is what stops such a
    proposal ever standing, so this state cannot arise through
    ``propose_result``. The test inserts it with the director as its original
    submitter because the guard must hold when that upstream invariant does not.
    """
    creator = await make_user(db_session, "bystander-accept-proposer")
    opponent = await make_user(db_session, "bystander-accept-opp")
    director = await make_user(db_session, "bystander-accept-director")
    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=1,
        rated=True,
    )
    match_id, director_id = match.id, director.id
    # Wire the match to a tournament this director created, so they clear
    # ``load_match_for_write`` and actually reach the guard under test.
    await attach_match_to_director_tournament(
        db_session,
        match_id,
        tag="bystander-accept",
        director=director,
        p1=creator,
        p2=opponent,
    )
    result_id = uuid.uuid4()
    match.status = MatchStatus.in_progress
    db_session.add(
        MatchResult(
            id=result_id,
            match=match,
            submitted_by_user_id=director_id,
            games=[game.model_dump() for game in _decisive_board(winner_side=1)],
        )
    )
    await db_session.commit()

    with pytest.raises(CannotAcceptOwnProposalError):
        await accept_result(
            db_session,
            match_id,
            director_id,
            result_id=result_id,
        )


async def test_unknown_result_id_raises_result_not_found(
    db_session: AsyncSession,
) -> None:
    match_id, _result_id, opponent_id = await _propose_standing(
        db_session, creator_name="unknown-proposer", opponent_name="unknown-opp"
    )

    # A ``result_id`` that isn't a result on the match at all is the 404 gate.
    with pytest.raises(ResultNotFoundError):
        await accept_result(
            db_session,
            match_id,
            opponent_id,
            result_id=uuid.uuid4(),
        )


async def test_superseded_result_id_raises_negotiation_conflict(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "superseded-proposer")
    opponent = await make_user(db_session, "superseded-opp")
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

    # A counter moves the standing head off ``first_result`` — it's still a result
    # on the match (so it passes the 404 gate) but no longer the live proposal.
    await propose_result(
        db_session,
        match.id,
        opponent.id,
        games=_decisive_board(winner_side=2),
        supersedes_result_id=first_result.id,
    )

    # Accepting the now-superseded id is the moved-on negotiation conflict; the
    # error carries the loaded match so an adapter can rebuild the snapshot.
    with pytest.raises(NegotiationConflictError) as excinfo:
        await accept_result(
            db_session,
            match.id,
            creator.id,
            result_id=first_result.id,
        )
    assert excinfo.value.match.id == match.id
