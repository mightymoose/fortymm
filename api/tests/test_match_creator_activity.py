"""Fresh standalone match attribution requires a live creating Account."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.identity_lifecycle import deactivate_account, erase_account
from app.models import MatchSettings
from tests._helpers import make_user


@pytest.mark.parametrize("lifecycle", [deactivate_account, erase_account])
async def test_sql_standalone_match_rejects_inactive_creator(
    db_session, default_league, lifecycle
):
    actor = await make_user(db_session, "inactive-sql-match-creator")
    rules = MatchSettings(team_size=1, best_of=1, affects_rating=False)
    db_session.add(rules)
    await db_session.commit()
    actor_id, rules_id = actor.id, rules.id
    await lifecycle(db_session, actor_id)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="match creator must be active"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO matches"
                    "(match_settings_id,league_id,created_by_user_id) "
                    "VALUES(:rules,:league,:actor)"
                ),
                {"rules": rules_id, "league": default_league.id, "actor": actor_id},
            )


@pytest.mark.parametrize("first", ["create", "suspend"])
async def test_sql_match_creation_serializes_with_creator_suspension(
    db_session, engine, default_league, first
):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from tests.test_proposal_history import wait_for_blocked

    actor = await make_user(db_session, "racing-sql-match-creator")
    rules = MatchSettings(team_size=1, best_of=1, affects_rating=False)
    db_session.add(rules)
    await db_session.commit()
    parameters = {"rules": rules.id, "league": default_league.id, "actor": actor.id}
    insert = text(
        "INSERT INTO matches(match_settings_id,league_id,created_by_user_id) "
        "VALUES(:rules,:league,:actor)"
    )
    suspend = text("UPDATE accounts SET deactivated_at=now() WHERE id=:actor")
    factory = async_sessionmaker(engine)
    async with factory() as writer, factory() as lifecycle:
        writer_pid = await writer.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))
        if first == "suspend":
            await lifecycle.execute(suspend, parameters)
            pending = asyncio.create_task(writer.execute(insert, parameters))
            try:
                await wait_for_blocked(lifecycle, writer_pid, pending)
                await lifecycle.commit()
                with pytest.raises(
                    IntegrityError, match="match creator must be active"
                ):
                    await pending
            finally:
                await lifecycle.rollback()
                await asyncio.gather(pending, return_exceptions=True)
        else:
            await writer.execute(insert, parameters)
            pending = asyncio.create_task(lifecycle.execute(suspend, parameters))
            try:
                await wait_for_blocked(writer, lifecycle_pid, pending)
                await writer.commit()
                await pending
                await lifecycle.commit()
            finally:
                await writer.rollback()
                await asyncio.gather(pending, return_exceptions=True)


async def test_retained_match_does_not_reauthorize_its_historical_creator(
    db_session, default_league
):
    actor = await make_user(db_session, "historical-match-creator")
    rules = MatchSettings(team_size=1, best_of=1, affects_rating=False)
    db_session.add(rules)
    await db_session.flush()
    match_id = await db_session.scalar(
        text(
            "INSERT INTO matches(match_settings_id,league_id,created_by_user_id) "
            "VALUES(:rules,:league,:actor) RETURNING id"
        ),
        {"rules": rules.id, "league": default_league.id, "actor": actor.id},
    )
    await db_session.commit()
    await deactivate_account(db_session, actor.id)
    await db_session.commit()
    await db_session.execute(
        text(
            "UPDATE matches SET status='in_progress', "
            "created_by_user_id=created_by_user_id "
            "WHERE id=:id"
        ),
        {"id": match_id},
    )
    await db_session.commit()


async def test_materialization_retains_inactive_owner_attribution_and_frozen_rules(
    db_session, default_league
):
    from app.models import TournamentStatus
    from app.tournament_draws import cut_draw
    from app.tournament_materialization import materialize_event
    from tests.test_tournament_lifecycle import _enter, _make_tournament_at, _one_event

    owner = await make_user(db_session, "historical-materialization-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    await _enter(db_session, event, 4)
    await cut_draw(db_session, event)
    await db_session.commit()
    await deactivate_account(db_session, owner.id)
    await db_session.commit()
    await materialize_event(db_session, tournament, event)
    await db_session.commit()
    match_id = await db_session.scalar(
        text("SELECT id FROM matches WHERE created_by_user_id=:actor LIMIT 1"),
        {"actor": owner.id},
    )
    assert match_id is not None
    standalone = MatchSettings(team_size=1, best_of=1, affects_rating=False)
    db_session.add(standalone)
    await db_session.flush()
    with pytest.raises(IntegrityError, match="match rules reference is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE matches SET match_settings_id=:rules WHERE id=:match"),
                {"rules": standalone.id, "match": match_id},
            )


async def test_fresh_alembic_install_enforces_standalone_creator_activity(postgres_url):
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from tests._migration_database import migrated_database

    async with migrated_database(postgres_url) as engine:
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            actor = await make_user(db, "migrated-match-creator")
            rules = MatchSettings(team_size=1, best_of=1, affects_rating=False)
            db.add(rules)
            await db.commit()
            await deactivate_account(db, actor.id)
            await db.commit()
            with pytest.raises(IntegrityError, match="match creator must be active"):
                await db.execute(
                    text(
                        "INSERT INTO matches"
                        "(match_settings_id,league_id,created_by_user_id) "
                        "VALUES(:rules,"
                        "(SELECT id FROM leagues WHERE is_default),:actor)"
                    ),
                    {"rules": rules.id, "actor": actor.id},
                )
