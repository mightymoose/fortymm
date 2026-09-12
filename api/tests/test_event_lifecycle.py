"""Lifecycle integrity through persisted sporting writes."""

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import League, TournamentFixture, TournamentStatus
from app.tournament_draws import cut_draw
from app.tournament_lifecycle import transition_tournament
from app.tournament_queries import stage_ids_for_events
from tests._helpers import make_user
from tests.test_tournament_lifecycle import _enter, _make_tournament_at, _one_event


async def test_first_recorded_score_starts_event_without_fabricating_actual_start(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "event-history-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    event_id = event.id
    await _enter(db_session, event, 2)
    await cut_draw(db_session, event)
    await db_session.commit()
    await transition_tournament(
        db_session, tournament_id=tournament.id, actor=owner, to=TournamentStatus.live
    )
    before = (
        await db_session.execute(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
    ).scalar_one()
    assert before == "unstarted"
    fixture = (
        await db_session.scalars(
            select(TournamentFixture).where(
                TournamentFixture.stage_id.in_(stage_ids_for_events([event_id]))
            )
        )
    ).first()
    assert fixture is not None
    game_id = await db_session.scalar(
        text(
            "INSERT INTO match_games (match_id, game_number) VALUES (:id, 1) "
            "RETURNING id"
        ),
        {"id": fixture.match_id},
    )
    await db_session.execute(
        text(
            "INSERT INTO match_game_scores (match_game_id, side_1_points, "
            "side_2_points) VALUES (:id,11,7)"
        ),
        {"id": game_id},
    )
    row = (
        await db_session.execute(
            text(
                "SELECT lifecycle_state, first_recorded_play_at, started_at, "
                "lifecycle_version FROM tournament_events WHERE id=:id"
            ),
            {"id": event_id},
        )
    ).one()
    assert row.lifecycle_state == "in_progress"
    assert row.first_recorded_play_at is not None
    assert row.started_at is None
    assert row.lifecycle_version == 1
    await db_session.execute(
        text("DELETE FROM match_game_scores WHERE match_game_id=:id"), {"id": game_id}
    )
    assert (
        await db_session.execute(
            text("SELECT first_recorded_play_at FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
    ).scalar_one() == row.first_recorded_play_at


async def test_lifecycle_transition_is_versioned_and_history_cannot_be_rewritten(
    db_session: AsyncSession, default_league: League
) -> None:
    import pytest
    from sqlalchemy.exc import IntegrityError

    owner = await make_user(db_session, "event-ledger-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    event_id = event.id
    await db_session.execute(
        text("UPDATE tournament_events SET lifecycle_state='cancelled' WHERE id=:id"),
        {"id": event_id},
    )
    row = (
        await db_session.execute(
            text(
                "SELECT from_state, to_state, version, observed_at, occurred_at "
                "FROM tournament_event_lifecycle_history WHERE event_id=:id"
            ),
            {"id": event_id},
        )
    ).one()
    assert (row.from_state, row.to_state, row.version) == ("unstarted", "cancelled", 1)
    assert row.observed_at is not None
    assert row.occurred_at == row.observed_at
    await db_session.commit()
    for statement in (
        (
            "UPDATE tournament_event_lifecycle_history SET to_state='finished'"
            " WHERE event_id=:id"
        ),
        "DELETE FROM tournament_event_lifecycle_history WHERE event_id=:id",
        "UPDATE tournament_events SET lifecycle_state='in_progress' WHERE id=:id",
        "UPDATE tournament_events SET lifecycle_version=9 WHERE id=:id",
        "DELETE FROM tournament_events WHERE id=:id",
    ):
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(text(statement), {"id": event_id})


async def test_final_result_finishes_event_and_void_reopens_with_history(db_session):
    from app.official_results import void_official_match
    from app.result_proposal import propose_result
    from tests._helpers import directed_tournament_match
    from tests.test_official_results import board

    match, director = await directed_tournament_match(
        db_session, tag="lifecycle-finish", best_of=1
    )
    event_id = await db_session.scalar(
        text("SELECT scope_event_id FROM tournament_fixtures WHERE match_id=:id"),
        {"id": match.id},
    )
    # A voided RR pairing is excluded by the existing completeness rules; a
    # knockout final instead becomes incomplete, so it is the reopening case.
    await db_session.execute(
        text(
            "UPDATE tournament_events SET draw_type_id=(SELECT id FROM "
            "draw_types WHERE key='single-elim') WHERE id=:id"
        ),
        {"id": event_id},
    )
    await db_session.execute(
        text(
            "UPDATE tournament_event_stages SET draw_type_id=(SELECT id FROM "
            "draw_types WHERE key='single-elim') WHERE event_id=:id"
        ),
        {"id": event_id},
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "finished"
    )
    await void_official_match(
        db_session, match.id, director.id, reason="Incorrect fixture result"
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "in_progress"
    )
    states = (
        (
            await db_session.execute(
                text(
                    (
                        "SELECT to_state FROM tournament_event_lifecycle_history WHERE "
                        "event_id=:id ORDER BY version"
                    )
                ),
                {"id": event_id},
            )
        )
        .scalars()
        .all()
    )
    assert states == ["in_progress", "finished", "in_progress"]


async def test_cancel_stops_new_games_but_preserves_score_corrections(db_session):
    import pytest

    from app.event_lifecycle import cancel_event
    from app.match_errors import ScoreNotAllowedError
    from app.match_scoring import delete_game_score, enter_game_score, update_game_score
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="lifecycle-cancel", best_of=3
    )
    event_id, tournament_id = (
        await db_session.execute(
            text(
                "SELECT scope_event_id, scope_tournament_id FROM "
                "tournament_fixtures WHERE match_id=:id"
            ),
            {"id": match.id},
        )
    ).one()
    await enter_game_score(
        db_session,
        match.id,
        director.id,
        game_number=1,
        side_1_points=11,
        side_2_points=6,
    )
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=director
    )
    await db_session.commit()
    with pytest.raises(ScoreNotAllowedError, match="cancelled"):
        await enter_game_score(
            db_session,
            match.id,
            director.id,
            game_number=2,
            side_1_points=11,
            side_2_points=8,
        )
    await update_game_score(
        db_session,
        match.id,
        director.id,
        game_number=1,
        side_1_points=11,
        side_2_points=8,
        expected_version=1,
    )
    await delete_game_score(db_session, match.id, director.id, game_number=1)
    await enter_game_score(
        db_session,
        match.id,
        director.id,
        game_number=1,
        side_1_points=11,
        side_2_points=9,
    )
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "cancelled"
    )


async def test_sql_cannot_forge_or_erase_recorded_play_and_cancelled_new_game(
    db_session,
):
    import pytest
    from sqlalchemy.exc import IntegrityError

    from tests._helpers import directed_tournament_match

    match, _ = await directed_tournament_match(
        db_session, tag="lifecycle-integrity", best_of=3
    )
    event_id = await db_session.scalar(
        text("SELECT scope_event_id FROM tournament_fixtures WHERE match_id=:id"),
        {"id": match.id},
    )
    for statement in (
        "UPDATE tournament_events SET first_recorded_play_at=now() WHERE id=:id",
        "UPDATE tournament_events SET lifecycle_version=-1 WHERE id=:id",
        "UPDATE tournament_events SET started_at=now() WHERE id=:id",
    ):
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(text(statement), {"id": event_id})
    await db_session.execute(
        text("UPDATE tournament_events SET lifecycle_state='cancelled' WHERE id=:id"),
        {"id": event_id},
    )
    game_id = await db_session.scalar(
        text(
            "INSERT INTO match_games(match_id, game_number) VALUES (:id,1) RETURNING id"
        ),
        {"id": match.id},
    )
    with pytest.raises(IntegrityError, match="cancelled"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO "
                    "match_game_scores(match_game_id,side_1_points,side_2_points) "
                    "VALUES (:id,11,7)"
                ),
                {"id": game_id},
            )
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO "
                    "tournament_event_recorded_games"
                    "(match_id,game_number,event_id) "
                    "VALUES (:match,1,:event)"
                ),
                {"match": match.id, "event": event_id},
            )


