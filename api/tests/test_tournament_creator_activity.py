"""Tournament creation records a live actor and preserves that actor as history."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests._helpers import make_user

INSERT_TOURNAMENT = text(
    "INSERT INTO tournaments(id, name, league_id, "
    "created_by_user_id, owner_account_id) "
    "VALUES (gen_random_uuid(), 'Distinct creator', :league, :creator, :owner) "
    "RETURNING id"
)


@pytest.mark.parametrize("lifecycle", ["deactivate", "erase", "merge"])
async def test_sql_tournament_creation_requires_active_distinct_creator(
    db_session, default_league, lifecycle
):
    from app.account_merge import merge_user
    from app.identity_lifecycle import deactivate_account, erase_account

    creator = await make_user(db_session, "inactive-tournament-creator")
    owner = await make_user(db_session, "active-tournament-owner")
    if lifecycle == "deactivate":
        await deactivate_account(db_session, creator.id)
    elif lifecycle == "erase":
        await erase_account(db_session, creator.id)
    else:
        await merge_user(db_session, from_user_id=creator.id, to_user_id=owner.id)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="creator must be active"):
        async with db_session.begin_nested():
            await db_session.execute(
                INSERT_TOURNAMENT,
                {
                    "league": default_league.id,
                    "creator": creator.id,
                    "owner": owner.id,
                },
            )


@pytest.mark.parametrize("first", ["creation", "suspension"])
async def test_distinct_creator_creation_serializes_sql_suspension(
    db_session, engine, default_league, first
):
    import asyncio

    from sqlalchemy.exc import DBAPIError
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from tests.test_proposal_history import wait_for_blocked

    creator = await make_user(db_session, "creator-activity-race")
    owner = await make_user(db_session, "creator-race-distinct-owner")
    params = {"league": default_league.id, "creator": creator.id, "owner": owner.id}
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as creating, sessions() as suspending:
        suspension_pid = await suspending.scalar(text("SELECT pg_backend_pid()"))

        async def suspend():
            await suspending.execute(
                text(
                    "UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"
                ),
                {"id": creator.id},
            )

        if first == "creation":
            await creating.execute(INSERT_TOURNAMENT, params)
            pending = asyncio.create_task(suspend())
            try:
                await wait_for_blocked(db_session, suspension_pid, pending)
                await creating.commit()
                await pending
                await suspending.commit()
            finally:
                await creating.rollback()
                await pending
        else:
            await suspend()
            with pytest.raises(DBAPIError, match="account locks; retry") as error:
                await creating.execute(INSERT_TOURNAMENT, params)
            assert error.value.orig.sqlstate == "40001"
            await creating.rollback()
            await suspending.commit()
            with pytest.raises(IntegrityError, match="creator must be active"):
                await creating.execute(INSERT_TOURNAMENT, params)
            await creating.rollback()


@pytest.mark.parametrize("lifecycle", ["deactivate", "erase"])
async def test_distinct_creator_is_retained_after_lifecycle_changes(
    db_session, default_league, lifecycle
):
    from app.identity_lifecycle import deactivate_account, erase_account

    creator = await make_user(db_session, "retained-distinct-creator")
    owner = await make_user(db_session, "retained-distinct-owner")
    tournament_id = await db_session.scalar(
        INSERT_TOURNAMENT,
        {
            "league": default_league.id,
            "creator": creator.id,
            "owner": owner.id,
        },
    )
    await db_session.commit()
    if lifecycle == "deactivate":
        await deactivate_account(db_session, creator.id)
    else:
        await erase_account(db_session, creator.id)
    await db_session.commit()
    await db_session.execute(
        text(
            "UPDATE tournaments SET name='Updated by current owner', "
            "created_by_user_id=created_by_user_id WHERE id=:id"
        ),
        {"id": tournament_id},
    )
    await db_session.commit()
    row = (
        await db_session.execute(
            text(
                "SELECT created_by_user_id, owner_account_id, name "
                "FROM tournaments WHERE id=:id"
            ),
            {"id": tournament_id},
        )
    ).one()
    assert row.created_by_user_id == creator.id
    assert row.owner_account_id == owner.id
    assert row.name == "Updated by current owner"
