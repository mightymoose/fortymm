"""Lifecycle boundaries exposed by direct SQL and all-cancelled tournaments."""

from sqlalchemy.ext.asyncio import AsyncSession

from app.event_lifecycle import cancel_event
from app.models import Tournament, TournamentStatus, User
from app.tournament_lifecycle import transition_tournament
from tests.test_match_calls import _make_tournament, _the_fixture


async def test_all_cancelled_tournament_can_go_live_then_archive(
    db_session: AsyncSession,
) -> None:
    tournament_id, event_id = await _make_tournament(
        db_session, status=TournamentStatus.published
    )
    tournament = await db_session.get(Tournament, tournament_id)
    assert tournament is not None
    owner = await db_session.get(User, tournament.created_by_user_id)
    assert owner is not None
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    await transition_tournament(
        db_session, tournament_id=tournament_id, actor=owner, to=TournamentStatus.live
    )
    fixture = await _the_fixture(db_session, event_id)
    assert fixture.match_id is None
    assert fixture.table_id is None
    assert fixture.scheduled_start is None
    await transition_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        to=TournamentStatus.archived,
    )
    assert tournament.status is TournamentStatus.archived


async def test_sql_void_cannot_commit_without_reconciling_finished_event(
    db_session: AsyncSession,
) -> None:
    import uuid

    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.official_results import official_history
    from app.result_proposal import propose_result
    from tests._helpers import directed_tournament_match
    from tests.test_official_results import board

    match, director = await directed_tournament_match(
        db_session, tag="void-reconciliation", best_of=1
    )
    await db_session.execute(
        text(
            "UPDATE tournament_events SET draw_type_id=(SELECT id FROM draw_types "
            "WHERE key='single-elim') WHERE id=(SELECT scope_event_id FROM "
            "tournament_fixtures WHERE match_id=:id)"
        ),
        {"id": match.id},
    )
    await db_session.execute(
        text(
            "UPDATE tournament_event_stages SET draw_type_id=(SELECT id "
            "FROM draw_types "
            "WHERE key='single-elim') WHERE id=(SELECT stage_id FROM "
            "tournament_fixtures WHERE match_id=:id)"
        ),
        {"id": match.id},
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (official,) = await official_history(db_session, match.id)
    with pytest.raises(IntegrityError, match="requires event reconciliation"):
        async with db_session.begin_nested():
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
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    # SQL maintenance may explicitly run the same result reconciliation as Python.
    from app.event_lifecycle import reconcile_match_event

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
            text(
                "SELECT lifecycle_state FROM tournament_events WHERE id="
                "(SELECT scope_event_id FROM tournament_fixtures WHERE match_id=:id)"
            ),
            {"id": match.id},
        )
        == "in_progress"
    )


async def test_round_robin_void_receipt_preserves_complete_event(
    db_session: AsyncSession,
) -> None:
    from sqlalchemy import text

    from app.official_results import void_official_match
    from app.result_proposal import propose_result
    from tests._helpers import directed_tournament_match
    from tests.test_official_results import board

    match, director = await directed_tournament_match(
        db_session, tag="rr-void-receipt", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    version = await db_session.scalar(
        text(
            "SELECT lifecycle_version FROM tournament_events WHERE id="
            "(SELECT scope_event_id FROM tournament_fixtures WHERE match_id=:id)"
        ),
        {"id": match.id},
    )
    action = await void_official_match(
        db_session, match.id, director.id, reason="Pairing excluded"
    )
    await db_session.commit()
    receipt = (
        await db_session.execute(
            text(
                "SELECT lifecycle_state,lifecycle_version "
                "FROM tournament_event_reconciliations "
                "WHERE event_id=(SELECT f.scope_event_id FROM tournament_fixtures f "
                "JOIN match_void_actions v ON v.match_id=f.match_id WHERE v.id=:id) "
                "ORDER BY transaction_id DESC LIMIT 1"
            ),
            {"id": action.id},
        )
    ).one()
    assert receipt.lifecycle_state == "finished"
    assert receipt.lifecycle_version == version
    import pytest
    from sqlalchemy.exc import IntegrityError

    for statement in (
        "DELETE FROM tournament_event_reconciliations WHERE event_id="
        "(SELECT f.scope_event_id FROM tournament_fixtures f "
        "JOIN match_void_actions v ON v.match_id=f.match_id WHERE v.id=:id)",
        "UPDATE tournament_event_reconciliations SET lifecycle_version=999 "
        "WHERE event_id=(SELECT f.scope_event_id FROM tournament_fixtures f "
        "JOIN match_void_actions v ON v.match_id=f.match_id WHERE v.id=:id)",
    ):
        with pytest.raises(IntegrityError, match="receipts are retained"):
            async with db_session.begin_nested():
                await db_session.execute(text(statement), {"id": action.id})