async def test_cancelled_event_refuses_entry_and_domain_deletion(
    db_session, default_league
):
    import pytest

    from app.event_lifecycle import cancel_event
    from app.tournament_entries import enter_event
    from app.tournament_errors import EntryRefusedError, RecordedPlayDeletionError
    from app.tournament_events import delete_event

    owner = await make_user(db_session, "cancel-entry-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    await cancel_event(
        db_session, tournament_id=tournament.id, event_id=event.id, actor=owner
    )
    await db_session.commit()
    with pytest.raises(EntryRefusedError, match="cancelled"):
        await enter_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event.id,
            actor=owner,
            user_id=None,
        )
    with pytest.raises(RecordedPlayDeletionError):
        await delete_event(
            db_session, tournament_id=tournament.id, event_id=event.id, actor=owner
        )


async def test_attaching_previously_scored_match_observes_play_without_guessing_start(
    api_client, db_session
):
    from tests._helpers import attach_match_to_director_tournament, start_session

    player = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "attachment-opponent")
    response = await api_client.post(
        "/v1/matches",
        json={"opponent_user_id": str(opponent.id), "best_of": 3, "rated": False},
    )
    assert response.status_code == 201
    match_id = response.json()["id"]
    score = await api_client.post(
        f"/v1/matches/{match_id}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 7},
    )
    assert score.status_code == 201, score.text
    import uuid

    await attach_match_to_director_tournament(
        db_session,
        uuid.UUID(match_id),
        tag="attachment-history",
        director=player,
        p1=player,
        p2=opponent,
        best_of=3,
        rated=False,
    )
    state, observation, actual = (
        await db_session.execute(
            text(
                "SELECT e.lifecycle_state, e.first_recorded_play_at,e.started_at "
                "FROM tournament_events e JOIN tournament_fixtures f ON "
                "f.scope_event_id=e.id WHERE f.match_id=:id"
            ),
            {"id": uuid.UUID(match_id)},
        )
    ).one()
    assert state == "in_progress"
    assert observation is not None
    assert actual is None


