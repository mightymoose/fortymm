"""Advancement evidence through the completion and internal history interfaces."""

import pytest
from sqlalchemy import select

from app.result_proposal import propose_result
from tests._advancement_seeds import seed_knockout_advancement as knockout
from tests.test_official_results import board


async def test_completion_records_the_result_that_earned_the_seat(db_session):
    from app.advancement_decisions import advancement_history

    match, director, source, target = await knockout(db_session)
    outcome = await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    history = await advancement_history(db_session, target.id, "a")
    assert len(history) == 1
    decision = history[0]
    assert decision.entry_id == source.entry_a_id == target.entry_a_id
    assert decision.source_fixture_id == source.id
    assert decision.rule_version == "knockout_winner_v1"
    assert decision.current and decision.evidence_status == "current"
    assert decision.official_result_ids == (outcome.match.current_official_result_id,)


async def test_changed_evidence_is_stale_even_when_the_same_player_wins(db_session):
    from app.advancement_decisions import advancement_history
    from app.official_results import correct_result
    from app.schemas.match import MatchResultsGameWrite

    match, director, source, target = await knockout(db_session)
    outcome = await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    original = outcome.match.current_official_result_id
    await correct_result(
        db_session,
        match.id,
        director.id,
        expected_revision_id=original,
        reason="Correct losing score",
        games=[MatchResultsGameWrite(game_number=1, side_1_points=11, side_2_points=8)],
    )
    await db_session.commit()
    (decision,) = await advancement_history(db_session, target.id, "a")
    assert decision.current and decision.evidence_status == "stale"
    assert decision.official_result_ids == (original,)
    assert decision.entry_id == target.entry_a_id == source.entry_a_id


async def test_voided_support_is_stale_even_with_unchanged_revision(db_session):
    from app.advancement_decisions import advancement_history
    from app.official_results import void_official_match

    match, director, _, target = await knockout(db_session)
    outcome = await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    original = outcome.match.current_official_result_id
    await void_official_match(
        db_session, match.id, director.id, reason="Invalid pairing"
    )
    await db_session.commit()
    (decision,) = await advancement_history(db_session, target.id, "a")
    assert decision.current and decision.evidence_status == "stale"
    assert decision.official_result_ids == (original,)


async def test_replacement_appends_and_rejects_an_outdated_expected_decision(
    db_session,
):
    import pytest

    from app.advancement_decisions import advancement_history, replace_advancement
    from app.official_results import correct_result

    match, director, source, target = await knockout(db_session)
    outcome = await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (original,) = await advancement_history(db_session, target.id, "a")
    revised = await correct_result(
        db_session,
        match.id,
        director.id,
        expected_revision_id=outcome.match.current_official_result_id,
        reason="Correct winner",
        games=board(winner=2),
    )
    await replace_advancement(
        db_session,
        target.id,
        "a",
        expected_current_id=original.id,
        actor_account_id=director.id,
        reason="Use corrected winner",
        entry_id=source.entry_b_id,
        official_result_ids=(revised.id,),
    )
    await db_session.commit()
    history = await advancement_history(db_session, target.id, "a")
    assert [d.current for d in history] == [False, True]
    assert history[0].id == original.id and history[0].evidence_status == "stale"
    assert history[1].entry_id == target.entry_a_id == source.entry_b_id
    assert history[1].official_result_ids == (revised.id,)
    assert history[1].actor_account_id == director.id
    assert history[1].reason == "Use corrected winner"
    with pytest.raises(ValueError, match="current"):
        await replace_advancement(
            db_session,
            target.id,
            "a",
            expected_current_id=original.id,
            actor_account_id=director.id,
            reason="Outdated retry",
            entry_id=source.entry_a_id,
            official_result_ids=(revised.id,),
        )
    assert len(await advancement_history(db_session, target.id, "a")) == 2


async def test_seeded_unknown_history_has_an_honest_reason_and_no_invented_results(
    db_session,
):
    from app.advancement_decisions import advancement_history
    from app.models import AdvancementDecision

    _, _, source, target = await knockout(db_session)
    target.entry_a_id = source.entry_a_id
    db_session.add(
        AdvancementDecision(
            fixture_id=target.id,
            side="a",
            entry_id=source.entry_a_id,
            rule_version="unknown",
            rule_settings={},
            evidence_count=0,
            unknown_reason="Imported bracket has no supporting result history",
        )
    )
    await db_session.commit()
    (decision,) = await advancement_history(db_session, target.id, "a")
    assert decision.evidence_status == "unknown"
    assert (
        decision.unknown_reason == "Imported bracket has no supporting result history"
    )
    assert decision.official_result_ids == ()


