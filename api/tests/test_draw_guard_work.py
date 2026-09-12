"""Public draw refusals do not scan retained unplayed fixtures."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app import tournament_draw_limits
from app.draws import DrawError
from app.models import League, User
from app.tournament_draw_service import cut_event_draw, uncut_event_draw
from tests._helpers import make_user
from tests.test_tournament_draw_service import (
    _enter_field,
    _make_event,
    _make_tournament,
)


@pytest.mark.parametrize("operation", ["uncut", "rejected_cut"])
async def test_public_draw_guards_do_not_read_retained_unplayed_fixtures(
    db_session: AsyncSession,
    default_league: League,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    owner = await make_user(db_session, "guard-work-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[])
    owner_id, tournament_id, event_id = owner.id, tournament.id, event.id
    await _enter_field(db_session, event, 24, prefix="guard-work")
    await db_session.refresh(owner)
    await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    await uncut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    monkeypatch.setattr(tournament_draw_limits, "MAX_REVISIONS_PER_TOURNAMENT", 1)
    probe_engine = create_async_engine(engine.url, poolclass=NullPool)
    try:
        async with probe_engine.connect() as connection:
            async with connection.begin():
                async with AsyncSession(
                    bind=connection,
                    join_transaction_mode="create_savepoint",
                    expire_on_commit=False,
                ) as probe:
                    query = text(
                        "SELECT seq_tup_read+idx_tup_fetch FROM "
                        "pg_stat_xact_user_tables WHERE relname='tournament_fixtures'"
                    )
                    before = await probe.scalar(query)
                    for _ in range(3):
                        actor = await probe.get(User, owner_id)
                        assert actor is not None
                        if operation == "uncut":
                            await uncut_event_draw(
                                probe,
                                tournament_id=tournament_id,
                                event_id=event_id,
                                actor=actor,
                            )
                        else:
                            with pytest.raises(
                                DrawError, match="Draw storage limit exceeded"
                            ):
                                await cut_event_draw(
                                    probe,
                                    tournament_id=tournament_id,
                                    event_id=event_id,
                                    actor=actor,
                                )
                    after = await probe.scalar(query)
                    assert after - before == 0
    finally:
        await probe_engine.dispose()
