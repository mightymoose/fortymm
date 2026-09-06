"""Unit tests for the transport-neutral result-proposal service
(``app.result_proposal.propose_result``) — the first verb of the propose/accept
negotiation, covering both a first proposal and a counter. Constructed directly
with a ``db_session`` (no FastAPI, no HTTP client): the HTTP wire contract is
covered by ``test_matches.py``; here we prove the service self-accepts +
finalizes solo/unrated matches, leaves a rated two-human match standing, honours
the counter chain, and raises the domain exceptions (never ``HTTPException``)
the adapters map."""

import asyncio

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.match_creation import create_match
from app.models import MatchStatus
from app.result_acceptance import (
    MatchClosedError,
    NegotiationConflictError,
    UndecidedBoardError,
    accept_result,
)
from app.result_chain import accepted_result, head_result, standing_result
from app.result_proposal import propose_result
from app.schemas.match import MatchResultsGameWrite
from tests._helpers import directed_tournament_match, make_user


def _decisive_board(winner_side: int = 1) -> list[MatchResultsGameWrite]:
    """A single decided game for a best-of-1 board (``winner_side`` takes it)."""
    if winner_side == 1:
        return [MatchResultsGameWrite(game_number=1, side_1_points=11, side_2_points=4)]
    return [MatchResultsGameWrite(game_number=1, side_1_points=4, side_2_points=11)]


@pytest.mark.parametrize("parent", ["tournaments", "tournament_events"])
@pytest.mark.parametrize("operation", ["acceptance", "proposal"])
async def test_tournament_result_write_waits_for_parent_writer(
    db_session, engine, parent, operation
):
    match, director = await directed_tournament_match(
        db_session, tag="accept-parent-lock", best_of=1
    )
    sides = sorted(match.sides, key=lambda side: side.side_number)
    proposal = None
    if operation == "acceptance":
        outcome = await propose_result(
            db_session,
            match.id,
            sides[0].players[0].user_id,
            games=_decisive_board(),
            supersedes_result_id=None,
        )
        proposal = standing_result(outcome.match)
        assert proposal is not None
    event = (
        await db_session.execute(
            text(
                "SELECT e.id, e.tournament_id FROM tournament_events e "
                "JOIN tournament_event_stages s ON s.event_id = e.id "
                "JOIN tournament_fixtures f ON f.stage_id = s.id "
                "WHERE f.match_id = :match"
            ),
            {"match": match.id},
        )
    ).one()
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as scheduling, sessions() as accepting:
        scheduler_pid = await scheduling.scalar(text("SELECT pg_backend_pid()"))
        accept_pid = await accepting.scalar(text("SELECT pg_backend_pid()"))
        await scheduling.execute(
            text(f"SELECT id FROM {parent} WHERE id = :id FOR UPDATE"),
            {"id": event.tournament_id if parent == "tournaments" else event.id},
        )
        task = asyncio.create_task(
            accept_result(
                accepting, match.id, sides[1].players[0].user_id, result_id=proposal.id
            )
            if proposal is not None
            else propose_result(
                accepting,
                match.id,
                sides[0].players[0].user_id,
                games=_decisive_board(),
                supersedes_result_id=None,
            )
        )
        try:

            async def wait_for_parent():
                while scheduler_pid not in await db_session.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": accept_pid}
                ):
                    if task.done():
                        await task
                        pytest.fail("acceptance bypassed the parent lock")
                    await asyncio.sleep(0.01)

            await asyncio.wait_for(wait_for_parent(), timeout=5)
        finally:
            await scheduling.rollback()
            if not task.done():
                await asyncio.wait_for(task, timeout=5)
        result = await task
        if operation == "acceptance":
            assert result.status is MatchStatus.completed
        else:
            assert result.awaiting_acceptance is True


async def test_tournament_proposal_still_refuses_an_active_match_writer(
    db_session, engine
):
    from app.match_scoring import MatchLockUnavailable, load_match_for_write

    match, director = await directed_tournament_match(
        db_session, tag="proposal-busy-match", best_of=1
    )
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as first, sessions() as second:
        await load_match_for_write(first, match.id, director.id, lock=True)
        with pytest.raises(MatchLockUnavailable):
            await asyncio.wait_for(
                propose_result(
                    second,
                    match.id,
                    director.id,
                    games=_decisive_board(),
                    supersedes_result_id=None,
                ),
                timeout=1,
            )
        await first.rollback()


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