async def test_recorded_play_allows_reaffirmation_but_refuses_a_different_participant(
    db_session,
):
    import pytest
    from sqlalchemy import text

    from app.advancement_decisions import advancement_history, replace_advancement
    from app.match_scoring import load_match_for_write
    from app.models import Tournament, TournamentEvent
    from app.official_results import correct_result
    from app.schemas.match import MatchResultsGameWrite
    from app.tournament_materialization import materialize_event

    match, director, source, target = await knockout(db_session)
    outcome = await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    target.entry_b_id = source.entry_b_id
    await db_session.flush()
    event = await db_session.get(TournamentEvent, source.scope_event_id)
    tournament = await db_session.get(Tournament, source.scope_tournament_id)
    await materialize_event(db_session, tournament, event)
    await db_session.flush()
    await db_session.execute(
        text("UPDATE matches SET status = 'in_progress' WHERE id = :id"),
        {"id": target.match_id},
    )
    await db_session.commit()
    (original,) = await advancement_history(db_session, target.id, "a")
    downstream = await load_match_for_write(
        db_session, target.match_id, director.id, lock=False
    )
    played_participants = {
        (side.side_number, player.user_id)
        for side in downstream.sides
        for player in side.players
    }
    corrected = await correct_result(
        db_session,
        match.id,
        director.id,
        expected_revision_id=outcome.match.current_official_result_id,
        reason="Correct score after downstream play started",
        games=[MatchResultsGameWrite(game_number=1, side_1_points=11, side_2_points=8)],
    )
    await db_session.commit()
    (stale,) = await advancement_history(db_session, target.id, "a")
    assert stale.id == original.id and stale.current
    assert stale.evidence_status == "stale"
    assert stale.official_result_ids == original.official_result_ids
    await db_session.refresh(target)
    assert target.entry_a_id == original.entry_id
    downstream = await load_match_for_write(
        db_session, target.match_id, director.id, lock=False
    )
    assert {
        (side.side_number, player.user_id)
        for side in downstream.sides
        for player in side.players
    } == played_participants
    reaffirmed = await replace_advancement(
        db_session,
        target.id,
        "a",
        expected_current_id=original.id,
        actor_account_id=director.id,
        reason="Reaffirm qualification against corrected score",
        entry_id=source.entry_a_id,
        official_result_ids=(corrected.id,),
    )
    await db_session.commit()
    with pytest.raises(ValueError, match="recorded play"):
        await replace_advancement(
            db_session,
            target.id,
            "a",
            expected_current_id=reaffirmed,
            actor_account_id=director.id,
            reason="Replace participant",
            entry_id=source.entry_b_id,
            official_result_ids=(corrected.id,),
        )
    history = await advancement_history(db_session, target.id, "a")
    assert len(history) == 2
    assert history[0].evidence_status == "stale" and not history[0].current
    assert history[1].evidence_status == "current" and history[1].current
    assert history[1].official_result_ids == (corrected.id,)


async def test_two_replacements_of_the_same_head_serialize_and_only_one_wins(
    db_session, engine
):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.advancement_decisions import advancement_history, replace_advancement
    from app.models import Tournament

    match, director, source, target = await knockout(db_session)
    outcome = await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (original,) = await advancement_history(db_session, target.id, "a")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    entered = [asyncio.Event(), asyncio.Event()]

    async def contender(index):
        async with sessions() as db:
            entered[index].set()
            try:
                await replace_advancement(
                    db,
                    target.id,
                    "a",
                    expected_current_id=original.id,
                    actor_account_id=director.id,
                    reason=f"Review {index}",
                    entry_id=source.entry_a_id,
                    official_result_ids=(outcome.match.current_official_result_id,),
                )
                await db.commit()
                return "replaced"
            except ValueError as error:
                await db.rollback()
                assert "current" in str(error)
                return "stale"

    async with sessions() as gatekeeper:
        await gatekeeper.execute(
            select(Tournament.id)
            .where(Tournament.id == source.scope_tournament_id)
            .with_for_update()
        )
        tasks = [asyncio.create_task(contender(i)) for i in range(2)]
        try:
            await asyncio.gather(*(event.wait() for event in entered))
            finished, _ = await asyncio.wait(tasks, timeout=0.2)
            assert not finished, (
                "both replacements must block behind the tournament lock"
            )
        finally:
            await gatekeeper.rollback()
            results = await asyncio.gather(*tasks)
    assert sorted(results) == ["replaced", "stale"]
    assert len(await advancement_history(db_session, target.id, "a")) == 2


