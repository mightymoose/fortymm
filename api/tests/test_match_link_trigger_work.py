"""Materializing matches does not revalidate unrelated draw history."""

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Tournament
from app.tournament_materialization import materialize_live_draw
from tests.test_draw_history_integrity import drawn_history as drawn_history


async def test_materialization_skips_unchanged_draw_configuration_checks(
    db_session: AsyncSession,
    drawn_history,
    engine,
) -> None:
    tournament = await db_session.get(Tournament, drawn_history["tournament_id"])
    assert tournament is not None
    await db_session.execute(text("SET LOCAL track_functions='all'"))
    query = text(
        "SELECT funcname,calls FROM pg_stat_xact_user_functions WHERE funcname IN "
        "('check_draw_retirement','fixture_scope','fixture_participation',"
        "'validate_new_fixture_seats','update_draw_fixture_counts')"
    )
    before = dict((await db_session.execute(query)).all())
    parent_reads = []
    parent_query = text(
        "SELECT sum(seq_tup_read+idx_tup_fetch) FROM pg_stat_xact_user_tables "
        "WHERE relname IN ('tournaments','tournament_events')"
    )
    current_reads = []

    def before_link(conn, cursor, statement, parameters, context, many):
        if statement.startswith("UPDATE tournament_fixtures SET match_id="):
            current_reads.append(conn.scalar(parent_query))

    def after_link(conn, cursor, statement, parameters, context, many):
        if statement.startswith("UPDATE tournament_fixtures SET match_id="):
            parent_reads.append(conn.scalar(parent_query) - current_reads.pop())

    event.listen(engine.sync_engine, "before_cursor_execute", before_link)
    event.listen(engine.sync_engine, "after_cursor_execute", after_link)
    try:
        await materialize_live_draw(db_session, tournament)
        await db_session.flush()
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", before_link)
        event.remove(engine.sync_engine, "after_cursor_execute", after_link)
    # Existing match-link locks remain; the duplicate draw-parent locks do not.
    assert parent_reads
    assert 0 < sum(parent_reads) <= 18
    await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    after = dict((await db_session.execute(query)).all())
    assert {name: calls - before.get(name, 0) for name, calls in after.items()} == {
        name: 0 for name in after
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
