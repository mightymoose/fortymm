"""Reconciliation follows removed results and older attached play evidence."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.event_lifecycle import reconcile_event
from app.match_creation import create_match
from app.models import MatchStatus, TournamentEntry, User
from tests.test_match_calls import _make_tournament, _the_fixture


@pytest.mark.parametrize("removal", ["detach", "pending", "delete"])
async def test_removing_completed_walkover_requires_reconciliation(
    db_session: AsyncSession, removal: str
) -> None:
    _, event_id = await _make_tournament(db_session)
    fixture = await _the_fixture(db_session, event_id)
    entry_a = await db_session.get(TournamentEntry, fixture.entry_a_id)
    entry_b = await db_session.get(TournamentEntry, fixture.entry_b_id)
    assert entry_a is not None and entry_b is not None
    player = await db_session.get(User, entry_a.user_id)
    assert player is not None
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=entry_b.user_id,
        league_id=None,
        best_of=1,
        rated=False,
    )
    await db_session.execute(
        text(
            "UPDATE matches SET status='completed', ending='walkover', "
            "completed_at=clock_timestamp() WHERE id=:id"
        ),
        {"id": match.id},
    )
    fixture.match_id = match.id
    await reconcile_event(db_session, event_id)
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "finished"
    )
    replacement_id = None
    if removal == "pending":
        replacement = await create_match(
            db_session,
            creator=player,
            opponent_user_id=entry_b.user_id,
            league_id=None,
            best_of=1,
            rated=False,
        )
        replacement.status = MatchStatus.pending
        await db_session.commit()
        replacement_id = replacement.id
    statement = text("UPDATE tournament_fixtures SET match_id=:match WHERE id=:fixture")
    parameters = {"match": replacement_id, "fixture": fixture.id}
    if removal == "delete":
        statement = text("DELETE FROM tournament_fixtures WHERE id=:fixture")
    with pytest.raises(
        IntegrityError, match="attachment requires event reconciliation"
    ):
        async with db_session.begin_nested():
            await reconcile_event(db_session, event_id)
            await db_session.execute(statement, parameters)
            await db_session.execute(
                text(
                    "SET CONSTRAINTS require_attachment_event_reconciliation IMMEDIATE"
                )
            )
    await db_session.execute(statement, parameters)
    await reconcile_event(db_session, event_id)
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "in_progress"
    )


@pytest.mark.parametrize("older_first", [True, False])
async def test_first_play_observation_uses_earliest_attached_score(
    db_session: AsyncSession, older_first: bool
) -> None:
    from sqlalchemy import select

    from app.match_scoring import enter_game_score
    from app.models import TournamentFixture

    _, event_id = await _make_tournament(db_session, entrants=3)
    fixtures = list(
        await db_session.scalars(
            select(TournamentFixture)
            .where(TournamentFixture.scope_event_id == event_id)
            .order_by(TournamentFixture.id)
        )
    )[:2]
    matches = []
    observations = []
    for fixture in fixtures:
        entry_a = await db_session.get(TournamentEntry, fixture.entry_a_id)
        entry_b = await db_session.get(TournamentEntry, fixture.entry_b_id)
        assert entry_a is not None and entry_b is not None
        player = await db_session.get(User, entry_a.user_id)
        assert player is not None
        match = await create_match(
            db_session,
            creator=player,
            opponent_user_id=entry_b.user_id,
            league_id=None,
            best_of=3,
            rated=False,
        )
        await enter_game_score(
            db_session,
            match.id,
            player.id,
            game_number=1,
            side_1_points=11,
            side_2_points=5,
        )
        matches.append(match.id)
        observations.append(
            await db_session.scalar(
                text(
                    "SELECT min(s.created_at) FROM match_games g "
                    "JOIN match_game_scores s "
                    "ON s.match_game_id=g.id WHERE g.match_id=:id"
                ),
                {"id": match.id},
            )
        )
    assert observations[0] < observations[1]
    order = [0, 1] if older_first else [1, 0]
    history_statement = text(
        "SELECT * FROM tournament_event_lifecycle_history "
        "WHERE event_id=:id ORDER BY version"
    )
    history = None
    for index in order:
        await db_session.execute(
            text("UPDATE tournament_fixtures SET match_id=:match WHERE id=:fixture"),
            {"match": matches[index], "fixture": fixtures[index].id},
        )
        await db_session.commit()
        current_history = (
            await db_session.execute(history_statement, {"id": event_id})
        ).all()
        if history is not None:
            assert current_history == history
        history = current_history
    assert (
        await db_session.scalar(
            text("SELECT first_recorded_play_at FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == observations[0]
    )
    # A client cannot use the evidence refinement to rewrite the fact directly.
    with pytest.raises(IntegrityError, match="immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_events SET first_recorded_play_at="
                    "first_recorded_play_at-interval '1 second' WHERE id=:id"
                ),
                {"id": event_id},
            )
    await db_session.execute(
        text(
            "DELETE FROM match_game_scores WHERE match_game_id IN "
            "(SELECT id FROM match_games WHERE match_id=:id)"
        ),
        {"id": matches[0]},
    )
    assert (
        await db_session.scalar(
            text("SELECT first_recorded_play_at FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == observations[0]
    )
