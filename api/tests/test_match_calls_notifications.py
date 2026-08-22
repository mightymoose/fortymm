"""The "Match calls" notification category (ADR 2026-07-16 — the schedule is
solved; the call is pinned): the seeded category row, its prefs-matrix cells,
and the three typed message-kind builders (called / moved / cancelled)."""

import importlib.util
import uuid
from datetime import UTC, datetime
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import NotificationType
from app.notifications.match_calls import (
    MATCH_CALLS_CATEGORY,
    MatchCallCancellationReason,
    MatchCallContext,
    MatchCallKind,
    match_call_cancelled_message,
    match_call_moved_message,
    match_called_message,
)
from app.notifications.taxonomy import NotificationCategory
from tests._helpers import start_session

_CONTEXT = MatchCallContext(
    tournament_name="Spring Open",
    event_name="Men's Singles",
    group_label="Group B",
)


# ----- the seeded category ---------------------------------------------------


async def test_match_calls_category_row_is_seeded(db_session: AsyncSession):
    row = (
        await db_session.execute(
            select(NotificationType).where(NotificationType.key == "match_calls")
        )
    ).scalar_one()
    assert row.name == "Match calls"
    assert row.short_label == "Calls"
    assert row.is_active is True
    assert row.display_order == 6


async def test_match_calls_category_is_in_the_enum():
    assert NotificationCategory("match_calls") is NotificationCategory.MATCH_CALLS
    assert MATCH_CALLS_CATEGORY is NotificationCategory.MATCH_CALLS


async def test_migration_seed_matches_the_conftest_labels():
    """Migration 0009 can't import app code, so its hardcoded seed row is
    loaded here by path and pinned to the enum + labels the tests seed — the
    same drift guard the taxonomy docstring describes for the other categories.
    (The row was seeded by a standalone 0015 until that migration was folded
    back into 0009, which creates and seeds ``notification_types``.)"""
    path = (
        Path(__file__).parent.parent
        / "migrations"
        / "versions"
        / "20260607_0001_0009_create_notification_tables.py"
    )
    spec = importlib.util.spec_from_file_location("migration_0009", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    # display_order is the 1-based position in the seed list (see the migration's
    # ``enumerate(..., start=1)``), so the index is part of what's pinned here.
    seed = list(module.NOTIFICATION_TYPE_SEED)
    order, (row_id, key, name, short) = next(
        (i, row)
        for i, row in enumerate(seed, start=1)
        if row[1] == NotificationCategory.MATCH_CALLS.value
    )
    assert uuid.UUID(row_id) == uuid.UUID("33333333-3333-3333-3333-333333330006")
    assert key == NotificationCategory.MATCH_CALLS.value
    assert (name, short) == ("Match calls", "Calls")
    assert order == 6


# ----- the prefs matrix + taxonomy -------------------------------------------


async def test_match_calls_has_prefs_matrix_cells(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The category resolves into a full prefs-matrix row: every channel gets a
    cell, defaulting on for available channels (off for SMS), none locked —
    match calls are prefs-respecting per the ADR."""
    await start_session(api_client, db_session)
    data = (await api_client.get("/v1/notification-preferences")).json()

    row = next(c for c in data["categories"] if c["category"] == "match_calls")
    cells = {cell["channel"]: cell for cell in row["cells"]}

    assert set(cells) == {"in_app", "push", "email", "sms"}
    assert cells["in_app"] == {"channel": "in_app", "enabled": True, "locked": False}
    assert cells["push"] == {"channel": "push", "enabled": True, "locked": False}
    assert cells["email"] == {"channel": "email", "enabled": True, "locked": False}
    assert cells["sms"] == {"channel": "sms", "enabled": False, "locked": False}


async def test_match_calls_appears_in_the_taxonomy(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    data = (await api_client.get("/v1/notification-taxonomy")).json()

    entry = next(t for t in data["types"] if t["key"] == "match_calls")
    assert entry["label"] == "Match calls"
    assert entry["short"] == "Calls"


# ----- the message templates -------------------------------------------------


def test_match_called_message_says_where_when_and_who():
    msg = match_called_message(
        table_label="Table 3",
        estimated_start=datetime(2026, 7, 16, 14, 35, tzinfo=UTC),
        opponent_name="sofia",
        context=_CONTEXT,
    )
    assert msg.kind is MatchCallKind.MATCH_CALLED
    assert msg.title == "You're up soon — Table 3"
    assert msg.body == (
        "Your Spring Open · Men's Singles · Group B match against sofia "
        "starts around 14:35 on Table 3. Head to the table."
    )


def test_match_call_moved_message_carries_the_new_table_and_time():
    msg = match_call_moved_message(
        new_table_label="Table 5",
        new_estimated_start=datetime(2026, 7, 16, 15, 5, tzinfo=UTC),
        opponent_name="sofia",
        context=_CONTEXT,
    )
    assert msg.kind is MatchCallKind.MATCH_CALL_MOVED
    assert msg.title == "Your match moved to Table 5"
    assert msg.body == (
        "Your Spring Open · Men's Singles · Group B match against sofia "
        "now starts around 15:05 on Table 5."
    )


def test_match_call_cancelled_message_for_a_withdrawal():
    msg = match_call_cancelled_message(
        reason=MatchCallCancellationReason.OPPONENT_WITHDREW,
        opponent_name="sofia",
        context=_CONTEXT,
    )
    assert msg.kind is MatchCallKind.MATCH_CALL_CANCELLED
    assert msg.title == "Your match was cancelled"
    assert msg.body == (
        "Your Spring Open · Men's Singles · Group B match against sofia "
        "was cancelled — your opponent withdrew."
    )


def test_match_call_cancelled_message_for_a_schedule_change():
    msg = match_call_cancelled_message(
        reason=MatchCallCancellationReason.SCHEDULE_CHANGE,
        opponent_name="sofia",
        context=_CONTEXT,
    )
    assert msg.body == (
        "Your Spring Open · Men's Singles · Group B match against sofia "
        "was cancelled — the schedule changed."
    )


def test_context_without_a_group_omits_the_group_segment():
    """Ungrouped draws (single-elim) have no group label — the context label
    degrades to tournament · event with no dangling separator."""
    msg = match_called_message(
        table_label="Table 1",
        estimated_start=datetime(2026, 7, 16, 9, 0, tzinfo=UTC),
        opponent_name="li_wei",
        context=MatchCallContext(
            tournament_name="Spring Open", event_name="Men's Singles"
        ),
    )
    assert msg.body == (
        "Your Spring Open · Men's Singles match against li_wei "
        "starts around 09:00 on Table 1. Head to the table."
    )


def test_messages_fit_the_notification_columns():
    """``notifications.title`` is String(200) and ``body`` is String(500) —
    realistic copy must fit so the in-app insert can't blow up on length."""
    msg = match_called_message(
        table_label="Table 12",
        estimated_start=datetime(2026, 7, 16, 18, 45, tzinfo=UTC),
        opponent_name="a_rather_long_username_here",
        context=MatchCallContext(
            tournament_name="The 2026 Metropolitan Autumn Invitational",
            event_name="Mixed Doubles Consolation",
            group_label="Group F",
        ),
    )
    assert len(msg.title) <= 200
    assert len(msg.body) <= 500
