"""Registration priority survives identity reconciliation but not later reentry."""

from sqlalchemy.ext.asyncio import AsyncSession

from app.account_merge import merge_user
from app.draws import order_entrants
from app.tournament_draws import active_draw_entrants
from app.tournament_entries import enter_event, withdraw_from_event
from tests.test_account_merge import _make_ephemeral, _make_verified
from tests.test_tournament_entries import _make_event


async def test_merge_retains_earlier_current_registration_priority(
    db_session: AsyncSession,
) -> None:
    guest = await _make_ephemeral(db_session, "priority-guest")
    opponent = await _make_verified(db_session, "priority-other@example.com")
    survivor = await _make_verified(db_session, "priority-survivor@example.com")
    event = await _make_event(db_session)
    tournament_id, event_id = event.tournament_id, event.id
    guest_id, survivor_id = guest.id, survivor.id
    await enter_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=guest,
        user_id=None,
    )
    await db_session.refresh(opponent)
    other_entry = await enter_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=opponent,
        user_id=None,
    )
    await db_session.refresh(survivor)
    surviving_entry = await enter_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=survivor,
        user_id=None,
    )
    await merge_user(db_session, from_user_id=guest_id, to_user_id=survivor_id)
    await db_session.commit()
    ordered = order_entrants(await active_draw_entrants(db_session, event_id))
    assert [entrant.entry_id for entrant in ordered] == [
        surviving_entry.id,
        other_entry.id,
    ]
    await db_session.refresh(survivor)
    await withdraw_from_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        entry_id=surviving_entry.id,
        actor=survivor,
    )
    await db_session.refresh(survivor)
    returned = await enter_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=survivor,
        user_id=None,
    )
    assert returned.id == surviving_entry.id
    ordered = order_entrants(await active_draw_entrants(db_session, event_id))
    assert [entrant.entry_id for entrant in ordered] == [
        other_entry.id,
        surviving_entry.id,
    ]
