"""Registration changes keep the Swiss result projection and progress aligned."""

import uuid

from sqlalchemy import text

from app.event_lifecycle import reconcile_event
from app.match_creation import create_match
from app.models import TournamentStatus, User
from app.tournament_entries import enter_event, withdraw_from_event
from tests.test_swiss import _cut, _field, _fixtures, _set_status
from tests.test_swiss import authed_client as authed_client


async def test_withdrawal_reconciles_swiss_with_historical_result(
    authed_client, db_session
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
    await withdraw_from_event(
        db_session,
        tournament_id=uuid.UUID(tournament_id),
        event_id=uuid.UUID(event_id),
        entry_id=departing.id,
        actor=owner,
    )
    assert await db_session.scalar(state, {"id": uuid.UUID(event_id)}) == "finished"
    receipts = text(
        "SELECT count(*) FROM tournament_event_reconciliations WHERE event_id=:id"
    )
    before = await db_session.scalar(receipts, {"id": uuid.UUID(event_id)})
    for _ in range(2):
        await withdraw_from_event(
            db_session,
            tournament_id=uuid.UUID(tournament_id),
            event_id=uuid.UUID(event_id),
            entry_id=departing.id,
            actor=owner,
        )
    assert await db_session.scalar(receipts, {"id": uuid.UUID(event_id)}) == before
    await enter_event(
        db_session,
        tournament_id=uuid.UUID(tournament_id),
        event_id=uuid.UUID(event_id),
        actor=owner,
        user_id=departing.user_id,
    )
    assert await db_session.scalar(state, {"id": uuid.UUID(event_id)}) == "in_progress"