async def test_known_start_is_explicit_and_chronological_while_finish_can_have_no_play(
    db_session, default_league
):
    import pytest
    from sqlalchemy.exc import IntegrityError

    from app.event_lifecycle import reconcile_event

    owner = await make_user(db_session, "known-event-time")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    event_id = event.id
    await db_session.execute(
        text("UPDATE tournament_events SET lifecycle_state='finished' WHERE id=:id"),
        {"id": event_id},
    )
    assert (
        await db_session.scalar(
            text("SELECT first_recorded_play_at FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        is None
    )
    await reconcile_event(db_session, event_id)
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "in_progress"
    )
    # A separate explicitly known start may be seeded at its first transition.
    other = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
        with_event=True,
    )
    other_event = await _one_event(db_session, other.id)
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_events SET lifecycle_state='in_progress', "
                    "started_at=now()+interval '1 day' WHERE id=:id"
                ),
                {"id": other_event.id},
            )
    await db_session.execute(
        text(
            "UPDATE tournament_events SET lifecycle_state='in_progress', "
            "started_at=now()-interval '1 hour' WHERE id=:id"
        ),
        {"id": other_event.id},
    )
    actual, observed = (
        await db_session.execute(
            text(
                "SELECT occurred_at,observed_at FROM "
                "tournament_event_lifecycle_history WHERE event_id=:id"
            ),
            {"id": other_event.id},
        )
    ).one()
    assert actual is not None and actual < observed


async def test_cancelled_new_result_is_refused_before_any_board_is_written(db_session):
    import pytest

    from app.event_lifecycle import cancel_event
    from app.match_errors import MatchClosedError
    from app.result_proposal import propose_result
    from tests._helpers import directed_tournament_match
    from tests.test_official_results import board

    match, director = await directed_tournament_match(
        db_session, tag="cancel-proposal", best_of=1
    )
    event_id, tournament_id = (
        await db_session.execute(
            text(
                "SELECT scope_event_id, scope_tournament_id FROM "
                "tournament_fixtures WHERE match_id=:id"
            ),
            {"id": match.id},
        )
    ).one()
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=director
    )
    await db_session.commit()
    with pytest.raises(MatchClosedError, match="cancelled"):
        await propose_result(
            db_session, match.id, director.id, games=board(), supersedes_result_id=None
        )
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM match_games WHERE match_id=:id"),
            {"id": match.id},
        )
        == 0
    )


async def test_http_score_starts_only_its_event_and_cancelled_new_entry_sql_is_refused(
    api_client, db_session
):
    import uuid

    import pytest
    from sqlalchemy.exc import IntegrityError

    from app.models import TournamentEvent
    from tests._helpers import attach_match_to_director_tournament, start_session

    player = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "independent-opponent")
    response = await api_client.post(
        "/v1/matches",
        json={"opponent_user_id": str(opponent.id), "best_of": 3, "rated": False},
    )
    match_id = uuid.UUID(response.json()["id"])
    await attach_match_to_director_tournament(
        db_session,
        match_id,
        tag="independent-events",
        director=player,
        p1=player,
        p2=opponent,
        best_of=3,
        rated=False,
    )
    event_id, tournament_id = (
        await db_session.execute(
            text(
                "SELECT scope_event_id,scope_tournament_id FROM "
                "tournament_fixtures WHERE match_id=:id"
            ),
            {"id": match_id},
        )
    ).one()
    original = await db_session.get(TournamentEvent, event_id)
    sibling = TournamentEvent(
        tournament_id=tournament_id,
        name="Later event",
        format=original.format,
        draw_settings=original.draw_settings,
        entry_fee=0,
        timezone=original.timezone,
        slot=original.slot,
        match_settings=original.match_settings,
    )
    db_session.add(sibling)
    await db_session.commit()
    score = await api_client.post(
        f"/v1/matches/{match_id}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 7},
    )
    assert score.status_code == 201, score.text
    states = dict(
        (
            await db_session.execute(
                text(
                    (
                        "SELECT id,lifecycle_state FROM tournament_events WHERE "
                        "tournament_id=:id"
                    )
                ),
                {"id": tournament_id},
            )
        ).all()
    )
    assert states == {event_id: "in_progress", sibling.id: "unstarted"}
    await db_session.execute(
        text("UPDATE tournament_events SET lifecycle_state='cancelled' WHERE id=:id"),
        {"id": sibling.id},
    )
    with pytest.raises(IntegrityError, match="cancelled"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("INSERT INTO tournament_entries(event_id) VALUES (:event)"),
                {"event": sibling.id, "player": player.player_id},
            )


