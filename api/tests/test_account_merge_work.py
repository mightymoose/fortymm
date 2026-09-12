"""Conflicting identity merges read candidate evidence, not global draw history."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.account_merge import merge_user
from app.tournament_draws import uncut_draw
from tests.test_account_merge import (
    _cut,
    _enter,
    _make_ephemeral,
    _make_rr_event,
    _make_verified,
    _mark_played,
)


async def test_conflicting_merge_does_not_scan_unrelated_retained_fixtures(
    db_session: AsyncSession,
    engine: AsyncEngine,
) -> None:
    owner = await _make_verified(db_session, "unrelated-history@example.com")
    history = await _make_rr_event(db_session, owner)
    for i in range(24):
        player = await _make_ephemeral(db_session, f"unrelated-history-{i}")
        await _enter(db_session, history, player)
    await _cut(db_session, history)
    await uncut_draw(db_session, [history.id])
    await db_session.commit()

    guest = await _make_ephemeral(db_session, "work-conflict-guest")
    survivor = await _make_verified(db_session, "work-conflict@example.com")
    event = await _make_rr_event(db_session, survivor)
    await _enter(db_session, event, guest)
    await _enter(db_session, event, survivor)
    (fixture,) = await _cut(db_session, event)
    await _mark_played(db_session, fixture)
    guest_id, survivor_id = guest.id, survivor.id
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
                        with pytest.raises(
                            ValueError, match="recorded play in the same stage"
                        ):
                            await merge_user(
                                probe,
                                from_user_id=guest_id,
                                to_user_id=survivor_id,
                            )
                    after = await probe.scalar(query)
                    assert after - before <= 6
    finally:
        await probe_engine.dispose()
