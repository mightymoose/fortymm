"""Archive preserves sporting progress and durable, honest archive history."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import League, Tournament, TournamentStatus
from app.tournament_errors import RecordedPlayDeletionError
from app.tournament_lifecycle import delete_tournament, transition_tournament
from tests._helpers import make_user
from tests.test_tournament_lifecycle import _make_tournament_at, _one_event


async def test_archive_records_its_time_without_finishing_an_unstarted_event(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "archive-history-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.live,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    archived = await transition_tournament(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        to=TournamentStatus.archived,
    )

    assert archived.archive_observed_at is not None
    assert archived.archived_at == archived.archive_observed_at
    history = (
        await db_session.execute(
            text(
                "SELECT observed_at, occurred_at FROM tournament_archive_history "
                "WHERE tournament_id=:id"
            ),
            {"id": tournament.id},
        )
    ).one()
    assert history.observed_at == archived.archive_observed_at
    assert history.occurred_at == archived.archived_at
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event.id},
        )
        == "unstarted"
    )


async def test_archived_tournament_without_play_refuses_deletion_with_domain_conflict(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "archive-retention-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.archived,
    )
    with pytest.raises(RecordedPlayDeletionError, match="Archive history"):
        await delete_tournament(db_session, tournament_id=tournament.id, actor=owner)


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE tournaments SET status='live' WHERE id=:id",
        "UPDATE tournaments SET archive_observed_at=NULL WHERE id=:id",
        "UPDATE tournaments SET archived_at=now() WHERE id=:id",
        "DELETE FROM tournament_archive_history WHERE tournament_id=:id",
        "UPDATE tournament_archive_history SET occurred_at=now() "
        "WHERE tournament_id=:id",
        "DELETE FROM tournaments WHERE id=:id",
    ],
)
async def test_archive_history_cannot_be_rewritten_or_erased_through_sql(
    db_session: AsyncSession, default_league: League, statement: str
) -> None:
    owner = await make_user(db_session, "archive-sql-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.archived,
    )
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(text(statement), {"id": tournament.id})


@pytest.mark.parametrize(
    "assignment",
    [
        "archived_at=now()",
        "archive_observed_at=now()",
        "status='archived', archived_at='2999-01-01T00:00:00Z'",
    ],
)
async def test_archive_timestamps_cannot_contradict_state_or_chronology(
    db_session: AsyncSession, default_league: League, assignment: str
) -> None:
    owner = await make_user(db_session, "archive-chronology-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.live,
    )
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(f"UPDATE tournaments SET {assignment} WHERE id=:id"),
                {"id": tournament.id},
            )


@pytest.mark.parametrize("occurred_at", [None, datetime(2026, 1, 1, tzinfo=UTC)])
async def test_seeded_archive_preserves_known_or_explicitly_unknown_occurrence_time(
    db_session: AsyncSession, default_league: League, occurred_at: datetime | None
) -> None:
    owner = await make_user(db_session, "archive-seed-owner")
    tournament = Tournament(
        name="Historical tournament",
        created_by_user_id=owner.id,
        league_id=default_league.id,
        status=TournamentStatus.archived,
        archived_at=occurred_at,
    )
    db_session.add(tournament)
    await db_session.commit()
    history = (
        await db_session.execute(
            text(
                "SELECT observed_at, occurred_at FROM tournament_archive_history "
                "WHERE tournament_id=:id"
            ),
            {"id": tournament.id},
        )
    ).one()
    assert history.observed_at is not None
    assert history.occurred_at == occurred_at