async def test_cancelled_official_correction_can_expand_board_without_enabling_new_play(
    db_session,
):
    import pytest
    from sqlalchemy.exc import IntegrityError

    from app.event_lifecycle import cancel_event
    from app.models import TournamentFixture
    from app.official_results import correct_result
    from app.result_proposal import propose_result
    from app.schemas.match import MatchResultsGameWrite
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="cancel-correction", best_of=5
    )
    fixture = await db_session.scalar(
        select(TournamentFixture).where(TournamentFixture.match_id == match.id)
    )
    db_session.add(
        TournamentFixture(
            stage_id=fixture.stage_id,
            group_id=fixture.group_id,
            round=2,
            position=1,
            entry_a_id=fixture.entry_a_id,
            entry_b_id=fixture.entry_b_id,
        )
    )
    await db_session.commit()
    games = [
        MatchResultsGameWrite(game_number=n, side_1_points=11, side_2_points=5)
        for n in range(1, 4)
    ]
    result = await propose_result(
        db_session, match.id, director.id, games=games, supersedes_result_id=None
    )
    await cancel_event(
        db_session,
        tournament_id=fixture.scope_tournament_id,
        event_id=fixture.scope_event_id,
        actor=director,
    )
    await db_session.commit()
    expanded = [
        MatchResultsGameWrite(game_number=1, side_1_points=5, side_2_points=11)
    ] + [
        MatchResultsGameWrite(game_number=n, side_1_points=11, side_2_points=5)
        for n in range(2, 5)
    ]
    await correct_result(
        db_session,
        match.id,
        director.id,
        expected_revision_id=result.match.current_official_result_id,
        reason="Correct recorded board",
        games=expanded,
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": fixture.scope_event_id},
        )
        == "cancelled"
    )
    game_id = await db_session.scalar(
        text(
            "INSERT INTO match_games(match_id,game_number) VALUES (:id,5) RETURNING id"
        ),
        {"id": match.id},
    )
    with pytest.raises(IntegrityError, match="cancelled"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO "
                    "match_game_scores(match_game_id,side_1_points,side_2_points) "
                    "VALUES (:id,11,4)"
                ),
                {"id": game_id},
            )


async def test_cancelled_standing_result_can_be_countered_with_a_longer_board(
    db_session,
):
    from app.event_lifecycle import cancel_event
    from app.result_proposal import propose_result
    from app.schemas.match import MatchResultsGameWrite
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="cancel-counter", best_of=3
    )
    participants = sorted(match.sides, key=lambda side: side.side_number)
    games = [
        MatchResultsGameWrite(game_number=n, side_1_points=11, side_2_points=5)
        for n in (1, 2)
    ]
    result = await propose_result(
        db_session,
        match.id,
        participants[0].players[0].user_id,
        games=games,
        supersedes_result_id=None,
    )
    event_id, tournament_id = (
        await db_session.execute(
            text(
                "SELECT scope_event_id,scope_tournament_id FROM "
                "tournament_fixtures WHERE match_id=:id"
            ),
            {"id": match.id},
        )
    ).one()
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=director
    )
    await db_session.commit()
    expanded = [
        games[0],
        MatchResultsGameWrite(game_number=2, side_1_points=5, side_2_points=11),
        MatchResultsGameWrite(game_number=3, side_1_points=11, side_2_points=5),
    ]
    corrected = await propose_result(
        db_session,
        match.id,
        participants[1].players[0].user_id,
        games=expanded,
        supersedes_result_id=result.match.results[0].id,
    )
    assert corrected.awaiting_acceptance
    assert len(corrected.match.games) == 3
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "cancelled"
    )


