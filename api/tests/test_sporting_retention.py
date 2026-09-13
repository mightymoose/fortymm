"""Normal SQL and backend operations retain sporting facts on migrated schemas."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.models import TournamentEntry, TournamentStatus
from tests._helpers import make_user
from tests.test_tournament_lifecycle import _make_tournament_at, _one_event


@pytest.mark.parametrize(
    "table", ["tournament_entries", "tournament_events", "tournaments"]
)
async def test_registration_protects_itself_and_its_parents(
    db_session, default_league, table
):
    owner = await make_user(db_session, "registered-draft-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.draft,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    entry = TournamentEntry(event_id=event.id, user_id=owner.player_id)
    db_session.add(entry)
    await db_session.commit()
    identity = {
        "tournament_entries": entry.id,
        "tournament_events": event.id,
        "tournaments": tournament.id,
    }[table]
    with pytest.raises(IntegrityError, match="history"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(f"DELETE FROM {table} WHERE id=:id"), {"id": identity}
            )


@pytest.mark.parametrize("parent", ["event", "tournament"])
async def test_registered_parent_deletion_reports_domain_conflict(
    db_session, default_league, parent
):
    from app.tournament_errors import RecordedPlayDeletionError
    from app.tournament_events import delete_event
    from app.tournament_lifecycle import delete_tournament

    owner = await make_user(db_session, "registered-owner-conflict")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.draft,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    db_session.add(TournamentEntry(event_id=event.id, user_id=owner.player_id))
    await db_session.commit()
    with pytest.raises(RecordedPlayDeletionError, match="Registration history"):
        if parent == "event":
            await delete_event(
                db_session, tournament_id=tournament.id, event_id=event.id, actor=owner
            )
        else:
            await delete_tournament(
                db_session, tournament_id=tournament.id, actor=owner
            )


async def test_clearing_standalone_score_does_not_make_match_disposable(db_session):
    from app.match_creation import create_match
    from app.match_scoring import delete_game_score, enter_game_score

    owner = await make_user(db_session, "standalone-retention-owner")
    opponent = await make_user(db_session, "standalone-retention-opponent")
    match = await create_match(
        db_session,
        creator=owner,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=3,
        rated=False,
    )
    await enter_game_score(
        db_session, match.id, owner.id, game_number=1, side_1_points=11, side_2_points=5
    )
    await delete_game_score(db_session, match.id, owner.id, game_number=1)
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text("DELETE FROM match_games WHERE match_id=:id"), {"id": match.id}
            )
            await db_session.execute(
                text("DELETE FROM matches WHERE id=:id"), {"id": match.id}
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("operation", ["history", "tournament", "backend"])
async def test_cancelled_table_call_retains_history_without_play(
    db_session, default_league, operation
):
    from datetime import UTC, datetime

    from sqlalchemy import select

    from app.models import VenueTable, VenueTableCallHistory
    from app.tournament_errors import RecordedPlayDeletionError
    from app.tournament_lifecycle import delete_tournament

    owner = await make_user(db_session, "cancelled-call-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.draft,
    )
    table = await db_session.scalar(
        select(VenueTable).where(VenueTable.tournament_id == tournament.id)
    )
    history = VenueTableCallHistory(
        tournament_id=tournament.id,
        table_id=table.id,
        kind="cancelled",
        scheduled_start=datetime.now(UTC),
    )
    db_session.add(history)
    await db_session.commit()
    if operation == "backend":
        with pytest.raises(RecordedPlayDeletionError, match="Table call history"):
            await delete_tournament(
                db_session, tournament_id=tournament.id, actor=owner
            )
    else:
        statement = (
            "DELETE FROM tournament_table_call_history WHERE id=:id"
            if operation == "history"
            else "DELETE FROM tournaments WHERE id=:id"
        )
        with pytest.raises(IntegrityError, match="call history"):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(statement),
                    {"id": history.id if operation == "history" else tournament.id},
                )


@pytest.mark.parametrize("operation", ["sql", "backend"])
async def test_only_unused_drafts_can_be_deleted(db_session, default_league, operation):
    from app.tournament_errors import RecordedPlayDeletionError
    from app.tournament_lifecycle import delete_tournament

    owner = await make_user(db_session, "published-retention-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
    )
    if operation == "backend":
        with pytest.raises(RecordedPlayDeletionError, match="draft"):
            await delete_tournament(
                db_session, tournament_id=tournament.id, actor=owner
            )
    else:
        with pytest.raises(IntegrityError, match="draft"):
            async with db_session.begin_nested():
                await db_session.execute(
                    text("DELETE FROM tournaments WHERE id=:id"), {"id": tournament.id}
                )


async def test_unused_draft_cleanup_does_not_depend_on_cascade_order(
    db_session, default_league
):
    from sqlalchemy import select

    from app.models import (
        TournamentEventStage,
        TournamentEventStageGroup,
        TournamentFixture,
        VenueTable,
    )

    owner = await make_user(db_session, "draft-cleanup-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.draft,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    stage = await db_session.scalar(
        select(TournamentEventStage).where(TournamentEventStage.event_id == event.id)
    )
    table = await db_session.scalar(
        select(VenueTable).where(VenueTable.tournament_id == tournament.id)
    )
    group = await db_session.scalar(
        select(TournamentEventStageGroup).where(
            TournamentEventStageGroup.stage_id == stage.id
        )
    )
    fixture = TournamentFixture(
        stage_id=stage.id, group_id=group.id, round=1, position=1, table_id=table.id
    )
    db_session.add(fixture)
    await db_session.commit()
    # The catalogue can be removed before fixtures when the whole unused aggregate
    # is removed in the same transaction. A surviving fixture must still be protected.
    await db_session.execute(
        text("DELETE FROM tournament_tables WHERE tournament_id=:id"),
        {"id": tournament.id},
    )
    await db_session.execute(
        text("DELETE FROM tournaments WHERE id=:id"), {"id": tournament.id}
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            select(TournamentFixture.id).where(TournamentFixture.id == fixture.id)
        )
        is None
    )


@pytest.mark.parametrize("recording", ["score", "proposal"])
async def test_recording_keeps_original_participants_when_current_sides_change(
    db_session,
    recording,
):
    from app.match_creation import create_match
    from app.match_scoring import enter_game_score

    owner = await make_user(db_session, "participant-retention-owner")
    opponent = await make_user(db_session, "participant-retention-opponent")
    match = await create_match(
        db_session,
        creator=owner,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=3,
        rated=False,
    )
    if recording == "proposal":
        from tests.test_proposal_history import append

        await append(db_session, (match.id, owner.id, owner.player_id))
        await db_session.commit()
    else:
        await enter_game_score(
            db_session,
            match.id,
            owner.id,
            game_number=1,
            side_1_points=11,
            side_2_points=5,
        )
    # Same-person merges can reconcile current sides; original evidence stays put.
    from app.account_merge import merge_user

    await merge_user(db_session, from_user_id=owner.id, to_user_id=opponent.id)
    await db_session.commit()
    recorded = (
        await db_session.execute(
            text(
                "SELECT side_number, player_id FROM match_recorded_participants "
                "WHERE match_id=:id ORDER BY side_number"
            ),
            {"id": match.id},
        )
    ).all()
    assert recorded == [(1, owner.id), (2, opponent.id)]
    with pytest.raises(IntegrityError, match="history"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("DELETE FROM match_recorded_participants WHERE match_id=:id"),
                {"id": match.id},
            )


@pytest.mark.parametrize("child", ["game", "score"])
async def test_recorded_scores_cannot_be_reparented_to_a_disposable_match(
    db_session, child
):
    from app.match_creation import create_match
    from app.match_scoring import enter_game_score
    from app.models import MatchGame

    owner = await make_user(db_session, "score-owner-retained")
    first = await create_match(
        db_session,
        creator=owner,
        opponent_user_id=None,
        league_id=None,
        best_of=3,
        rated=False,
    )
    second = await create_match(
        db_session,
        creator=owner,
        opponent_user_id=None,
        league_id=None,
        best_of=3,
        rated=False,
    )
    await enter_game_score(
        db_session, first.id, owner.id, game_number=1, side_1_points=11, side_2_points=5
    )
    if child == "score":
        game = MatchGame(match_id=second.id, game_number=1)
        db_session.add(game)
        await db_session.commit()
        statement = (
            "UPDATE match_game_scores SET match_game_id=:target "
            "WHERE match_game_id IN (SELECT id FROM match_games "
            "WHERE match_id=:source)"
        )
        target = game.id
    else:
        statement = "UPDATE match_games SET match_id=:target WHERE match_id=:source"
        target = second.id
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(statement), {"source": first.id, "target": target}
            )


async def test_uncut_retains_cancelled_call_history_and_still_blocks_parent_deletion(
    db_session, default_league
):
    from datetime import UTC, datetime

    from sqlalchemy import select

    from app.models import (
        TournamentEventStage,
        TournamentEventStageGroup,
        TournamentFixture,
        VenueTable,
        VenueTableCallHistory,
    )
    from app.tournament_draw_service import uncut_event_draw
    from app.tournament_errors import RecordedPlayDeletionError
    from app.tournament_events import delete_event

    owner = await make_user(db_session, "call-history-draw-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.draft,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    stage = await db_session.scalar(
        select(TournamentEventStage).where(TournamentEventStage.event_id == event.id)
    )
    group = await db_session.scalar(
        select(TournamentEventStageGroup).where(
            TournamentEventStageGroup.stage_id == stage.id
        )
    )
    table = await db_session.scalar(
        select(VenueTable).where(VenueTable.tournament_id == tournament.id)
    )
    fixture = TournamentFixture(
        stage_id=stage.id, group_id=group.id, round=1, position=1
    )
    db_session.add(fixture)
    await db_session.flush()
    db_session.add(
        VenueTableCallHistory(
            tournament_id=tournament.id,
            table_id=table.id,
            fixture_id=fixture.id,
            kind="cancelled",
            scheduled_start=datetime.now(UTC),
        )
    )
    await db_session.commit()
    await uncut_event_draw(
        db_session, tournament_id=tournament.id, event_id=event.id, actor=owner
    )
    retained = await db_session.scalar(
        select(TournamentFixture)
        .where(TournamentFixture.id == fixture.id)
        .execution_options(include_draw_history=True)
    )
    assert retained is not None and retained.retired_at is not None
    assert (
        await db_session.scalar(
            select(VenueTableCallHistory.fixture_id).where(
                VenueTableCallHistory.fixture_id == fixture.id
            )
        )
        == fixture.id
    )
    with pytest.raises(RecordedPlayDeletionError, match="Table call history"):
        await delete_event(
            db_session, tournament_id=tournament.id, event_id=event.id, actor=owner
        )


@pytest.mark.parametrize(
    "status",
    [TournamentStatus.published, TournamentStatus.live, TournamentStatus.archived],
)
async def test_publication_cannot_be_erased_by_resetting_status_before_delete(
    db_session, default_league, status
):
    owner = await make_user(db_session, "publication-reset-owner")
    tournament = await _make_tournament_at(
        db_session, owner=owner, league=default_league, status=status, with_event=False
    )
    with pytest.raises(IntegrityError, match="publication history"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE tournaments SET status='draft' WHERE id=:id"),
                {"id": tournament.id},
            )
            await db_session.execute(
                text("DELETE FROM tournaments WHERE id=:id"), {"id": tournament.id}
            )
