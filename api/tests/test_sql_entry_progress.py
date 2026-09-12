"""Registration changes keep the Swiss result projection and progress aligned."""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.event_lifecycle import reconcile_event
from app.match_creation import create_match
from app.models import TournamentStatus, User
from tests.test_swiss import _cut, _field, _fixtures, _set_status
from tests.test_swiss import authed_client as authed_client


@pytest.mark.parametrize("reenter", [False, True])
async def test_sql_active_entry_change_requires_reconciliation(
    authed_client, db_session, reenter
):
    client, owner = authed_client
    tournament_id, event_id, entries = await _field(client, db_session, 4, rounds=1)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    played, unpaired = await _fixtures(db_session, event_id)
    player_by_entry = {entry.id: entry.user_id for entry in entries}
    player = await db_session.get(User, player_by_entry[played.entry_a_id])
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=player_by_entry[played.entry_b_id],
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
    unpaired.entry_a_id = None
    unpaired.entry_b_id = None
    played.match_id = match.id
    await reconcile_event(db_session, uuid.UUID(event_id))
    await db_session.commit()
    await _set_status(db_session, tournament_id, TournamentStatus.published)
    state = text("SELECT lifecycle_state FROM tournament_events WHERE id=:id")
    assert await db_session.scalar(state, {"id": uuid.UUID(event_id)}) == "unstarted"
    departing = next(
        entry
        for entry in entries
        if entry.id not in (played.entry_a_id, played.entry_b_id)
    )
    from app.tournament_participation import WithdrawalReason, close_registration

    await close_registration(
        db_session, departing.id, owner.id, WithdrawalReason.director_removal
    )
    if reenter:
        await db_session.execute(
            text("UPDATE tournament_entries SET status='withdrawn' WHERE id=:id"),
            {"id": departing.id},
        )
        await reconcile_event(db_session, uuid.UUID(event_id))
        await db_session.commit()
    change = text("UPDATE tournament_entries SET status=:status WHERE id=:id")
    params = {"id": departing.id, "status": "entered" if reenter else "withdrawn"}
    with pytest.raises(IntegrityError, match="requires event reconciliation"):
        async with db_session.begin_nested():
            await reconcile_event(db_session, uuid.UUID(event_id))
            await db_session.execute(change, params)
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await db_session.execute(change, params)
    await reconcile_event(db_session, uuid.UUID(event_id))
    await db_session.commit()
    assert await db_session.scalar(state, {"id": uuid.UUID(event_id)}) == (
        "in_progress" if reenter else "finished"
    )