async def test_cancellation_serializes_with_new_score_and_loser_leaves_no_play(
    engine, db_session
):
    import asyncio

    import pytest
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from tests._helpers import directed_tournament_match

    match, _ = await directed_tournament_match(db_session, tag="cancel-race", best_of=3)
    match_id = match.id
    event_id = await db_session.scalar(
        text("SELECT scope_event_id FROM tournament_fixtures WHERE match_id=:id"),
        {"id": match_id},
    )
    game_id = await db_session.scalar(
        text(
            "INSERT INTO match_games(match_id,game_number) VALUES (:id,1) RETURNING id"
        ),
        {"id": match_id},
    )
    await db_session.commit()
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as gate, factory() as scorer:
        await gate.execute(
            text(
                "UPDATE tournament_events SET lifecycle_state='cancelled' WHERE id=:id"
            ),
            {"id": event_id},
        )
        pid = await scorer.scalar(text("SELECT pg_backend_pid()"))
        task = asyncio.create_task(
            scorer.execute(
                text(
                    "INSERT INTO "
                    "match_game_scores(match_game_id,side_1_points,side_2_points) "
                    "VALUES (:id,11,6)"
                ),
                {"id": game_id},
            )
        )
        try:
            async with asyncio.timeout(5):
                while not await db_session.scalar(
                    text(
                        "SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE "
                        "pid=:pid"
                    ),
                    {"pid": pid},
                ):
                    assert not task.done(), "new scoring must wait for cancellation"
                    await asyncio.sleep(0.01)
            await gate.commit()
            with pytest.raises(IntegrityError, match="cancelled"):
                await task
            await scorer.rollback()
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    assert (
        await db_session.scalar(
            text("SELECT first_recorded_play_at FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        is None
    )
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM match_game_scores WHERE match_game_id=:id"),
            {"id": game_id},
        )
        == 0
    )


async def test_sql_cannot_move_recorded_scores_or_relabel_cleared_games(db_session):
    import pytest
    from sqlalchemy.exc import IntegrityError

    from app.match_scoring import enter_game_score
    from tests._helpers import directed_tournament_match

    source, director = await directed_tournament_match(
        db_session, tag="identity-source", best_of=5
    )
    target, _ = await directed_tournament_match(
        db_session, tag="identity-target", best_of=5
    )
    await enter_game_score(
        db_session,
        source.id,
        director.id,
        game_number=1,
        side_1_points=11,
        side_2_points=7,
    )
    source_game = await db_session.scalar(
        text("SELECT id FROM match_games WHERE match_id=:id AND game_number=1"),
        {"id": source.id},
    )
    target_game = await db_session.scalar(
        text(
            "INSERT INTO match_games(match_id,game_number) VALUES (:id,2) RETURNING id"
        ),
        {"id": target.id},
    )
    for statement, parameters in (
        (
            "UPDATE match_game_scores SET match_game_id=:target "
            "WHERE match_game_id=:source",
            {"source": source_game, "target": target_game},
        ),
        (
            "UPDATE match_games SET match_id=:target WHERE id=:source",
            {"source": source_game, "target": target.id},
        ),
        (
            "UPDATE match_games SET game_number=3 WHERE id=:source",
            {"source": source_game},
        ),
    ):
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(text(statement), parameters)
    await db_session.execute(
        text("DELETE FROM match_game_scores WHERE match_game_id=:id"),
        {"id": source_game},
    )
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE match_games SET game_number=3 WHERE id=:id"),
                {"id": source_game},
            )


async def test_cancelled_sql_proposal_cannot_introduce_unrecorded_play(db_session):
    import pytest
    from sqlalchemy.exc import IntegrityError

    from app.event_lifecycle import cancel_event
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="cancel-sql-proposal", best_of=1
    )
    event_id, tournament_id = (
        await db_session.execute(
            text(
                "SELECT scope_event_id,scope_tournament_id "
                "FROM tournament_fixtures WHERE match_id=:id"
            ),
            {"id": match.id},
        )
    ).one()
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=director
    )
    player = min(match.sides, key=lambda side: side.side_number).players[0].user_id
    with pytest.raises(IntegrityError, match="cancelled"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO match_results "
                    "(match_id,submitted_by_user_id,submitted_for_player_id,games) "
                    "VALUES (:match,:actor,:player, CAST(:games AS jsonb))"
                ),
                {
                    "match": match.id,
                    "actor": match.created_by_user_id,
                    "player": player,
                    "games": (
                        '[ {"game_number":1,"side_1_points":11,"side_2_points":7} ]'
                    ),
                },
            )
