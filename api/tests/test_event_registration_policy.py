"""Event cancellation changes entry permission, not the withdrawal window."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.event_lifecycle import cancel_event
from app.models import League, TournamentStatus
from app.tournament_entries import enter_event, withdraw_from_event
from app.tournament_errors import EntryRefusedError
from tests._helpers import make_user
from tests.test_tournament_lifecycle import _make_tournament_at, _one_event


async def test_cancelled_published_event_allows_withdrawal_but_refuses_reentry(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "cancel-withdraw-owner")
    entrant = await make_user(db_session, "cancel-withdraw-entrant")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    entry = await enter_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=entrant,
        user_id=None,
    )
    await cancel_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=owner,
    )
    await db_session.commit()

    for _ in range(2):
        await withdraw_from_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event.id,
            entry_id=entry.id,
            actor=entrant,
        )
    with pytest.raises(EntryRefusedError, match="cancelled"):
        await enter_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event.id,
            actor=entrant,
            user_id=None,
        )
