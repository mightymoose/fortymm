"""Current event progress and retained draw history stay distinct."""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.result_proposal import propose_result
from app.tournament_draws import uncut_draw
from tests._helpers import directed_tournament_match
from tests.test_official_results import board


async def test_retiring_completed_draw_reconciles_current_event_progress(
    db_session: AsyncSession,
) -> None:
    match, director = await directed_tournament_match(
        db_session, tag="retired-event-progress", best_of=1, rated=False
    )
    event_id = await db_session.scalar(
        text("SELECT scope_event_id FROM tournament_fixtures WHERE match_id=:id"),
        {"id": match.id},
    )
    assert event_id is not None
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    state_query = text("SELECT lifecycle_state FROM tournament_events WHERE id=:id")
    assert await db_session.scalar(state_query, {"id": event_id}) == "finished"
    # The core can archive played history for explicit maintenance. Public draw
    # replacement has its separate under-way guard and remains refused.
    await uncut_draw(db_session, [event_id])
    await db_session.commit()
    assert await db_session.scalar(state_query, {"id": event_id}) == "in_progress"


async def test_sql_retirement_requires_new_event_reconciliation(
    db_session: AsyncSession,
) -> None:
    import pytest
    from sqlalchemy.exc import IntegrityError

    from app.event_lifecycle import reconcile_event
    from app.tournament_event_stages import archive_stage_configuration

    match, director = await directed_tournament_match(
        db_session, tag="sql-retired-progress", best_of=1, rated=False
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    event_id = await db_session.scalar(
        text("SELECT scope_event_id FROM tournament_fixtures WHERE match_id=:id"),
        {"id": match.id},
    )
    assert event_id is not None
    with pytest.raises(IntegrityError, match="requires event reconciliation"):
        async with db_session.begin_nested():
            await reconcile_event(db_session, event_id)
            await db_session.execute(
                text(
                    "UPDATE tournament_entry_participations "
                    "SET ended_at=clock_timestamp(), "
                    "end_reason='draw_retired' WHERE event_id=:id AND ended_at IS NULL"
                ),
                {"id": event_id},
            )
            await db_session.execute(
                text(
                    "UPDATE tournament_fixtures SET retired_at=clock_timestamp(), "
                    "updated_at=updated_at WHERE scope_event_id=:id"
                ),
                {"id": event_id},
            )
            await db_session.execute(
                text(
                    "UPDATE tournament_draw_revisions SET retired_at=clock_timestamp() "
                    "WHERE event_id=:id"
                ),
                {"id": event_id},
            )
            await archive_stage_configuration(db_session, [event_id])
            await db_session.execute(
                text("SET CONSTRAINTS require_event_reconciliation IMMEDIATE")
            )


async def test_sql_void_of_retired_match_reconciles_its_historical_event(
    db_session: AsyncSession,
) -> None:
    import uuid

    from app.event_lifecycle import reconcile_match_event
    from app.official_results import official_history

    match, director = await directed_tournament_match(
        db_session, tag="void-retired-progress", best_of=1, rated=False
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (official,) = await official_history(db_session, match.id)
    event_id = await db_session.scalar(
        text("SELECT scope_event_id FROM tournament_fixtures WHERE match_id=:id"),
        {"id": match.id},
    )
    assert event_id is not None
    await uncut_draw(db_session, [event_id])
    await db_session.commit()
    await db_session.execute(
        text(
            "INSERT INTO match_void_actions "
            "(id,match_id,official_result_id,actor_account_id,reason,"
            "tournament_id,owner_revision) VALUES "
            "(:id,:match,:result,:actor,'Void',:tournament,0)"
        ),
        {
            "id": uuid.uuid4(),
            "match": match.id,
            "result": official.id,
            "actor": director.id,
            "tournament": official.tournament_id,
        },
    )
    await reconcile_match_event(db_session, match.id)
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "in_progress"
    )
