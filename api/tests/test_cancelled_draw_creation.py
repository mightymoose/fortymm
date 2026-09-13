"""Cancellation freezes new draw topology as well as retained fixtures."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.event_lifecycle import cancel_event
from app.models import Tournament, User
from app.tournament_draw_service import cut_event_draw
from app.tournament_errors import DrawUnderWayError
from tests.test_match_calls import _make_tournament, _the_fixture


async def test_cancelled_event_rejects_new_fixture(db_session):
    tournament_id, event_id = await _make_tournament(db_session)
    fixture = await _the_fixture(db_session, event_id)
    tournament = await db_session.get(Tournament, tournament_id)
    owner = await db_session.get(User, tournament.owner_account_id)
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    await db_session.commit()
    with pytest.raises(IntegrityError, match="cancelled events cannot accept fixtures"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO tournament_fixtures "
                    "(stage_id,group_id,round,position,draw_revision_id) "
                    "SELECT stage_id,group_id,round,position+100,draw_revision_id "
                    "FROM tournament_fixtures WHERE id=:id"
                ),
                {"id": fixture.id},
            )


async def test_cancelled_event_refuses_draw_creation_before_writing(db_session):
    tournament_id, event_id = await _make_tournament(db_session)
    tournament = await db_session.get(Tournament, tournament_id)
    owner = await db_session.get(User, tournament.owner_account_id)
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    await db_session.commit()
    with pytest.raises(DrawUnderWayError, match="cancelled"):
        await cut_event_draw(
            db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
        )
