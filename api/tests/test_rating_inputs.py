"""Durable rating inputs through the internal write and replay interfaces."""

from datetime import UTC, datetime

from sqlalchemy import delete, select

from app.leagues import get_default_league
from app.models import RatingHistory, UserLeagueRating
from app.ratings.recompute import recompute_league_ratings
from tests._helpers import make_user


async def test_adjustment_survives_projection_deletion_and_empty_replay(db_session):
    from app.ratings.inputs import rating_inputs, record_rating_input

    league = await get_default_league(db_session)
    player = await make_user(db_session, "durable-adjustment")
    adjustment = await record_rating_input(
        db_session,
        league.id,
        player.id,
        actor_account_id=player.id,
        rating=1600,
        source="manual",
        effective_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    await db_session.execute(delete(RatingHistory))
    await recompute_league_ratings(db_session, league.id, {player.id})
    current = await db_session.scalar(
        select(UserLeagueRating).where(
            UserLeagueRating.user_id == player.id,
            UserLeagueRating.league_id == league.id,
        )
    )
    assert current.rating_value == 1600
    assert current.rating_state == {
        **league.rating_strategy.initial_state,
        "rating": 1600,
    }
    assert [
        row.id for row in await rating_inputs(db_session, league.id, player.id)
    ] == [adjustment.id]


async def test_adjustment_between_matches_preserves_replayed_uncertainty(db_session):
    from app.ratings.glicko2 import CALCULATOR
    from app.ratings.inputs import record_rating_input
    from tests.test_rating_recompute import _build_completed_match

    league = await get_default_league(db_session)
    player = await make_user(db_session, "adjusted-player")
    opponent = await make_user(db_session, "adjusted-opponent")
    start = dict(league.rating_strategy.initial_state)
    first, other = CALCULATOR.update_singles(start, start)
    first["rating"] = 1600
    expected, _ = CALCULATOR.update_singles(first, other)
    await _build_completed_match(
        db_session, league, player, opponent, datetime(2026, 1, 1, tzinfo=UTC)
    )
    await _build_completed_match(
        db_session, league, player, opponent, datetime(2026, 1, 3, tzinfo=UTC)
    )
    await record_rating_input(
        db_session,
        league.id,
        player.id,
        actor_account_id=player.id,
        rating=1600,
        source="import",
        effective_at=datetime(2026, 1, 2, tzinfo=UTC),
    )
    current = await db_session.scalar(
        select(UserLeagueRating).where(
            UserLeagueRating.user_id == player.id,
            UserLeagueRating.league_id == league.id,
        )
    )
    assert current.rating_state == expected


async def test_replacement_preserves_original_slot_and_original_fact(db_session):
    from app.ratings.inputs import (
        rating_inputs,
        record_rating_input,
        replace_rating_input,
    )

    league = await get_default_league(db_session)
    player = await make_user(db_session, "replacement")
    at = datetime(2026, 1, 1, tzinfo=UTC)
    first = await record_rating_input(
        db_session,
        league.id,
        player.id,
        actor_account_id=player.id,
        rating=1600,
        source="manual",
        effective_at=at,
    )
    second = await record_rating_input(
        db_session,
        league.id,
        player.id,
        actor_account_id=player.id,
        rating=1700,
        source="import",
        effective_at=at,
    )
    replacement = await replace_rating_input(
        db_session,
        first.id,
        actor_account_id=player.id,
        rating=1550,
        note="Correct typo",
    )
    current = await db_session.scalar(
        select(UserLeagueRating).where(
            UserLeagueRating.user_id == player.id,
            UserLeagueRating.league_id == league.id,
        )
    )
    assert current.rating_value == 1700
    assert first.rating == 1600
    assert replacement.effective_at == first.effective_at
    assert replacement.supersedes_id == first.id
    assert {
        row.id for row in await rating_inputs(db_session, league.id, player.id)
    } == {first.id, second.id, replacement.id}


async def test_database_retains_inputs_and_rejects_dishonest_replacement(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.ratings.inputs import record_rating_input

    league = await get_default_league(db_session)
    player = await make_user(db_session, "immutable-input")
    original = await record_rating_input(
        db_session,
        league.id,
        player.id,
        actor_account_id=player.id,
        rating=1600,
        source="manual",
        effective_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    for statement in (
        "UPDATE rating_inputs SET rating = 1700 WHERE id = :id",
        "DELETE FROM rating_inputs WHERE id = :id",
        "INSERT INTO rating_inputs (league_id, player_id, actor_account_id, "
        "rating_strategy_id, rating, source, effective_at, supersedes_id) "
        "SELECT league_id, player_id, actor_account_id, rating_strategy_id, "
        "rating, source, effective_at + interval '1 day', id FROM "
        "rating_inputs WHERE id = :id",
    ):
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(text(statement), {"id": original.id})


async def test_merge_chain_combines_original_inputs_without_resetting_seed(db_session):
    from app.account_merge import merge_user
    from app.ratings.inputs import rating_inputs, record_rating_input

    league = await get_default_league(db_session)
    players = [
        await make_user(db_session, name)
        for name in ("merge-first", "merge-second", "merge-final")
    ]
    first = await record_rating_input(
        db_session,
        league.id,
        players[0].id,
        actor_account_id=players[0].id,
        rating=1600,
        source="manual",
        effective_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    second = await record_rating_input(
        db_session,
        league.id,
        players[1].id,
        actor_account_id=players[1].id,
        rating=1700,
        source="import",
        effective_at=datetime(2026, 2, 1, tzinfo=UTC),
    )
    await merge_user(db_session, from_user_id=players[0].id, to_user_id=players[1].id)
    await merge_user(db_session, from_user_id=players[1].id, to_user_id=players[2].id)
    await recompute_league_ratings(db_session, league.id, {players[2].id})
    current = await db_session.scalar(
        select(UserLeagueRating).where(
            UserLeagueRating.user_id == players[2].id,
            UserLeagueRating.league_id == league.id,
        )
    )
    assert current.rating_value == 1700
    assert first.player_id == players[0].id and first.actor_account_id == players[0].id
    assert (
        second.player_id == players[1].id and second.actor_account_id == players[1].id
    )
    assert {
        row.id for row in await rating_inputs(db_session, league.id, players[2].id)
    } == {first.id, second.id}


async def test_correction_replaces_projection_with_current_revision(db_session):
    from app.official_results import correct_result, official_history
    from app.result_proposal import propose_result
    from tests._helpers import directed_tournament_match
    from tests.test_official_results import board

    match, director = await directed_tournament_match(
        db_session, tag="rating-correction", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    original = (await official_history(db_session, match.id))[0]
    before = list(
        (
            await db_session.scalars(
                select(RatingHistory).where(RatingHistory.match_id == match.id)
            )
        ).all()
    )
    revised = await correct_result(
        db_session,
        match.id,
        director.id,
        expected_revision_id=original.id,
        games=board(2),
        reason="Reverse score",
    )
    after = list(
        (
            await db_session.scalars(
                select(RatingHistory).where(RatingHistory.match_id == match.id)
            )
        ).all()
    )
    assert len(after) == 2
    assert {row.id for row in before}.isdisjoint(row.id for row in after)
    assert all(row.official_result_id == revised.id for row in after)
    winner = min(match.sides, key=lambda side: side.side_number).players[0].user_id
    assert next(row.rating_value for row in after if row.user_id == winner) < 1500


async def test_original_formula_binding_survives_projection_deletion(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.result_proposal import propose_result
    from tests._helpers import directed_tournament_match
    from tests.test_official_results import board

    match, director = await directed_tournament_match(
        db_session, tag="formula-binding", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    strategy_id = match.league.rating_strategy_id
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE rating_strategies SET initial_state = '{\"rating\": 1800}' "
                    "WHERE id = :id"
                ),
                {"id": strategy_id},
            )
    before = {
        row.user_id: row.rating_state
        for row in (
            await db_session.scalars(
                select(RatingHistory).where(RatingHistory.match_id == match.id)
            )
        ).all()
    }
    await db_session.execute(delete(RatingHistory))
    await db_session.execute(delete(UserLeagueRating))
    await recompute_league_ratings(db_session, match.league_id, set(before))
    after = {
        row.user_id: row.rating_state
        for row in (
            await db_session.scalars(
                select(RatingHistory).where(RatingHistory.match_id == match.id)
            )
        ).all()
    }
    assert before == after
    assert (
        await db_session.scalar(
            text(
                "SELECT rating_strategy_id FROM match_rating_bases WHERE match_id = :id"
            ),
            {"id": match.id},
        )
        == strategy_id
    )


async def test_unsupported_formula_version_refuses_completion(
    db_session,
):
    import pytest

    from app.models import RatingStrategy
    from app.result_proposal import propose_result
    from tests._helpers import directed_tournament_match
    from tests.test_official_results import board

    match, director = await directed_tournament_match(
        db_session, tag="formula-unsupported", best_of=1
    )
    old = match.league.rating_strategy
    unsupported = RatingStrategy(
        key=old.key,
        version=999,
        name="Unavailable version",
        state_schema=old.state_schema,
        initial_state=old.initial_state,
        initial_rating_value=old.initial_rating_value,
        is_automatic=True,
    )
    db_session.add(unsupported)
    await db_session.flush()
    match.league.rating_strategy = unsupported
    # An unsupported version is refused before the first completion too.
    await db_session.commit()
    with pytest.raises(ValueError, match="Unsupported"):
        await propose_result(
            db_session, match.id, director.id, games=board(), supersedes_result_id=None
        )


async def test_failed_correction_cannot_be_committed_without_its_ratings(
    db_session, monkeypatch
):
    import pytest

    from app.official_results import correct_result, official_history
    from app.ratings.base import RatingStrategyKey
    from app.ratings.registry import STRATEGIES
    from app.result_proposal import propose_result
    from tests._helpers import directed_tournament_match
    from tests.test_official_results import board

    match, director = await directed_tournament_match(
        db_session, tag="atomic-replay", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    original = (await official_history(db_session, match.id))[0]
    match_id, actor, revision_id = match.id, director.id, original.id
    before = {
        row.user_id: row.rating_state
        for row in (
            await db_session.scalars(
                select(RatingHistory).where(RatingHistory.match_id == match_id)
            )
        ).all()
    }

    class UnavailableCalculator:
        key = RatingStrategyKey.glicko2

        def update_singles(self, winner, loser):
            raise ValueError("Historical calculator unavailable")

    monkeypatch.setitem(STRATEGIES, RatingStrategyKey.glicko2, UnavailableCalculator())
    with pytest.raises(ValueError, match="unavailable"):
        await correct_result(
            db_session,
            match_id,
            actor,
            expected_revision_id=revision_id,
            games=board(2),
            reason="Reverse score",
        )
    await db_session.commit()
    assert [row.id for row in await official_history(db_session, match_id)] == [
        revision_id
    ]
    after = {
        row.user_id: row.rating_state
        for row in (
            await db_session.scalars(
                select(RatingHistory).where(RatingHistory.match_id == match_id)
            )
        ).all()
    }
    assert after == before


async def test_projection_rejects_missing_provenance_and_disagreeing_value(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.result_proposal import propose_result
    from tests._helpers import directed_tournament_match
    from tests.test_official_results import board

    match, director = await directed_tournament_match(
        db_session, tag="projection-integrity", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    for statement in (
        "UPDATE rating_history SET official_result_id = NULL WHERE match_id = :id",
        "UPDATE rating_history SET rating_value = rating_value + 1 WHERE "
        "match_id = :id",
        "UPDATE rating_history SET rating_state = '{}' WHERE match_id = :id",
        "UPDATE rating_history SET rating_state = 'null' WHERE match_id = :id",
        "UPDATE rating_history SET source = 'manual', match_id = NULL, "
        "official_result_id = NULL WHERE match_id = :id",
        "UPDATE user_league_ratings SET rating_value = rating_value + 1 "
        "WHERE league_id = :league",
        "UPDATE user_league_ratings SET rating_state = NULL WHERE league_id = :league",
    ):
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(statement), {"id": match.id, "league": match.league_id}
                )


async def test_input_projection_cannot_claim_another_fact_or_actor(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.ratings.inputs import record_rating_input

    league = await get_default_league(db_session)
    player = await make_user(db_session, "input-owner")
    other = await make_user(db_session, "input-other")
    row = await record_rating_input(
        db_session,
        league.id,
        player.id,
        actor_account_id=other.id,
        rating=1600,
        source="import",
        effective_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    for statement in (
        "UPDATE rating_history SET created_by_user_id = :player "
        "WHERE rating_input_id = :id",
        "UPDATE rating_history SET user_id = :other WHERE rating_input_id = :id",
        "UPDATE rating_history SET source = 'manual' WHERE rating_input_id = :id",
    ):
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(statement),
                    {"id": row.id, "player": player.id, "other": other.id},
                )


async def test_official_void_replays_inputs_and_removes_match_influence(db_session):
    from app.official_results import official_history, void_official_match
    from app.ratings.inputs import rating_inputs, record_rating_input
    from app.result_proposal import propose_result
    from tests._helpers import directed_tournament_match
    from tests.test_official_results import board

    match, director = await directed_tournament_match(
        db_session, tag="void-input", best_of=1
    )
    player = min(match.sides, key=lambda side: side.side_number).players[0].user_id
    row = await record_rating_input(
        db_session,
        match.league_id,
        player,
        actor_account_id=director.id,
        rating=1600,
        source="manual",
        effective_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    await void_official_match(db_session, match.id, director.id, reason="Duplicate")
    current = await db_session.scalar(
        select(UserLeagueRating).where(
            UserLeagueRating.user_id == player,
            UserLeagueRating.league_id == match.league_id,
        )
    )
    assert current.rating_value == 1600
    assert len(await official_history(db_session, match.id)) == 1
    assert [
        item.id for item in await rating_inputs(db_session, match.league_id, player)
    ] == [row.id]
    assert not list(
        (
            await db_session.scalars(
                select(RatingHistory).where(RatingHistory.match_id == match.id)
            )
        ).all()
    )


async def test_replay_uses_official_score_instead_of_compatibility_winner(db_session):
    from sqlalchemy import text

    from app.result_proposal import propose_result
    from tests._helpers import directed_tournament_match
    from tests.test_official_results import board

    match, director = await directed_tournament_match(
        db_session, tag="source-score", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    before = {
        row.user_id: row.rating_state
        for row in (
            await db_session.scalars(
                select(RatingHistory).where(RatingHistory.match_id == match.id)
            )
        ).all()
    }
    await db_session.execute(
        text("UPDATE match_sides SET won = NOT won WHERE match_id = :id"),
        {"id": match.id},
    )
    for side in match.sides:
        await db_session.refresh(side, ["won"])
    await recompute_league_ratings(db_session, match.league_id, set(before))
    after = {
        row.user_id: row.rating_state
        for row in (
            await db_session.scalars(
                select(RatingHistory).where(RatingHistory.match_id == match.id)
            )
        ).all()
    }
    assert after == before


async def test_history_orders_same_time_inputs_by_recorded_slot(db_session):
    from datetime import timedelta

    from app.ratings.history import player_rating_history
    from app.ratings.inputs import record_rating_input

    league = await get_default_league(db_session)
    player = await make_user(db_session, "input-order")
    at = datetime(2026, 1, 1, tzinfo=UTC)
    for rating in (1600, 1700):
        await record_rating_input(
            db_session,
            league.id,
            player.id,
            actor_account_id=player.id,
            rating=rating,
            source="manual",
            effective_at=at,
        )
    rows = list(
        (
            await db_session.scalars(
                select(RatingHistory)
                .where(RatingHistory.user_id == player.id)
                .order_by(RatingHistory.rating_value.desc())
            )
        ).all()
    )
    snapshots = [
        {
            column.name: getattr(row, column.name)
            for column in RatingHistory.__table__.columns
            if column.name != "id"
        }
        for row in rows
    ]
    await db_session.execute(
        delete(RatingHistory).where(RatingHistory.user_id == player.id)
    )
    # Physical insertion order is not the effective order of immutable inputs.
    for snapshot in snapshots:
        db_session.add(RatingHistory(**snapshot))
        await db_session.flush()
    history = await player_rating_history(
        db_session, player.id, league.id, "30d", now=at + timedelta(days=1)
    )
    assert [point.rating for point in history.points] == [1600, 1700]


async def test_database_refuses_nonfinite_immutable_input(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.ratings.inputs import record_rating_input

    league = await get_default_league(db_session)
    player = await make_user(db_session, "finite-input")
    row = await record_rating_input(
        db_session,
        league.id,
        player.id,
        actor_account_id=player.id,
        rating=1600,
        source="manual",
        effective_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    for value in ("NaN", "Infinity", "-Infinity"):
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(
                    text("""
                    INSERT INTO rating_inputs(league_id, player_id, actor_account_id,
                        rating_strategy_id, source, effective_at, rating)
                    SELECT league_id, player_id, actor_account_id, rating_strategy_id,
                        source, effective_at, CAST(:value AS float8)
                    FROM rating_inputs WHERE id = :id
                """),
                    {"id": row.id, "value": float(value)},
                )


async def test_adjustment_at_match_time_is_reported_as_its_starting_rating(db_session):
    from app.player_matches import _load_match_rating_changes
    from app.ratings.inputs import record_rating_input
    from app.result_proposal import propose_result
    from tests._helpers import directed_tournament_match
    from tests.test_official_results import board

    match, director = await directed_tournament_match(
        db_session, tag="same-time-input", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    player = min(match.sides, key=lambda side: side.side_number).players[0].user_id
    await record_rating_input(
        db_session,
        match.league_id,
        player,
        actor_account_id=director.id,
        rating=1600,
        source="manual",
        effective_at=match.completed_at,
    )
    changes = await _load_match_rating_changes(db_session, player, [match.id])
    assert changes[match.id].before == 1600
    from app.repositories.match_details_repository import MatchDetailsRepository

    snapshots = await MatchDetailsRepository(db_session).pre_match_ratings(
        [player], match.league_id, match.completed_at
    )
    assert snapshots[player].value == 1600


async def test_background_replay_discovers_durable_inputs_after_snapshots_deleted(
    db_session, engine, monkeypatch
):
    from app.ratings import jobs
    from app.ratings.inputs import record_rating_input

    league = await get_default_league(db_session)
    player = await make_user(db_session, "job-input-only")
    await record_rating_input(
        db_session,
        league.id,
        player.id,
        actor_account_id=player.id,
        rating=1600,
        source="manual",
        effective_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    await db_session.execute(delete(RatingHistory))
    await db_session.execute(delete(UserLeagueRating))
    await db_session.commit()
    monkeypatch.setattr(jobs, "get_engine", lambda: engine)
    await jobs._recompute_after_merge(player.id)
    current = await db_session.scalar(
        select(UserLeagueRating).where(
            UserLeagueRating.user_id == player.id,
            UserLeagueRating.league_id == league.id,
        )
    )
    assert current is not None and current.rating_value == 1600