@pytest.mark.parametrize("merge_replacement_player", [False, True])
async def test_replacement_updates_a_materialized_match_before_recorded_play(
    db_session,
    merge_replacement_player,
):
    from app.advancement_decisions import advancement_history, replace_advancement
    from app.models import (
        MatchSide,
        MatchSidePlayer,
        Tournament,
        TournamentEntry,
        TournamentEvent,
    )
    from app.official_results import correct_result
    from app.tournament_materialization import materialize_event
    from tests._helpers import make_user

    match, director, source, target = await knockout(db_session)
    outcome = await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    opponent = await make_user(db_session, "other-finalist")
    entry = TournamentEntry(event_id=source.scope_event_id, user_id=opponent.id)
    db_session.add(entry)
    await db_session.flush()
    target.entry_b_id = entry.id
    await db_session.flush()
    await materialize_event(
        db_session,
        await db_session.get(Tournament, source.scope_tournament_id),
        await db_session.get(TournamentEvent, source.scope_event_id),
    )
    await db_session.commit()
    (original,) = await advancement_history(db_session, target.id, "a")
    survivor = None
    if merge_replacement_player:
        from app.account_merge import merge_user

        replacement_entry = await db_session.get(TournamentEntry, source.entry_b_id)
        survivor = await make_user(db_session, "replacement-survivor")
        await merge_user(
            db_session,
            from_user_id=replacement_entry.user_id,
            to_user_id=survivor.id,
        )
        await db_session.commit()
    corrected = await correct_result(
        db_session,
        match.id,
        director.id,
        expected_revision_id=outcome.match.current_official_result_id,
        reason="Wrong winner",
        games=board(winner=2),
    )
    await replace_advancement(
        db_session,
        target.id,
        "a",
        expected_current_id=original.id,
        actor_account_id=director.id,
        reason="Replace before play",
        entry_id=source.entry_b_id,
        official_result_ids=(corrected.id,),
    )
    await db_session.commit()
    if survivor is not None:
        from sqlalchemy import text

        await db_session.execute(
            text("UPDATE matches SET status = 'in_progress' WHERE id = :id"),
            {"id": target.match_id},
        )
        await db_session.commit()
        proposed = await propose_result(
            db_session,
            target.match_id,
            survivor.id,
            games=board(),
            supersedes_result_id=None,
        )
        assert proposed.match.results[0].submitted_by_user_id == survivor.id
    actual = (
        await db_session.scalars(
            select(MatchSidePlayer.user_id)
            .join(MatchSide, MatchSide.id == MatchSidePlayer.match_side_id)
            .where(MatchSide.match_id == target.match_id, MatchSide.side_number == 1)
        )
    ).one()
    expected = await db_session.get(TournamentEntry, source.entry_b_id)
    await db_session.refresh(expected)
    assert actual == expected.user_id


async def test_replacement_does_not_hold_match_while_waiting_for_scoring_parent_lock(
    db_session, engine
):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.advancement_decisions import advancement_history, replace_advancement
    from app.match_scoring import load_match_for_write
    from app.models import Tournament, TournamentEvent
    from app.tournament_materialization import materialize_event

    match, director, source, target = await knockout(db_session)
    outcome = await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    target.entry_b_id = source.entry_b_id
    await db_session.flush()
    await materialize_event(
        db_session,
        await db_session.get(Tournament, source.scope_tournament_id),
        await db_session.get(TournamentEvent, source.scope_event_id),
    )
    await db_session.commit()
    (original,) = await advancement_history(db_session, target.id, "a")
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def replace():
        async with sessions() as db:
            await replace_advancement(
                db,
                target.id,
                "a",
                expected_current_id=original.id,
                actor_account_id=director.id,
                reason="Reviewed",
                entry_id=source.entry_a_id,
                official_result_ids=(outcome.match.current_official_result_id,),
            )
            await db.commit()

    async with sessions() as scorer:
        await scorer.execute(
            select(Tournament.id)
            .where(Tournament.id == source.scope_tournament_id)
            .with_for_update(read=True)
        )
        task = asyncio.create_task(replace())
        try:
            finished, _ = await asyncio.wait([task], timeout=0.2)
            assert not finished
            await asyncio.wait_for(
                load_match_for_write(scorer, target.match_id, director.id, lock=True),
                timeout=1,
            )
        finally:
            await scorer.rollback()
            await task


async def test_missing_official_evidence_rolls_back_automatic_seating(db_session):
    import pytest

    from app.advancement_decisions import advancement_history
    from app.models import Tournament, TournamentEvent
    from app.tournament_materialization import materialize_event

    _, _, source, target = await knockout(db_session)
    target_id = target.id
    with pytest.raises(ValueError, match="complete official-result evidence"):
        async with db_session.begin_nested():
            # Exercise an invalid advancement input: a winner is projected even
            # though this source has not produced an official result.
            source.winner_entry_id = source.entry_a_id
            event = await db_session.get(TournamentEvent, source.scope_event_id)
            tournament = await db_session.get(Tournament, source.scope_tournament_id)
            await materialize_event(db_session, tournament, event)
    await db_session.refresh(target)
    assert target.entry_a_id is None
    assert await advancement_history(db_session, target_id, "a") == []


