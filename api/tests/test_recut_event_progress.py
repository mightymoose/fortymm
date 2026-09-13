"""A replacement draw reconciles after its new fixtures exist."""

from sqlalchemy import text

from app.event_lifecycle import reconcile_event
from app.match_creation import create_match
from app.models import Tournament, TournamentEntry, User
from app.tournament_draw_service import cut_event_draw
from tests.test_match_calls import _make_tournament, _the_fixture


async def test_recut_after_removed_walkover_retains_event_progress(db_session):
    tournament_id, event_id = await _make_tournament(db_session)
    fixture = await _the_fixture(db_session, event_id)
    a = await db_session.get(TournamentEntry, fixture.entry_a_id)
    b = await db_session.get(TournamentEntry, fixture.entry_b_id)
    player = await db_session.get(User, a.user_id)
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
    await db_session.execute(text("DELETE FROM matches WHERE id=:id"), {"id": match.id})
    await reconcile_event(db_session, event_id)
    await db_session.commit()
    tournament = await db_session.get(Tournament, tournament_id)
    owner = await db_session.get(User, tournament.owner_account_id)
    replacement = await cut_event_draw(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=owner,
    )
    assert len(replacement) == 1
    assert str(replacement[0].id) != str(fixture.id)
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "in_progress"
    )
