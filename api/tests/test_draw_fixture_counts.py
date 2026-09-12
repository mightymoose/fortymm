"""Revision counters track fixture storage without trusting caller-supplied totals."""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import League
from app.tournament_draw_service import cut_event_draw
from tests._helpers import make_user
from tests.test_draw_history_integrity import _uncut
from tests.test_draw_history_integrity import drawn_history as drawn_history
from tests.test_tournament_draw_service import (
    _enter_field,
    _make_event,
    _make_tournament,
)


async def _counts(db: AsyncSession) -> dict[uuid.UUID, int]:
    rows = (
        await db.execute(
            text(
                "SELECT r.id,r.retained_fixture_count,count(f.id) AS actual "
                "FROM tournament_draw_revisions r LEFT JOIN tournament_fixtures f "
                "ON f.draw_revision_id=r.id GROUP BY r.id"
            )
        )
    ).all()
    assert all(row.retained_fixture_count == row.actual for row in rows)
    return {row.id: row.retained_fixture_count for row in rows}


@pytest.mark.parametrize("retired", [False, True])
async def test_revision_counter_rejects_direct_rewrites(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID], retired: bool
) -> None:
    assert (await _counts(db_session))[drawn_history["revision_id"]] == 6
    if retired:
        await _uncut(db_session, drawn_history)
    with pytest.raises(IntegrityError, match="count is maintained by fixture writes"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_draw_revisions SET retained_fixture_count=0 "
                    "WHERE id=:id"
                ),
                {"id": drawn_history["revision_id"]},
            )
    assert (await _counts(db_session))[drawn_history["revision_id"]] == 6


async def test_revision_counter_cannot_start_with_a_fabricated_total(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    await _uncut(db_session, drawn_history)
    with pytest.raises(IntegrityError, match="count is maintained by fixture writes"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO tournament_draw_revisions "
                    "(event_id,retained_fixture_count) "
                    "VALUES (:event,20)"
                ),
                {"event": drawn_history["event_id"]},
            )


async def test_current_fixture_deletion_releases_exact_storage(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    await db_session.execute(
        text("DELETE FROM tournament_fixtures WHERE id=:id"),
        {"id": drawn_history["fixture_id"]},
    )
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    assert (await _counts(db_session))[drawn_history["revision_id"]] == 5


async def test_fixture_counter_changes_rollback_with_the_fixture(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    with pytest.raises(RuntimeError, match="abort fixture batch"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("DELETE FROM tournament_fixtures WHERE id=:id"),
                {"id": drawn_history["fixture_id"]},
            )
            assert (await _counts(db_session))[drawn_history["revision_id"]] == 5
            raise RuntimeError("abort fixture batch")
    assert (await _counts(db_session))[drawn_history["revision_id"]] == 6


@pytest.mark.parametrize(
    "parent_table,id_key",
    [("tournament_events", "event_id"), ("tournaments", "tournament_id")],
)
async def test_parent_cascade_removes_retired_revision_storage(
    db_session: AsyncSession,
    drawn_history: dict[str, uuid.UUID],
    parent_table: str,
    id_key: str,
) -> None:
    await _uncut(db_session, drawn_history)
    assert (await _counts(db_session))[drawn_history["revision_id"]] == 6
    await db_session.execute(
        text(f"DELETE FROM {parent_table} WHERE id=:id"),
        {"id": drawn_history[id_key]},
    )
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    assert await _counts(db_session) == {}


async def test_fixture_move_transfers_storage_between_revisions(
    db_session: AsyncSession,
    default_league: League,
    drawn_history: dict[str, uuid.UUID],
) -> None:
    owner = await make_user(db_session, "counter-move-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[])
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 2, prefix="counter-move-player")
    await db_session.refresh(owner)
    other = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    other_revision = await db_session.scalar(
        text("SELECT draw_revision_id FROM tournament_fixtures WHERE id=:id"),
        {"id": other[0].id},
    )
    await db_session.execute(
        text(
            "UPDATE tournament_fixtures SET (stage_id,group_id,draw_revision_id)="
            "(SELECT stage_id,group_id,draw_revision_id FROM tournament_fixtures "
            "WHERE id=:other),entry_a_id=NULL,entry_b_id=NULL,round=100 WHERE id=:first"
        ),
        {"other": other[0].id, "first": drawn_history["fixture_id"]},
    )
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    counts = await _counts(db_session)
    assert counts[drawn_history["revision_id"]] == 5
    assert counts[other_revision] == 2


async def test_fixture_truncate_resets_surviving_revision_counter(
    db_session: AsyncSession, drawn_history: dict[str, uuid.UUID]
) -> None:
    await db_session.execute(text("TRUNCATE tournament_fixtures CASCADE"))
    assert (await _counts(db_session))[drawn_history["revision_id"]] == 0
