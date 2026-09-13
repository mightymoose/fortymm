"""Materializing matches does not revalidate unrelated draw history."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Tournament
from app.tournament_materialization import materialize_live_draw
from tests._helpers import make_user
from tests.test_draw_history_integrity import drawn_history as drawn_history
from tests.test_tournament_draw_service import _make_event, _make_tournament


@pytest.mark.parametrize("sequential_scan", [False, True])
async def test_materialization_skips_unchanged_draw_configuration_checks(
    db_session: AsyncSession,
    drawn_history,
    default_league,
    sequential_scan: bool,
) -> None:
    # Unrelated parents make physical tuple counts depend on scan strategy.
    # The invariant is trigger work, regardless of PostgreSQL's chosen plan.
    unrelated_owner = await make_user(db_session, "unrelated-plan-owner")
    unrelated = await _make_tournament(
        db_session, owner=unrelated_owner, league=default_league
    )
    await _make_event(db_session, unrelated, groups=[])
    tournament = await db_session.get(Tournament, drawn_history["tournament_id"])
    assert tournament is not None
    await db_session.execute(text("SET LOCAL track_functions='all'"))
    if sequential_scan:
        await db_session.execute(text("SET LOCAL enable_indexscan=off"))
        await db_session.execute(text("SET LOCAL enable_bitmapscan=off"))
    unchanged_checks = {
        "check_draw_retirement",
        "fixture_scope",
        "fixture_participation",
        "validate_new_fixture_seats",
        "update_draw_fixture_counts",
        "lock_draw_history_parent",
    }
    link_checks = {"lock_fixture_link", "lock_fixture_write_batch"}
    query = text("SELECT funcname,calls FROM pg_stat_xact_user_functions")
    before = dict((await db_session.execute(query)).all())
    await materialize_live_draw(db_session, tournament)
    await db_session.flush()
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    after = dict((await db_session.execute(query)).all())
    calls = {
        name: after.get(name, 0) - before.get(name, 0)
        for name in unchanged_checks | link_checks
    }
    assert {name: calls[name] for name in unchanged_checks} == {
        name: 0 for name in unchanged_checks
    }
    # Link integrity still runs once for each fixture; draw configuration and
    # its separate parent-lock trigger are untouched by materialization.
    assert {name: calls[name] for name in link_checks} == {
        name: 6 for name in link_checks
    }
    assert (
        await db_session.scalar(
            text(
                "SELECT count(*) FROM tournament_fixtures WHERE scope_event_id=:event "
                "AND match_id IS NOT NULL"
            ),
            {"event": drawn_history["event_id"]},
        )
        == 6
    )
