"""Completed standalone attachments must reconcile event result completeness."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.event_lifecycle import reconcile_event
from app.match_creation import create_match
from app.models import TournamentEntry, User
from app.result_proposal import propose_result
from tests.test_match_calls import _make_tournament, _the_fixture
from tests.test_official_results import board


@pytest.mark.parametrize("with_scores", [True, False])
async def test_completed_attachment_requires_current_reconciliation(
    db_session: AsyncSession, with_scores: bool
) -> None:
    _, event_id = await _make_tournament(db_session)
    fixture = await _the_fixture(db_session, event_id)
    entry_a = await db_session.get(TournamentEntry, fixture.entry_a_id)
    entry_b = await db_session.get(TournamentEntry, fixture.entry_b_id)
    assert entry_a is not None and entry_b is not None
    player = await db_session.get(User, entry_a.user_id)
    assert player is not None
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=entry_b.user_id,
        league_id=None,
        best_of=1,
        rated=False,
    )
    if with_scores:
        await propose_result(
            db_session, match.id, player.id, games=board(), supersedes_result_id=None
        )
    else:
        await db_session.execute(
            text(
                "UPDATE matches SET status='completed', ending='walkover', "
                "completed_at=clock_timestamp() WHERE id=:id"
            ),
            {"id": match.id},
        )
        await db_session.commit()
    attachment = text(
        "UPDATE tournament_fixtures SET match_id=:match WHERE id=:fixture"
    )
    parameters = {"match": match.id, "fixture": fixture.id}
    with pytest.raises(IntegrityError, match="requires event reconciliation"):
        async with db_session.begin_nested():
            # An assertion made before the changed inputs must not authorize them.
            await reconcile_event(db_session, event_id)
            # An explicit maintenance assertion also expires when inputs change.
            await db_session.execute(
                text("""
                    INSERT INTO tournament_event_reconciliations
                        (event_id,transaction_id,lifecycle_state,lifecycle_version)
                    SELECT id,pg_current_xact_id()::text::bigint,
                        lifecycle_state::text,lifecycle_version
                    FROM tournament_events WHERE id=:id
                    ON CONFLICT (event_id,transaction_id) DO NOTHING
                """),
                {"id": event_id},
            )
            await db_session.execute(attachment, parameters)
            await db_session.execute(
                text("SET CONSTRAINTS require_event_reconciliation IMMEDIATE")
            )
    await db_session.execute(attachment, parameters)
    await reconcile_event(db_session, event_id)
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "finished"
    )


async def test_reconciling_untouched_event_does_not_create_retained_assertion(
    db_session: AsyncSession,
) -> None:
    _, event_id = await _make_tournament(db_session)
    await reconcile_event(db_session, event_id)
    assert not await db_session.scalar(
        text(
            "SELECT EXISTS(SELECT 1 FROM tournament_event_reconciliations "
            "WHERE event_id=:id)"
        ),
        {"id": event_id},
    )
