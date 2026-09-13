"""Scoring and cancellation acquire parent scope before event state."""

import asyncio

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.event_lifecycle import cancel_event, require_game_recording_allowed
from app.match_errors import ScoreNotAllowedError
from app.models import TournamentFixture
from tests._helpers import directed_tournament_match


@pytest.mark.parametrize("writer", ["guard", "raw", "application"])
async def test_scoring_waits_for_cancellation_without_holding_its_event_lock(
    engine: AsyncEngine, db_session: AsyncSession, writer: str
) -> None:
    match, owner = await directed_tournament_match(
        db_session, tag="parent-lock-order", best_of=3
    )
    fixture = await db_session.scalar(
        select(TournamentFixture).where(TournamentFixture.match_id == match.id)
    )
    assert fixture is not None
    tournament_id, event_id, match_id = (
        fixture.scope_tournament_id,
        fixture.scope_event_id,
        match.id,
    )
    game_id = await db_session.scalar(
        text(
            "INSERT INTO match_games(match_id, game_number) VALUES(:id,1) RETURNING id"
        ),
        {"id": match_id},
    )
    await db_session.commit()
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as cancellation, factory() as scorer:
        await cancellation.execute(
            text(
                "SELECT id FROM tournaments WHERE id=:id FOR "
                + ("SHARE" if writer == "application" else "UPDATE")
            ),
            {"id": tournament_id},
        )
        scorer_pid = await scorer.scalar(text("SELECT pg_backend_pid()"))

        async def score() -> None:
            if writer == "raw":
                await scorer.execute(
                    text(
                        "INSERT INTO match_game_scores "
                        "(match_game_id, side_1_points, side_2_points) "
                        "VALUES (:id,11,5)"
                    ),
                    {"id": game_id},
                )
                # The completion seam needs the parent after canonical scoring.
                await scorer.execute(
                    text("SELECT id FROM tournaments WHERE id=:id FOR UPDATE"),
                    {"id": tournament_id},
                )
            else:
                if writer == "application":
                    from app.match_scoring import load_match_for_write

                    await load_match_for_write(scorer, match_id, owner.id, lock=True)
                await require_game_recording_allowed(scorer, match_id, (1,))

        scoring = asyncio.create_task(score())
        try:
            async with asyncio.timeout(5):
                while not await db_session.scalar(
                    text("SELECT cardinality(pg_blocking_pids(:pid)) > 0"),
                    {"pid": scorer_pid},
                ):
                    assert not scoring.done(), (
                        "scoring must first wait for the tournament"
                    )
                    await asyncio.sleep(0.01)
            # A score writer queued on the parent cannot hold the child. This is
            # the exact second lock cancellation needs; NOWAIT falsifies inversion.
            await cancellation.execute(
                text("SELECT id FROM tournament_events WHERE id=:id FOR UPDATE NOWAIT"),
                {"id": event_id},
            )
            await cancel_event(
                cancellation,
                tournament_id=tournament_id,
                event_id=event_id,
                actor=owner,
            )
            await cancellation.commit()
            with pytest.raises(
                IntegrityError if writer == "raw" else ScoreNotAllowedError,
                match="cancelled",
            ):
                await scoring
            await scorer.rollback()
        finally:
            if not scoring.done():
                scoring.cancel()
                await asyncio.gather(scoring, return_exceptions=True)
