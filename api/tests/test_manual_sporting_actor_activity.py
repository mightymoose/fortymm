"""Fresh manual sporting decisions require live actors; retained facts do not."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.ratings.inputs import record_rating_input
from tests._helpers import make_user


async def rating_context(db_session, default_league):
    actor = await make_user(db_session, "manual-input-actor")
    player = await make_user(db_session, "manual-input-subject")
    original = await record_rating_input(
        db_session,
        default_league.id,
        player.player_id,
        actor_account_id=actor.id,
        rating=1400,
        source="manual",
        effective_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    await db_session.commit()
    return actor, original


async def make_inactive(db_session, account_id, erased):
    from app.identity_lifecycle import deactivate_account, erase_account

    if erased:
        await erase_account(db_session, account_id)
    else:
        await deactivate_account(db_session, account_id)
    await db_session.commit()


RATING_INSERT = text(
    "INSERT INTO rating_inputs(league_id,player_id,actor_account_id,rating_strategy_id,"
    "rating,source,effective_at,supersedes_id) "
    "SELECT league_id,player_id,:actor,rating_strategy_id,1600,source,effective_at,"
    "CASE WHEN :replacement THEN id ELSE NULL END FROM rating_inputs WHERE id=:id"
)


@pytest.mark.parametrize("erased", [False, True])
@pytest.mark.parametrize("replacement", [False, True])
async def test_sql_manual_rating_input_requires_active_actor(
    db_session, default_league, erased, replacement
):
    actor, original = await rating_context(db_session, default_league)
    await make_inactive(db_session, actor.id, erased)
    with pytest.raises(IntegrityError, match="rating input actor must be active"):
        async with db_session.begin_nested():
            await db_session.execute(
                RATING_INSERT,
                {
                    "actor": actor.id,
                    "id": original.id,
                    "replacement": replacement,
                },
            )


@pytest.mark.parametrize("erased", [False, True])
@pytest.mark.parametrize("replacement", [False, True])
async def test_manual_rating_service_refuses_inactive_actor(
    db_session, default_league, erased, replacement
):
    from app.ratings.inputs import replace_rating_input

    actor, original = await rating_context(db_session, default_league)
    await make_inactive(db_session, actor.id, erased)
    with pytest.raises(ValueError, match="Rating input actor must be active"):
        if replacement:
            await replace_rating_input(
                db_session,
                original.id,
                actor_account_id=actor.id,
                rating=1600,
                note="Reviewed replacement",
            )
        else:
            await record_rating_input(
                db_session,
                original.league_id,
                original.player_id,
                actor_account_id=actor.id,
                rating=1600,
                source="manual",
                effective_at=original.effective_at,
            )


async def advancement_context(db_session):
    from app.advancement_decisions import advancement_history
    from app.result_proposal import propose_result
    from tests._advancement_seeds import seed_knockout_advancement
    from tests.test_official_results import board

    match, actor, _, target = await seed_knockout_advancement(db_session)
    await propose_result(
        db_session, match.id, actor.id, games=board(), supersedes_result_id=None
    )
    (original,) = await advancement_history(db_session, target.id, "a")
    return actor, original, target.id


ADVANCEMENT_INSERT = text(
    "INSERT INTO fixture_advancement_decisions(fixture_id,side,entry_id,"
    "source_fixture_id,source_group_id,rule_version,rule_settings,evidence_count,"
    "revision,predecessor_id,actor_account_id,reason) "
    "SELECT fixture_id,side,entry_id,source_fixture_id,source_group_id,rule_version,"
    "rule_settings,evidence_count,revision+1,id,:actor,'Reviewed replacement' "
    "FROM fixture_advancement_decisions WHERE id=:id"
)


@pytest.mark.parametrize("erased", [False, True])
async def test_sql_advancement_replacement_requires_active_actor(db_session, erased):
    actor, original, _ = await advancement_context(db_session)
    await make_inactive(db_session, actor.id, erased)
    with pytest.raises(IntegrityError, match="advancement actor must be active"):
        async with db_session.begin_nested():
            await db_session.execute(
                ADVANCEMENT_INSERT, {"actor": actor.id, "id": original.id}
            )


@pytest.mark.parametrize("erased", [False, True])
async def test_advancement_service_refuses_inactive_replacement_actor(
    db_session, erased
):
    from app.advancement_decisions import replace_advancement

    actor, original, fixture_id = await advancement_context(db_session)
    await make_inactive(db_session, actor.id, erased)
    with pytest.raises(ValueError, match="Advancement actor must be active"):
        await replace_advancement(
            db_session,
            fixture_id,
            "a",
            expected_current_id=original.id,
            actor_account_id=actor.id,
            reason="Reviewed replacement",
            entry_id=original.entry_id,
            official_result_ids=original.official_result_ids,
        )


@pytest.mark.parametrize(
    "operation", ["rating_record", "rating_replace", "advancement"]
)
@pytest.mark.parametrize("interface", ["sql", "service"])
@pytest.mark.parametrize("first", ["write", "suspend"])
async def test_manual_actor_activity_serializes_sql_suspension(
    db_session, engine, default_league, operation, interface, first
):
    import asyncio

    from sqlalchemy.exc import DBAPIError
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.advancement_decisions import replace_advancement
    from app.ratings.inputs import replace_rating_input
    from tests.test_proposal_history import wait_for_blocked

    if operation == "advancement":
        actor, original, fixture_id = await advancement_context(db_session)
    else:
        actor, original = await rating_context(db_session, default_league)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as writer, sessions() as lifecycle:
        writer_pid = await writer.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))

        async def write():
            if interface == "sql":
                if operation == "advancement":
                    await writer.execute(
                        ADVANCEMENT_INSERT, {"actor": actor.id, "id": original.id}
                    )
                else:
                    await writer.execute(
                        RATING_INSERT,
                        {
                            "actor": actor.id,
                            "id": original.id,
                            "replacement": operation == "rating_replace",
                        },
                    )
            elif operation == "advancement":
                await replace_advancement(
                    writer,
                    fixture_id,
                    "a",
                    expected_current_id=original.id,
                    actor_account_id=actor.id,
                    reason="Reviewed replacement",
                    entry_id=original.entry_id,
                    official_result_ids=original.official_result_ids,
                )
            elif operation == "rating_replace":
                await replace_rating_input(
                    writer,
                    original.id,
                    actor_account_id=actor.id,
                    rating=1600,
                    note="Reviewed replacement",
                )
            else:
                await record_rating_input(
                    writer,
                    original.league_id,
                    original.player_id,
                    actor_account_id=actor.id,
                    rating=1600,
                    source="manual",
                    effective_at=original.effective_at,
                )

        async def suspend():
            await lifecycle.execute(
                text(
                    "UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"
                ),
                {"id": actor.id},
            )

        if first == "write":
            await write()
            pending = asyncio.create_task(suspend())
            try:
                await wait_for_blocked(db_session, lifecycle_pid, pending)
            finally:
                await writer.rollback()
                await pending
                await lifecycle.rollback()
        else:
            await suspend()
            if interface == "sql":
                with pytest.raises(
                    DBAPIError, match="actor is changing; retry"
                ) as error:
                    await write()
                assert error.value.orig.sqlstate == "40001"
                await writer.rollback()
                await lifecycle.rollback()
            else:
                pending = asyncio.create_task(write())
                try:
                    await wait_for_blocked(db_session, writer_pid, pending)
                    await lifecycle.commit()
                    with pytest.raises(ValueError, match="actor must be active"):
                        await pending
                finally:
                    await lifecycle.rollback()
                    await asyncio.gather(pending, return_exceptions=True)
                    await writer.rollback()


@pytest.mark.parametrize("erased", [False, True])
async def test_rating_history_replays_and_can_be_corrected_after_actor_lifecycle(
    db_session, default_league, erased
):
    from sqlalchemy import select

    from app.models import UserLeagueRating
    from app.ratings.inputs import rating_inputs, replace_rating_input
    from app.ratings.recompute import recompute_league_ratings

    actor, original = await rating_context(db_session, default_league)
    await make_inactive(db_session, actor.id, erased)
    await recompute_league_ratings(db_session, original.league_id, {original.player_id})
    await db_session.commit()
    projection = await db_session.scalar(
        select(UserLeagueRating).where(
            UserLeagueRating.league_id == original.league_id,
            UserLeagueRating.user_id == original.player_id,
        )
    )
    assert projection.rating_value == 1400
    reviewer = await make_user(db_session, "active-rating-reviewer")
    replacement = await replace_rating_input(
        db_session,
        original.id,
        actor_account_id=reviewer.id,
        rating=1500,
        note="Later review",
    )
    await db_session.commit()
    rows = await rating_inputs(db_session, original.league_id, original.player_id)
    assert [(row.id, row.actor_account_id) for row in rows] == [
        (original.id, actor.id),
        (replacement.id, reviewer.id),
    ]


@pytest.mark.parametrize("erased", [False, True])
async def test_advancement_keeps_system_root_and_original_manual_actor(
    db_session, erased
):
    from app.advancement_decisions import advancement_history, replace_advancement

    actor, original, fixture_id = await advancement_context(db_session)
    assert original.actor_account_id is None
    first_id = await replace_advancement(
        db_session,
        fixture_id,
        "a",
        expected_current_id=original.id,
        actor_account_id=actor.id,
        reason="First review",
        entry_id=original.entry_id,
        official_result_ids=original.official_result_ids,
    )
    await db_session.commit()
    await make_inactive(db_session, actor.id, erased)
    reviewer = await make_user(db_session, "active-advancement-reviewer")
    next_id = await replace_advancement(
        db_session,
        fixture_id,
        "a",
        expected_current_id=first_id,
        actor_account_id=reviewer.id,
        reason="Later review",
        entry_id=original.entry_id,
        official_result_ids=original.official_result_ids,
    )
    await db_session.commit()
    history = await advancement_history(db_session, fixture_id, "a")
    assert [(row.id, row.actor_account_id) for row in history] == [
        (original.id, None),
        (first_id, actor.id),
        (next_id, reviewer.id),
    ]
