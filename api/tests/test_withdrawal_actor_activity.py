"""Competition withdrawal decisions require live actors, not live historical actors."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests._helpers import make_user
from tests.test_draw_history_integrity import drawn_history as drawn_history
from tests.test_tournament_entries import _make_event

WITHDRAW = text(
    "INSERT INTO "
    "tournament_entry_withdrawals(event_id,entry_id,actor_account_id,reason) "
    "VALUES(:event,:entry,:actor,'director_removal') RETURNING id"
)
RESTORE = text(
    "UPDATE tournament_entry_withdrawals SET restored_at=clock_timestamp(), "
    "restored_by_account_id=:actor WHERE id=:withdrawal"
)


async def withdrawal_context(db_session):
    actor = await make_user(db_session, "competition-withdrawal-actor")
    event = await _make_event(db_session)
    entry_id = await db_session.scalar(
        text(
            "INSERT INTO tournament_entries(event_id,status) "
            "VALUES(:event,'withdrawn') RETURNING id"
        ),
        {"event": event.id},
    )
    await db_session.commit()
    return actor, {"event": event.id, "entry": entry_id, "actor": actor.id}


@pytest.mark.parametrize("operation", ["withdraw", "restore"])
@pytest.mark.parametrize("erased", [False, True])
async def test_sql_competition_withdrawal_requires_live_new_actor(
    db_session, operation, erased
):
    from app.identity_lifecycle import deactivate_account, erase_account

    actor, params = await withdrawal_context(db_session)
    if operation == "restore":
        params["withdrawal"] = await db_session.scalar(WITHDRAW, params)
        await db_session.commit()
    if erased:
        await erase_account(db_session, actor.id)
    else:
        await deactivate_account(db_session, actor.id)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="withdrawal actor must be active"):
        async with db_session.begin_nested():
            await db_session.execute(
                WITHDRAW if operation == "withdraw" else RESTORE, params
            )


async def test_initially_restored_withdrawal_requires_active_restorer(db_session):
    from app.identity_lifecycle import deactivate_account

    actor, params = await withdrawal_context(db_session)
    restorer = await make_user(db_session, "inactive-initial-restorer")
    await deactivate_account(db_session, restorer.id)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="withdrawal actor must be active"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO tournament_entry_withdrawals(event_id,entry_id,"
                    "actor_account_id,reason,withdrawn_at,restored_at,"
                    "restored_by_account_id) "
                    "VALUES(:event,:entry,:actor,'director_removal',now(),now(),:restorer)"
                ),
                {**params, "restorer": restorer.id},
            )


@pytest.mark.parametrize("erased", [False, True])
async def test_withdrawal_history_survives_actor_lifecycle_and_fresh_restoration(
    db_session, erased
):
    from app.identity_lifecycle import deactivate_account, erase_account

    actor, params = await withdrawal_context(db_session)
    params["withdrawal"] = await db_session.scalar(WITHDRAW, params)
    await db_session.commit()
    if erased:
        await erase_account(db_session, actor.id)
    else:
        await deactivate_account(db_session, actor.id)
    await db_session.commit()
    await db_session.execute(
        text(
            "UPDATE tournament_entry_withdrawals SET actor_account_id=actor_account_id,"
            "restored_by_account_id=NULL WHERE id=:withdrawal"
        ),
        params,
    )
    restorer = await make_user(db_session, "active-fresh-restorer")
    await db_session.execute(RESTORE, {**params, "actor": restorer.id})
    await db_session.commit()
    await deactivate_account(db_session, restorer.id)
    await db_session.commit()
    await db_session.execute(
        text(
            "UPDATE tournament_entry_withdrawals SET restored_at=restored_at "
            "WHERE id=:withdrawal"
        ),
        params,
    )
    await db_session.commit()
    row = (
        await db_session.execute(
            text(
                "SELECT actor_account_id,restored_by_account_id FROM "
                "tournament_entry_withdrawals "
                "WHERE id=:withdrawal"
            ),
            params,
        )
    ).one()
    assert row.actor_account_id == actor.id
    assert row.restored_by_account_id == restorer.id


@pytest.mark.parametrize("operation", ["withdraw", "restore"])
@pytest.mark.parametrize("first", ["decision", "suspension"])
async def test_withdrawal_decision_serializes_account_suspension(
    db_session, engine, operation, first
):
    import asyncio

    from sqlalchemy.exc import DBAPIError
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from tests.test_proposal_history import wait_for_blocked

    actor, params = await withdrawal_context(db_session)
    if operation == "restore":
        params["withdrawal"] = await db_session.scalar(WITHDRAW, params)
        await db_session.commit()
    statement = WITHDRAW if operation == "withdraw" else RESTORE
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as writer, sessions() as lifecycle:
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))

        async def suspend():
            await lifecycle.execute(
                text(
                    "UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"
                ),
                {"id": actor.id},
            )

        if first == "decision":
            await writer.execute(statement, params)
            pending = asyncio.create_task(suspend())
            try:
                await wait_for_blocked(db_session, lifecycle_pid, pending)
                await writer.commit()
                await pending
                await lifecycle.commit()
            finally:
                await writer.rollback()
                await pending
                await lifecycle.rollback()
        else:
            await suspend()
            with pytest.raises(
                DBAPIError, match="withdrawal actor is changing; retry"
            ) as error:
                await writer.execute(statement, params)
            assert error.value.orig.sqlstate == "40001"
            await writer.rollback()
            await lifecycle.commit()
            with pytest.raises(IntegrityError, match="withdrawal actor must be active"):
                await writer.execute(statement, params)
            await writer.rollback()


@pytest.mark.parametrize("operation", ["close", "insert_closed"])
@pytest.mark.parametrize("erased", [False, True])
async def test_participation_closure_requires_live_fresh_actor(
    db_session, drawn_history, operation, erased
):
    from app.identity_lifecycle import deactivate_account, erase_account

    actor = await make_user(db_session, "inactive-participation-closer")
    if erased:
        await erase_account(db_session, actor.id)
    else:
        await deactivate_account(db_session, actor.id)
    await db_session.commit()
    statement = (
        "UPDATE tournament_entry_participations SET ended_at=clock_timestamp(),"
        "end_reason='director_removal',ended_by_account_id=:actor WHERE id=:id"
        if operation == "close"
        else "INSERT INTO "
        "tournament_entry_participations(event_id,entry_id,stage_id,group_id,"
        "draw_revision_id,started_at,ended_at,end_reason,ended_by_account_id) "
        "SELECT event_id,entry_id,stage_id,group_id,draw_revision_id,started_at,"
        "clock_timestamp(),'director_removal',:actor FROM "
        "tournament_entry_participations WHERE id=:id"
    )
    with pytest.raises(IntegrityError, match="participation actor must be active"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(statement),
                {"actor": actor.id, "id": drawn_history["participation_id"]},
            )


@pytest.mark.parametrize("system", [False, True])
async def test_participation_closure_preserves_historical_and_system_actors(
    db_session, drawn_history, system
):
    from app.identity_lifecycle import deactivate_account

    actor = await make_user(db_session, "historical-participation-closer")
    params = {
        "id": drawn_history["participation_id"],
        "actor": None if system else actor.id,
    }
    await db_session.execute(
        text(
            "UPDATE tournament_entry_participations SET ended_at=clock_timestamp(),"
            "end_reason='stage_completed',ended_by_account_id=:actor WHERE id=:id"
        ),
        params,
    )
    await db_session.commit()
    await deactivate_account(db_session, actor.id)
    await db_session.commit()
    await db_session.execute(
        text(
            "UPDATE tournament_entry_participations SET ended_at=ended_at WHERE id=:id"
        ),
        params,
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            text(
                "SELECT ended_by_account_id FROM "
                "tournament_entry_participations WHERE id=:id"
            ),
            params,
        )
        == params["actor"]
    )


@pytest.mark.parametrize("first", ["decision", "suspension"])
async def test_participation_closure_serializes_account_suspension(
    db_session, engine, drawn_history, first
):
    import asyncio

    from sqlalchemy.exc import DBAPIError
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from tests.test_proposal_history import wait_for_blocked

    actor = await make_user(db_session, "racing-participation-closer")
    await db_session.commit()
    params = {"id": drawn_history["participation_id"], "actor": actor.id}
    statement = text(
        "UPDATE tournament_entry_participations SET ended_at=clock_timestamp(),"
        "end_reason='director_removal',ended_by_account_id=:actor WHERE id=:id"
    )
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as writer, sessions() as lifecycle:
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))

        async def suspend():
            await lifecycle.execute(
                text(
                    "UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"
                ),
                {"id": actor.id},
            )

        if first == "decision":
            await writer.execute(statement, params)
            pending = asyncio.create_task(suspend())
            try:
                await wait_for_blocked(db_session, lifecycle_pid, pending)
                await writer.commit()
                await pending
                await lifecycle.commit()
            finally:
                await writer.rollback()
                await pending
                await lifecycle.rollback()
        else:
            await suspend()
            with pytest.raises(
                DBAPIError, match="participation actor is changing; retry"
            ) as error:
                await writer.execute(statement, params)
            assert error.value.orig.sqlstate == "40001"
            await writer.rollback()
            await lifecycle.commit()
            with pytest.raises(
                IntegrityError, match="participation actor must be active"
            ):
                await writer.execute(statement, params)
            await writer.rollback()