async def _replacement_after_schedule_finished(db, *, materialized):
    from app.advancement_decisions import advancement_history
    from app.models import (
        ScheduleSolveStatus,
        Tournament,
        TournamentEntry,
        TournamentEvent,
    )
    from app.official_results import correct_result
    from app.schedule_solves import latest_solve
    from app.tournament_materialization import materialize_event
    from tests._helpers import make_user

    match, director, source, target = await knockout(db)
    outcome = await propose_result(
        db, match.id, director.id, games=board(), supersedes_result_id=None
    )
    if materialized:
        opponent = await make_user(db, "scheduled-finalist")
        entry = TournamentEntry(event_id=source.scope_event_id, user_id=opponent.id)
        db.add(entry)
        await db.flush()
        target.entry_b_id = entry.id
        await db.flush()
        await materialize_event(
            db,
            await db.get(Tournament, source.scope_tournament_id),
            await db.get(TournamentEvent, source.scope_event_id),
        )
    previous_solve = await latest_solve(db, source.scope_tournament_id)
    assert previous_solve is not None
    # Seed the previous solve as finished: the replacement must request a fresh
    # solve rather than accidentally inheriting the source completion's queued run.
    previous_solve.status = ScheduleSolveStatus.succeeded
    await db.commit()
    (original,) = await advancement_history(db, target.id, "a")
    corrected = await correct_result(
        db,
        match.id,
        director.id,
        expected_revision_id=outcome.match.current_official_result_id,
        reason="Correct qualifier",
        games=board(winner=2),
    )
    await db.commit()
    return director, source, target, original, corrected, previous_solve.id


@pytest.mark.parametrize("materialized", [False, True])
async def test_changed_participant_requests_a_schedule_recalculation(
    db_session,
    materialized,
):
    from app.advancement_decisions import replace_advancement
    from app.models import ScheduleSolveStatus, ScheduleSolveTrigger
    from app.schedule_solves import latest_solve

    (
        director,
        source,
        target,
        original,
        corrected,
        old_solve_id,
    ) = await _replacement_after_schedule_finished(
        db_session, materialized=materialized
    )
    await replace_advancement(
        db_session,
        target.id,
        "a",
        expected_current_id=original.id,
        actor_account_id=director.id,
        reason="Seat corrected qualifier",
        entry_id=source.entry_b_id,
        official_result_ids=(corrected.id,),
    )
    await db_session.commit()
    scheduled = await latest_solve(db_session, source.scope_tournament_id)
    assert scheduled is not None and scheduled.id != old_solve_id
    assert scheduled.trigger is ScheduleSolveTrigger.settings_changed
    assert scheduled.status is ScheduleSolveStatus.queued


@pytest.mark.parametrize("action", ["reaffirm", "reject", "rollback"])
async def test_unchanged_or_rolled_back_replacement_leaves_schedule_unchanged(
    db_session,
    action,
):
    import uuid

    from app.advancement_decisions import advancement_history, replace_advancement
    from app.schedule_solves import latest_solve

    (
        director,
        source,
        target,
        original,
        corrected,
        old_solve_id,
    ) = await _replacement_after_schedule_finished(db_session, materialized=False)
    tournament_id, target_id = source.scope_tournament_id, target.id
    original_entry = source.entry_a_id

    async def replacement(*, entry_id, expected_current_id=original.id):
        await replace_advancement(
            db_session,
            target_id,
            "a",
            expected_current_id=expected_current_id,
            actor_account_id=director.id,
            reason="Review qualifier",
            entry_id=entry_id,
            official_result_ids=(corrected.id,),
        )

    if action == "reaffirm":
        await replacement(entry_id=original_entry)
    elif action == "reject":
        with pytest.raises(ValueError, match="no longer current"):
            await replacement(
                entry_id=source.entry_b_id, expected_current_id=uuid.uuid4()
            )
    else:

        class RollbackReplacement(Exception):
            pass

        with pytest.raises(RollbackReplacement):
            async with db_session.begin_nested():
                await replacement(entry_id=source.entry_b_id)
                queued = await latest_solve(db_session, tournament_id)
                assert queued is not None and queued.id != old_solve_id
                raise RollbackReplacement
    await db_session.commit()
    scheduled = await latest_solve(db_session, tournament_id)
    assert scheduled is not None and scheduled.id == old_solve_id
    history = await advancement_history(db_session, target_id, "a")
    assert len(history) == (2 if action == "reaffirm" else 1)
    assert history[-1].entry_id == original_entry
