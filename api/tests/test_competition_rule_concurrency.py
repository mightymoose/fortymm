"""A cut captures the rules committed by the editor ahead of it."""

import asyncio

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models import Tournament, TournamentEvent, User
from app.models.tournament_draw_revision import TournamentDrawRevision
from app.tournament_draw_service import cut_event_draw
from tests._helpers import make_user
from tests.test_tournament_draw_service import (
    _enter_field,
    _make_event,
    _make_tournament,
)


async def test_cut_waiting_for_an_edit_captures_its_committed_rules(
    db_session, engine, default_league
):
    owner = await make_user(db_session, "rules-racing-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tournament_id, event_id, owner_id = tournament.id, event.id, owner.id
    await _enter_field(db_session, event, 4, prefix="rules-racing-player")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    started = asyncio.Event()

    async def cut():
        async with sessions() as session:
            actor = await session.get(User, owner_id)
            assert actor is not None
            started.set()
            return await cut_event_draw(
                session,
                tournament_id=tournament_id,
                event_id=event_id,
                actor=actor,
            )

    async with sessions() as editing:
        # This is the settings editor's in-flight transaction: it has acquired
        # the shared parent lock and written rules that it has not committed.
        await editing.execute(
            select(Tournament).where(Tournament.id == tournament_id).with_for_update()
        )
        await editing.execute(
            update(TournamentEvent)
            .where(TournamentEvent.id == event_id)
            .values(match_settings={"rated": False, "length_games": 1})
        )
        cutting = asyncio.create_task(cut())
        try:
            await asyncio.wait_for(started.wait(), timeout=5)
            await asyncio.sleep(0.25)
            assert not cutting.done(), "draw-cut must wait for the in-flight edit"
            await editing.commit()
            assert await asyncio.wait_for(cutting, timeout=10)
        finally:
            if not cutting.done():
                cutting.cancel()
            await asyncio.gather(cutting, return_exceptions=True)

    async with sessions() as reading:
        revision = (
            await reading.scalars(
                select(TournamentDrawRevision).where(
                    TournamentDrawRevision.event_id == event_id,
                    TournamentDrawRevision.retired_at.is_(None),
                )
            )
        ).one()
        assert revision.match_rules["best_of"] == 1
        assert revision.match_rules["affects_rating"] is False
