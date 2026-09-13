"""Cancelled events retain history without creating new sporting work."""

from sqlalchemy.ext.asyncio import AsyncSession

from app.event_lifecycle import cancel_event
from app.models import Tournament, TournamentEvent, TournamentStatus, User
from app.tournament_materialization import materialize_event, materialize_live_draw
from tests.test_match_calls import _make_tournament, _the_fixture


async def test_cancelled_published_draw_is_not_materialized(
    db_session: AsyncSession,
) -> None:
    tournament_id, event_id = await _make_tournament(
        db_session, status=TournamentStatus.published
    )
    tournament = await db_session.get(Tournament, tournament_id)
    event = await db_session.get(TournamentEvent, event_id)
    assert tournament is not None and event is not None
    owner = await db_session.get(User, tournament.created_by_user_id)
    assert owner is not None
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    await materialize_live_draw(db_session, tournament)
    await materialize_event(db_session, tournament, event)
    fixture = await _the_fixture(db_session, event_id)
    assert fixture.match_id is None


async def test_cancelled_scheduled_fixture_is_excluded_from_calls_and_solver(
    db_session: AsyncSession,
) -> None:
    from app.match_calls import call_due_fixtures
    from app.schedule_solves import _load_solver_inputs
    from tests.test_match_calls import BASE, _place_fixture

    tournament_id, event_id = await _make_tournament(db_session)
    tournament = await db_session.get(Tournament, tournament_id)
    assert tournament is not None
    await materialize_live_draw(db_session, tournament)
    await _place_fixture(db_session, event_id, table_id="t1", start=BASE)
    fixture = await _the_fixture(db_session, event_id)
    match_id = fixture.match_id
    placement = (fixture.table_id, fixture.scheduled_start)
    before = await _load_solver_inputs(db_session, tournament_id, now=BASE, lock=False)
    assert before is not None and before.snapshot.fixtures
    owner = await db_session.get(User, tournament.created_by_user_id)
    assert owner is not None
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    jobs = await call_due_fixtures(db_session, tournament, [fixture], now=BASE)
    assert jobs == []
    assert fixture.call_notified_count == 0
    assert fixture.pinned_at is None
    after = await _load_solver_inputs(db_session, tournament_id, now=BASE, lock=False)
    assert after is not None and not after.snapshot.fixtures
    assert after.fingerprint != before.fingerprint
    assert fixture.match_id == match_id
    assert (fixture.table_id, fixture.scheduled_start) == placement


async def test_cancelled_event_cannot_be_manually_placed(
    db_session: AsyncSession,
) -> None:
    import pytest

    from app.schemas.tournament import TournamentFixturePlacementUpdate
    from app.tournament_errors import FixturePlacementFrozenError
    from app.tournament_placement import place_fixture
    from tests.test_match_calls import BASE, _table

    tournament_id, event_id = await _make_tournament(db_session)
    tournament = await db_session.get(Tournament, tournament_id)
    assert tournament is not None
    owner = await db_session.get(User, tournament.created_by_user_id)
    assert owner is not None
    fixture = await _the_fixture(db_session, event_id)
    table_id = await _table(db_session, event_id, "t1")
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    with pytest.raises(FixturePlacementFrozenError, match="event is cancelled"):
        await place_fixture(
            db_session,
            tournament_id=tournament_id,
            fixture_id=fixture.id,
            actor=owner,
            placement=TournamentFixturePlacementUpdate(
                table_id=table_id, scheduled_start=BASE.replace(tzinfo=None)
            ),
        )
    assert fixture.table_id is None
    assert fixture.call_notified_count == 0


async def test_cancelled_uncut_event_does_not_block_active_event_go_live(
    db_session: AsyncSession,
) -> None:
    from app.models.tournament import EventLifecycleState
    from app.tournament_lifecycle import transition_tournament

    tournament_id, event_id = await _make_tournament(
        db_session, status=TournamentStatus.published
    )
    tournament = await db_session.get(Tournament, tournament_id)
    active = await db_session.get(TournamentEvent, event_id)
    assert tournament is not None and active is not None
    owner = await db_session.get(User, tournament.created_by_user_id)
    assert owner is not None
    cancelled = TournamentEvent(
        tournament_id=tournament_id,
        name="Cancelled event without entrants or draw",
        format=active.format,
        draw_settings=active.draw_settings,
        slot=active.slot,
        timezone=active.timezone,
        match_settings=active.match_settings,
        entry_fee=active.entry_fee,
    )
    db_session.add(cancelled)
    await db_session.flush()
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=cancelled.id, actor=owner
    )
    await transition_tournament(
        db_session, tournament_id=tournament_id, actor=owner, to=TournamentStatus.live
    )
    assert tournament.status is TournamentStatus.live
    assert cancelled.lifecycle_state is EventLifecycleState.cancelled
    fixture = await _the_fixture(db_session, event_id)
    assert fixture.match_id is not None


async def test_cancelled_called_event_releases_resources_and_retains_call_history(
    db_session: AsyncSession,
) -> None:
    from sqlalchemy import select

    from app.match_calls import _held_resources, call_due_fixtures
    from app.models import Match, Notification
    from tests.test_match_calls import BASE, _place_fixture

    tournament_id, event_id = await _make_tournament(db_session)
    tournament = await db_session.get(Tournament, tournament_id)
    assert tournament is not None
    await materialize_live_draw(db_session, tournament)
    await _place_fixture(db_session, event_id, table_id="t1", start=BASE)
    fixture = await _the_fixture(db_session, event_id)
    await call_due_fixtures(db_session, tournament, [fixture], now=BASE)
    assert (await _held_resources(db_session, tournament_id)).tables
    assert fixture.match_id is not None
    match = await db_session.get(Match, fixture.match_id)
    assert match is not None
    history = (fixture.pinned_at, fixture.call_notified_count, match.status)
    notifications = set(await db_session.scalars(select(Notification.id)))
    assert notifications
    owner = await db_session.get(User, tournament.created_by_user_id)
    assert owner is not None
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    held = await _held_resources(db_session, tournament_id)
    assert not held.tables and not held.users
    assert (fixture.pinned_at, fixture.call_notified_count, match.status) == history
    assert set(await db_session.scalars(select(Notification.id))) == notifications
