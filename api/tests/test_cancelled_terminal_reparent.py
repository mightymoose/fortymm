"""Cancellation protects new terminal results through every attachment path."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.event_lifecycle import cancel_event, reconcile_event
from app.match_creation import create_match
from app.models import Tournament, TournamentEntry, User
from tests.test_match_calls import _make_tournament, _the_fixture


async def test_cancelled_event_rejects_terminal_fixture_reparenting(db_session):
    _, source_event = await _make_tournament(db_session)
    target_tournament, target_event = await _make_tournament(db_session)
    source = await _the_fixture(db_session, source_event)
    target = await _the_fixture(db_session, target_event)
    a = await db_session.get(TournamentEntry, source.entry_a_id)
    b = await db_session.get(TournamentEntry, source.entry_b_id)
    player = await db_session.get(User, a.user_id)
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=b.user_id,
        league_id=None,
        best_of=1,
        rated=False,
    )
    await db_session.execute(
        text(
            "UPDATE matches SET status='completed', "
            "ending='walkover', completed_at=clock_timestamp() WHERE id=:id"
        ),
        {"id": match.id},
    )
    source.match_id = match.id
    await reconcile_event(db_session, source_event)
    await db_session.commit()
    tournament = await db_session.get(Tournament, target_tournament)
    owner = await db_session.get(User, tournament.owner_account_id)
    await cancel_event(
        db_session, tournament_id=target_tournament, event_id=target_event, actor=owner
    )
    await db_session.commit()
    values = {
        name: getattr(target, name)
        for name in (
            "stage_id",
            "scope_event_id",
            "scope_tournament_id",
            "group_id",
            "entry_a_id",
            "entry_b_id",
            "participation_a_id",
            "participation_b_id",
            "draw_revision_id",
        )
    }
    with pytest.raises(IntegrityError, match="cancelled events cannot attach"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("DELETE FROM tournament_fixtures WHERE id=:id"), {"id": target.id}
            )
            values["id"] = source.id
            await db_session.execute(
                text(
                    "UPDATE tournament_fixtures SET "
                    + ", ".join(f"{key}=:{key}" for key in values if key != "id")
                    + " WHERE id=:id"
                ),
                values,
            )
            await reconcile_event(db_session, source_event)
            await reconcile_event(db_session, target_event)
            await db_session.commit()
