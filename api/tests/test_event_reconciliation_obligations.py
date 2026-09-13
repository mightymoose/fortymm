"""Topology changes cannot erase a captured event reconciliation obligation."""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.event_lifecycle import reconcile_event
from app.match_creation import create_match
from app.models import Tournament, TournamentEntry, User
from tests.test_match_calls import _make_tournament, _the_fixture


@pytest.mark.parametrize("reconcile_before_detach", [False, True])
async def test_void_then_detach_still_requires_captured_event_reconciliation(
    db_session: AsyncSession, reconcile_before_detach: bool
) -> None:
    tournament_id, event_id = await _make_tournament(db_session)
    tournament = await db_session.get(Tournament, tournament_id)
    fixture = await _the_fixture(db_session, event_id)
    a = await db_session.get(TournamentEntry, fixture.entry_a_id)
    b = await db_session.get(TournamentEntry, fixture.entry_b_id)
    assert tournament is not None and a is not None and b is not None
    player = await db_session.get(User, a.user_id)
    assert player is not None
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=b.user_id,
        league_id=None,
        best_of=3,
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

    async def void_and_detach() -> None:
        await db_session.execute(
            text(
                "INSERT INTO match_void_actions "
                "(id,match_id,actor_account_id,reason,tournament_id,owner_revision) "
                "VALUES (:id,:match,:actor,'Void',:tournament,0)"
            ),
            {
                "id": uuid.uuid4(),
                "match": match.id,
                "actor": tournament.owner_account_id,
                "tournament": tournament_id,
            },
        )
        if reconcile_before_detach:
            await reconcile_event(db_session, event_id)
        await db_session.execute(
            text("UPDATE tournament_fixtures SET match_id=NULL WHERE id=:id"),
            {"id": fixture.id},
        )

    with pytest.raises(IntegrityError, match="requires event reconciliation"):
        async with db_session.begin_nested():
            await void_and_detach()
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await void_and_detach()
    await reconcile_event(db_session, event_id)
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "in_progress"
    )


async def test_cancellation_updates_same_transaction_reconciliation_snapshot(
    db_session: AsyncSession,
) -> None:
    from app.event_lifecycle import cancel_event
    from app.match_scoring import enter_game_score
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="cancel-after-reconcile", best_of=3, rated=False
    )
    await enter_game_score(
        db_session,
        match.id,
        director.id,
        game_number=1,
        side_1_points=11,
        side_2_points=5,
    )
    scope = (
        await db_session.execute(
            text(
                "SELECT scope_tournament_id,scope_event_id FROM tournament_fixtures "
                "WHERE match_id=:id"
            ),
            {"id": match.id},
        )
    ).one()
    await reconcile_event(db_session, scope.scope_event_id)
    await cancel_event(
        db_session,
        tournament_id=scope.scope_tournament_id,
        event_id=scope.scope_event_id,
        actor=director,
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": scope.scope_event_id},
        )
        == "cancelled"
    )


@pytest.mark.parametrize("to_completed", [True, False])
async def test_terminal_match_status_change_requires_reconciliation(
    db_session: AsyncSession, to_completed: bool
) -> None:
    _, event_id = await _make_tournament(db_session)
    fixture = await _the_fixture(db_session, event_id)
    a = await db_session.get(TournamentEntry, fixture.entry_a_id)
    b = await db_session.get(TournamentEntry, fixture.entry_b_id)
    assert a is not None and b is not None
    player = await db_session.get(User, a.user_id)
    assert player is not None
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=b.user_id,
        league_id=None,
        best_of=3,
        rated=False,
    )
    await db_session.execute(
        text("UPDATE matches SET status='pending' WHERE id=:id"), {"id": match.id}
    )
    fixture.match_id = match.id
    await db_session.commit()
    if not to_completed:
        await db_session.execute(
            text("UPDATE matches SET status='voided' WHERE id=:id"), {"id": match.id}
        )
        await reconcile_event(db_session, event_id)
        await db_session.commit()
    statement = text(
        "UPDATE matches SET status='completed', ending='walkover', "
        "completed_at=clock_timestamp() WHERE id=:id"
        if to_completed
        else "UPDATE matches SET status='pending', ending=NULL, "
        "completed_at=NULL WHERE id=:id"
    )
    with pytest.raises(IntegrityError, match="requires event reconciliation"):
        async with db_session.begin_nested():
            await db_session.execute(statement, {"id": match.id})
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await db_session.execute(statement, {"id": match.id})
    await reconcile_event(db_session, event_id)
    await db_session.commit()
    assert await db_session.scalar(
        text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
        {"id": event_id},
    ) == ("finished" if to_completed else "in_progress")
