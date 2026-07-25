"""Who gets hinted when a match finalises.

``test_realtime_outbox`` proves the *mechanism* — staged, committed, published
once. This file proves the **audience**, which is the part a mechanism test
cannot see: an implementation that broadcast every hint to every connected user
would pass all of those and fail only here. So every test below names the users
who must be hinted *and* a signed-in user who must not be, and asserts the
bystander's count is exactly zero rather than merely smaller.

The write is driven the way it really happens — over HTTP for the two router
paths, through ``retire_if_lapsed`` for the worker sweep — and the fan-out is
observed at the broker (see :mod:`tests._realtime` for why never over the
socket, and how "zero" is made an assertion instead of a hopeful sleep).
"""

import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Match, MatchResult, MatchStatus
from app.notifications.service import NotificationService
from app.realtime import EventKind, RealtimeBroker
from app.retirement_jobs import RetirementOutcome, retire_if_lapsed
from tests._helpers import (
    FakeSender,
    accept_standing_result,
    make_client,
    opponent_session,
    start_session,
)
from tests._realtime import watch_hints

RETIREMENT_WINDOW = timedelta(days=7)


def _name(stem: str) -> str:
    return f"{stem}-{uuid.uuid4().hex[:8]}"


async def _create_match(
    client: AsyncClient, opponent_id: uuid.UUID, *, rated: bool
) -> dict:
    response = await client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent_id),
            "best_of": 1,
            "rated": rated,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _post_decisive_result(client: AsyncClient, match_id: str) -> None:
    response = await client.post(
        f"/v1/matches/{match_id}/results",
        json={"games": [{"game_number": 1, "side_1_points": 11, "side_2_points": 4}]},
    )
    assert response.status_code == 201, response.text


async def _standing_result(db: AsyncSession, match_id: uuid.UUID) -> MatchResult:
    return (
        await db.execute(select(MatchResult).where(MatchResult.match_id == match_id))
    ).scalar_one()


async def test_finalize_over_http_hints_both_participants_and_not_the_bystander(
    api_client: AsyncClient,
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
) -> None:
    """Accepting a standing result hints the poster and the accepter — and hints
    a third signed-in user, who is on neither side, zero times."""
    poster = await start_session(api_client, db_session)
    async with opponent_session(db_session, _name("accepter")) as (
        accepter_client,
        accepter,
    ):
        bystander_client = make_client()
        try:
            bystander = await start_session(bystander_client, db_session)
            match = await _create_match(api_client, accepter.id, rated=True)
            await _post_decisive_result(api_client, match["id"])

            async with watch_hints(
                realtime_broker, poster.id, accepter.id, bystander.id
            ) as watch:
                await accept_standing_result(accepter_client, match["id"])
                hints = await watch.collect()
        finally:
            await bystander_client.aclose()

    assert hints[poster.id] == [EventKind.dashboard_changed]
    assert hints[accepter.id] == [EventKind.dashboard_changed]
    assert hints[bystander.id] == []


async def test_finalize_at_propose_time_hints_both_participants_not_the_bystander(
    api_client: AsyncClient,
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
) -> None:
    """An unrated match skips acceptance and completes on the POST itself — the
    other route into ``finalize_match``. Same audience, same one hint each."""
    poster = await start_session(api_client, db_session)
    async with opponent_session(db_session, _name("opponent")) as (_, opponent):
        bystander_client = make_client()
        try:
            bystander = await start_session(bystander_client, db_session)
            match = await _create_match(api_client, opponent.id, rated=False)

            async with watch_hints(
                realtime_broker, poster.id, opponent.id, bystander.id
            ) as watch:
                await _post_decisive_result(api_client, match["id"])
                hints = await watch.collect()
        finally:
            await bystander_client.aclose()

    assert hints[poster.id] == [EventKind.dashboard_changed]
    assert hints[opponent.id] == [EventKind.dashboard_changed]
    assert hints[bystander.id] == []


async def test_finalize_by_the_retirement_sweep_hints_both_participants(
    api_client: AsyncClient,
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
) -> None:
    """The worker path needs no hook of its own.

    ``retire_if_lapsed`` reaches ``accept_standing_result`` → ``finalize_match``
    on its own session and commits at the end, so the one staging site inside
    ``finalize_match`` covers auto-acceptance too. This is the test that would
    red if someone "helpfully" moved the staging up into the HTTP handlers.
    """
    poster = await start_session(api_client, db_session)
    async with opponent_session(db_session, _name("no-show")) as (_, no_show):
        bystander_client = make_client()
        try:
            bystander = await start_session(bystander_client, db_session)
            created = await _create_match(api_client, no_show.id, rated=True)
            await _post_decisive_result(api_client, created["id"])

            match_id = uuid.UUID(created["id"])
            match = (
                await db_session.execute(select(Match).where(Match.id == match_id))
            ).scalar_one()
            standing = await _standing_result(db_session, match_id)
            # Back-date past the window instead of sleeping a week.
            match.match_settings.retirement_window = RETIREMENT_WINDOW
            standing.submitted_at = datetime.now(UTC) - RETIREMENT_WINDOW * 2
            await db_session.commit()

            async with watch_hints(
                realtime_broker, poster.id, no_show.id, bystander.id
            ) as watch:
                outcome = await retire_if_lapsed(
                    db_session,
                    match_id,
                    standing.id,
                    NotificationService(db_session, FakeSender()),
                )
                hints = await watch.collect()
        finally:
            await bystander_client.aclose()

    assert outcome is RetirementOutcome.retired
    assert match.status is MatchStatus.completed
    assert hints[poster.id] == [EventKind.dashboard_changed]
    assert hints[no_show.id] == [EventKind.dashboard_changed]
    assert hints[bystander.id] == []