# ----- director authorization (#1523) ---------------------------------------
#
# The load-bearing invariant: a director-submitted result is NEVER left
# standing (``awaiting_acceptance`` is always False), first proposal or
# supersede alike — see ``_requires_confirmation``'s submitter-is-a-participant
# conjunct.


async def test_director_first_proposal_on_rated_match_self_finalizes(
    db_session: AsyncSession,
) -> None:
    match, director = await directed_tournament_match(
        db_session, tag="dir-propose", best_of=1
    )

    outcome = await propose_result(
        db_session,
        match.id,
        director.id,
        games=_decisive_board(winner_side=1),
        supersedes_result_id=None,
    )

    # A director's result is authoritative — it is never left standing,
    # regardless of the match being rated with two registered players.
    assert outcome.awaiting_acceptance is False
    assert outcome.match.status is MatchStatus.completed
    sides = sorted(outcome.match.sides, key=lambda s: s.side_number)
    assert sides[0].won is True
    assert sides[1].won is False
    posted = outcome.match.results[0]
    assert posted.submitted_for_player_id is None
    assert posted.submitted_by_user_id == director.id
    assert posted.accepted_by_user_id == director.id


async def test_director_supersedes_a_players_standing_proposal_and_self_finalizes(
    db_session: AsyncSession,
) -> None:
    """AC: 'The director can supersede a result a player proposed... that
    counter also finalizes the match at once.'"""
    match, director = await directed_tournament_match(
        db_session, tag="dir-supersede", best_of=1
    )
    sides = sorted(match.sides, key=lambda s: s.side_number)
    p1_id = sides[0].players[0].user_id

    # A player proposes first — a rated two-human match, so it stays standing.
    first = await propose_result(
        db_session,
        match.id,
        p1_id,
        games=_decisive_board(winner_side=1),
        supersedes_result_id=None,
    )
    assert first.awaiting_acceptance is True
    standing = standing_result(first.match)
    assert standing is not None

    # The director supersedes it with a counter — still finalizes at once,
    # never left standing for anyone to accept.
    countered = await propose_result(
        db_session,
        match.id,
        director.id,
        games=_decisive_board(winner_side=2),
        supersedes_result_id=standing.id,
    )

    assert countered.awaiting_acceptance is False
    assert countered.match.status is MatchStatus.completed
    completed_sides = sorted(countered.match.sides, key=lambda s: s.side_number)
    assert completed_sides[0].won is False
    assert completed_sides[1].won is True
    # The director's counter is the new head, and it's accepted (not standing)
    # — self-finalized at once, never left for anyone to accept.
    assert standing_result(countered.match) is None
    new_head = head_result(countered.match)
    assert new_head is not None
    assert new_head.submitted_by_user_id == director.id
    assert new_head.accepted_by_user_id == director.id


async def test_director_first_proposal_on_unrated_match_self_finalizes_as_before(
    db_session: AsyncSession,
) -> None:
    """Edge case: an unrated match already self-finalizes for a participant's
    own proposal (``_requires_confirmation`` is already False). The director
    path must reach the same end state, not a second one."""
    match, director = await directed_tournament_match(
        db_session, tag="dir-unrated", best_of=1, rated=False
    )

    outcome = await propose_result(
        db_session,
        match.id,
        director.id,
        games=_decisive_board(winner_side=1),
        supersedes_result_id=None,
    )

    assert outcome.awaiting_acceptance is False
    assert outcome.match.status is MatchStatus.completed


async def test_participant_who_is_also_director_follows_the_participant_round_trip(
    db_session: AsyncSession,
) -> None:
    """Constraint 9: director authority never applies to a match the director
    plays in. A director who is also a participant in THIS match follows the
    unchanged participant flow, including leaving a rated proposal standing
    for the opponent to accept."""
    match, director = await directed_tournament_match(
        db_session, tag="dir-plays", best_of=1, director_is_participant=True
    )
    assert any(
        p.user_id == director.id for side in match.sides for p in side.players
    ), "the director must actually be seated on a side for this test to be meaningful"

    outcome = await propose_result(
        db_session,
        match.id,
        director.id,
        games=_decisive_board(winner_side=1),
        supersedes_result_id=None,
    )

    # Ordinary participant behavior: a rated two-human match leaves the
    # director-as-proposer's own result standing for the opponent, exactly as
    # it would for any other participant.
    assert outcome.awaiting_acceptance is True
    assert outcome.match.status is MatchStatus.in_progress
    standing = standing_result(outcome.match)
    assert standing is not None
    assert standing.submitted_by_user_id == director.id
    assert standing.accepted_by_user_id is None


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
