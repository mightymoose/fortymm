"""Draw currency follows current seats after explicit SQL group moves."""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.tournament_draws import DrawCurrency, draw_currency_by_event
from tests.test_draw_history_integrity import drawn_history as drawn_history


@pytest.mark.parametrize("move_all", [False, True])
async def test_group_move_is_current_only_after_all_old_seats_are_replaced(
    db_session: AsyncSession,
    drawn_history: dict[str, uuid.UUID],
    move_all: bool,
) -> None:
    group_id = await db_session.scalar(
        text(
            "INSERT INTO tournament_event_stage_groups(stage_id,position) "
            "SELECT stage_id,1 FROM tournament_fixtures WHERE id=:id RETURNING id"
        ),
        {"id": drawn_history["fixture_id"]},
    )
    where = "scope_event_id=:event_id" if move_all else "id=:fixture_id"
    await db_session.execute(
        text(f"UPDATE tournament_fixtures SET group_id=:group_id WHERE {where}"),
        {**drawn_history, "group_id": group_id},
    )
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await db_session.commit()

    currency = await draw_currency_by_event(db_session, [drawn_history["event_id"]])

    assert currency[drawn_history["event_id"]] is (
        DrawCurrency.current if move_all else DrawCurrency.stale
    )
