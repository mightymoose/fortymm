"""Official results through the internal interface and real Alembic database."""

from app.match_creation import create_match
from app.result_proposal import propose_result
from app.schemas.match import MatchResultsGameWrite
from tests._helpers import make_user


def board(winner=1):
    return [
        MatchResultsGameWrite(
            game_number=1,
            side_1_points=11 if winner == 1 else 4,
            side_2_points=4 if winner == 1 else 11,
        )
    ]


async def test_immediate_finalization_records_official_score_without_opponent_consent(
    db_session,
):
    from app.official_results import official_history

    player = await make_user(db_session, "official-solo")
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )
    outcome = await propose_result(
        db_session, match.id, player.id, games=board(), supersedes_result_id=None
    )
    history = await official_history(db_session, match.id)
    assert len(history) == 1
    revision = history[0]
    assert revision.resolution_method == "immediate_finalization"
    assert revision.actor_account_id == player.id
    assert revision.games == [g.model_dump() for g in board()]
    assert outcome.match.current_official_result_id == revision.id
    assert outcome.match.results[0].accepted_by_user_id is None


async def test_opponent_acceptance_records_human_consent_and_final_display(db_session):
    from app.match_serialization import negotiation
    from app.official_results import official_history
    from app.result_acceptance import accept_result
    from tests._helpers import directed_tournament_match

    match, _ = await directed_tournament_match(
        db_session, tag="official-accept", best_of=1
    )
    sides = sorted(match.sides, key=lambda s: s.side_number)
    outcome = await propose_result(
        db_session,
        match.id,
        sides[0].players[0].user_id,
        games=board(),
        supersedes_result_id=None,
    )
    proposal = outcome.match.results[0]
    accepted = await accept_result(
        db_session, match.id, sides[1].players[0].user_id, result_id=proposal.id
    )
    history = await official_history(db_session, match.id)
    assert len(history) == 1
    assert history[0].resolution_method == "opponent_acceptance"
    assert history[0].actor_account_id == proposal.accepted_by_user_id
    assert negotiation(accepted, None).viewer_state == "final"


async def test_timeout_records_policy_and_deadline_without_inventing_acceptance(
    db_session,
):
    from datetime import timedelta

    from app.match_serialization import negotiation
    from app.notifications.service import NotificationService
    from app.official_results import official_history
    from app.retirement import retirement_deadline
    from app.retirement_jobs import RetirementOutcome, retire_if_lapsed
    from tests._helpers import FakeSender, directed_tournament_match

    match, _ = await directed_tournament_match(
        db_session, tag="official-timeout", best_of=1
    )
    match.match_settings.retirement_window = timedelta(microseconds=1)
    await db_session.commit()
    player = min(match.sides, key=lambda s: s.side_number).players[0].user_id
    outcome = await propose_result(
        db_session, match.id, player, games=board(), supersedes_result_id=None
    )
    proposal = outcome.match.results[0]
    deadline = retirement_deadline(outcome.match)
    assert (
        await retire_if_lapsed(
            db_session,
            match.id,
            proposal.id,
            NotificationService(db_session, FakeSender()),
        )
        == RetirementOutcome.retired
    )
    history = await official_history(db_session, match.id)
    assert history[0].resolution_method == "timeout"
    assert history[0].actor_account_id is None
    assert history[0].timeout_deadline == deadline
    assert history[0].timeout_policy == "retirement_window_v1"
    assert proposal.accepted_by_user_id is None
    assert proposal.accepted_at is None
    assert negotiation(outcome.match, None).viewer_state == "final"


async def test_director_finalization_records_authority_without_accepting_for_players(
    db_session,
):
    from app.official_results import official_history
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="official-director", best_of=1
    )
    outcome = await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (revision,) = await official_history(db_session, match.id)
    assert revision.resolution_method == "administrator_ruling"
    assert revision.actor_account_id == director.id
    assert revision.owner_revision == 0
    assert revision.reason == "Result recorded by tournament director"
    assert outcome.match.results[0].accepted_by_user_id is None


async def test_correction_and_restoration_append_to_latest_and_preserve_consent(
    db_session,
):
    from app.match_serialization import negotiation
    from app.official_results import correct_result, official_history
    from app.result_acceptance import accept_result
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="official-correct", best_of=1
    )
    sides = sorted(match.sides, key=lambda s: s.side_number)
    outcome = await propose_result(
        db_session,
        match.id,
        sides[0].players[0].user_id,
        games=board(),
        supersedes_result_id=None,
    )
    proposal = outcome.match.results[0]
    await accept_result(
        db_session, match.id, sides[1].players[0].user_id, result_id=proposal.id
    )
    (original,) = await official_history(db_session, match.id)
    accepted_at = proposal.accepted_at
    completed_at = match.completed_at
    correction = await correct_result(
        db_session,
        match.id,
        director.id,
        expected_revision_id=original.id,
        games=board(2),
        reason="Score was reversed",
    )
    await db_session.commit()
    assert correction.predecessor_id == original.id
    assert correction.revision == 2
    assert match.completed_at == completed_at
    assert sides[1].won is True
    assert negotiation(match, None).standing_result.games[0].side_2_points == 11
    restored = await correct_result(
        db_session,
        match.id,
        director.id,
        expected_revision_id=correction.id,
        restore_revision_id=original.id,
        reason="Review confirmed the original score",
    )
    await db_session.commit()
    history = await official_history(db_session, match.id)
    assert [r.revision for r in history] == [1, 2, 3]
    assert restored.predecessor_id == correction.id
    assert restored.restored_from_id == original.id
    assert restored.games == original.games
    assert restored.actor_account_id == director.id
    assert restored.resolution_method == "administrator_ruling"
    assert proposal.accepted_at == accepted_at


async def test_database_preserves_official_history_even_for_direct_sql(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.official_results import official_history

    player = await make_user(db_session, "official-integrity")
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )
    await propose_result(
        db_session, match.id, player.id, games=board(), supersedes_result_id=None
    )
    (revision,) = await official_history(db_session, match.id)
    for statement in (
        "UPDATE match_official_results SET games = '[]' WHERE id = :id",
        "UPDATE match_official_results SET predecessor_id = id WHERE id = :id",
        "DELETE FROM match_official_results WHERE id = :id",
        "UPDATE matches SET current_official_result_id = NULL WHERE id = :match",
    ):
        with pytest.raises(IntegrityError), db_session.no_autoflush:
            async with db_session.begin_nested():
                await db_session.execute(
                    text(statement), {"id": revision.id, "match": match.id}
                )


async def test_database_rejects_branching_and_keeps_current_pointer_atomic(db_session):
    import uuid

    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.official_results import official_history

    player = await make_user(db_session, "official-chain-sql")
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )
    await propose_result(
        db_session, match.id, player.id, games=board(), supersedes_result_id=None
    )
    (revision,) = await official_history(db_session, match.id)
    # A second root is invalid even if it has a different identity/number.
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text("""
                INSERT INTO match_official_results
                (id, match_id, revision, resolution_method, actor_account_id,
                proposal_id, games)
                SELECT :new, match_id, 2, resolution_method, actor_account_id,
                proposal_id, games
                FROM match_official_results WHERE id = :id
            """),
                {"new": uuid.uuid4(), "id": revision.id},
            )


async def test_database_requires_honest_ruling_provenance_and_decisive_snapshot(
    db_session,
):
    import uuid

    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.official_results import official_history
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="official-provenance", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (revision,) = await official_history(db_session, match.id)
    # Each malformed row otherwise has a valid predecessor and current authority.
    columns = [
        "resolution_method",
        "actor_account_id",
        "reason",
        "owner_revision",
        "games",
        "tournament_id",
        "proposal_id",
        "timeout_deadline",
        "timeout_policy",
    ]
    defaults = [
        "resolution_method",
        "actor_account_id",
        "reason",
        "owner_revision",
        "games",
        "tournament_id",
        "NULL",
        "timeout_deadline",
        "timeout_policy",
    ]
    for field, value in (
        ("resolution_method", "'invented'"),
        ("actor_account_id", "NULL"),
        ("reason", "'  '"),
        ("reason", "E'\\t\\n'"),
        ("owner_revision", "999"),
        ("tournament_id", "NULL"),
        ("games", "'[]'::jsonb"),
        ("games", "'[{}]'::jsonb"),
        (
            "games",
            '\'[ {"game_number": 1,"side_1_points": 11,"side_2_points": 11}]\'::jsonb',
        ),
        ("timeout_policy", "'retirement_window_v1'"),
    ):
        values = [
            value if c == field else d for c, d in zip(columns, defaults, strict=True)
        ]
        with pytest.raises(IntegrityError), db_session.no_autoflush:
            async with db_session.begin_nested():
                await db_session.execute(
                    text(f"""
                    INSERT INTO match_official_results
                    (id, match_id, revision, predecessor_id, {", ".join(columns)})
                    SELECT :new, match_id, revision + 1, id, {", ".join(values)}
                    FROM match_official_results WHERE id = :id
                """),
                    {"new": uuid.uuid4(), "id": revision.id},
                )


async def test_stale_concurrent_correction_cannot_overwrite_winning_ruling(
    db_session, engine
):
    import asyncio

    import pytest
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.official_results import (
        StaleOfficialResultError,
        correct_result,
        official_history,
    )
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="official-race", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (root,) = await official_history(db_session, match.id)
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as first, sessions() as second:
        correction = await correct_result(
            first,
            match.id,
            director.id,
            expected_revision_id=root.id,
            games=board(2),
            reason="First correction",
        )
        blocker = await first.scalar(text("SELECT pg_backend_pid()"))
        waiting = await second.scalar(text("SELECT pg_backend_pid()"))
        task = asyncio.create_task(
            correct_result(
                second,
                match.id,
                director.id,
                expected_revision_id=root.id,
                games=board(),
                reason="Stale correction",
            )
        )
        try:

            async def wait_for_block():
                while blocker not in await db_session.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": waiting}
                ):
                    if task.done():
                        await task
                        pytest.fail("Correction bypassed the held lock")
                    await asyncio.sleep(0.01)

            await asyncio.wait_for(wait_for_block(), 5)
            await first.commit()
            with pytest.raises(StaleOfficialResultError):
                await asyncio.wait_for(task, 5)
        finally:
            await first.rollback()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await second.rollback()
    history = await official_history(db_session, match.id)
    assert [r.id for r in history] == [root.id, correction.id]


async def test_administrator_void_preserves_official_history_and_blocks_corrections(
    db_session,
):
    import pytest

    from app.models import MatchStatus
    from app.official_results import (
        correct_result,
        official_history,
        void_official_match,
    )
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="official-void", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (root,) = await official_history(db_session, match.id)
    action = await void_official_match(
        db_session, match.id, director.id, reason="Match entered twice"
    )
    await db_session.commit()
    assert action.reason == "Match entered twice"
    assert action.actor_account_id == director.id
    assert action.official_result_id == root.id
    assert match.status == MatchStatus.voided
    assert match.current_official_result_id == root.id
    assert [r.id for r in await official_history(db_session, match.id)] == [root.id]
    with pytest.raises(ValueError, match="non-voided"):
        await correct_result(
            db_session,
            match.id,
            director.id,
            expected_revision_id=root.id,
            games=board(2),
            reason="Cannot correct a void",
        )


async def test_sql_void_action_cannot_claim_another_accounts_authority(db_session):
    import uuid

    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.official_results import official_history
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="official-void-sql", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (root,) = await official_history(db_session, match.id)
    outsider = await make_user(db_session, "void-outsider")
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text("""
                INSERT INTO match_void_actions
                (id, match_id, official_result_id, actor_account_id, reason,
                tournament_id, owner_revision)
                VALUES (:id, :match, :result, :actor, 'Void', :tournament, 0)
            """),
                {
                    "id": uuid.uuid4(),
                    "match": match.id,
                    "result": root.id,
                    "actor": outsider.id,
                    "tournament": root.tournament_id,
                },
            )


async def test_ruling_keeps_revoked_director_evidence_and_refuses_future_use(
    db_session,
):
    import pytest

    from app.match_errors import MatchNotFoundError
    from app.official_results import correct_result, official_history
    from app.tournament_authority import grant_director, revoke_director
    from tests._helpers import directed_tournament_match

    match, owner = await directed_tournament_match(
        db_session, tag="official-revoke", best_of=1
    )
    await propose_result(
        db_session, match.id, owner.id, games=board(), supersedes_result_id=None
    )
    (root,) = await official_history(db_session, match.id)
    director = await make_user(db_session, "official-delegate")
    grant = await grant_director(
        db_session, root.tournament_id, actor_id=owner.id, account_id=director.id
    )
    await db_session.commit()
    correction = await correct_result(
        db_session,
        match.id,
        director.id,
        expected_revision_id=root.id,
        games=board(2),
        reason="Delegate reviewed the score",
    )
    await db_session.commit()
    assert correction.director_grant_id == grant.id
    assert correction.owner_revision is None
    await revoke_director(
        db_session, root.tournament_id, actor_id=owner.id, grant_id=grant.id
    )
    await db_session.commit()
    with pytest.raises(MatchNotFoundError):
        await correct_result(
            db_session,
            match.id,
            director.id,
            expected_revision_id=correction.id,
            games=board(),
            reason="Revoked authority",
        )
    history = await official_history(db_session, match.id)
    assert history[-1].director_grant_id == grant.id


async def test_sql_cross_match_links_and_mismatched_adoption_are_rejected(db_session):
    import uuid

    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.official_results import official_history
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="official-link-a", best_of=1
    )
    other, other_director = await directed_tournament_match(
        db_session, tag="official-link-b", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    await propose_result(
        db_session,
        other.id,
        other_director.id,
        games=board(),
        supersedes_result_id=None,
    )
    (root,) = await official_history(db_session, match.id)
    (other_root,) = await official_history(db_session, other.id)
    for column, value in (
        ("proposal_id", other_root.proposal_id),
        ("predecessor_id", other_root.id),
        ("restored_from_id", other_root.id),
        ("tournament_id", other_root.tournament_id),
    ):
        expressions = {
            "proposal_id": "proposal_id",
            "predecessor_id": "id",
            "restored_from_id": "NULL",
            "tournament_id": "tournament_id",
        }
        expressions[column] = ":foreign"
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(f"""
                    INSERT INTO match_official_results
                    (id, match_id, revision, resolution_method, actor_account_id,
                    reason,
                     owner_revision, games, {", ".join(expressions)})
                    SELECT :new, match_id, 2, resolution_method, actor_account_id,
                    reason,
                           owner_revision, games, {", ".join(expressions.values())}
                    FROM match_official_results WHERE id = :root
                """),
                    {"new": uuid.uuid4(), "root": root.id, "foreign": value},
                )
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE matches SET current_official_result_id = :foreign "
                    "WHERE id = :match"
                ),
                {"foreign": other_root.id, "match": match.id},
            )
    with pytest.raises(IntegrityError, match="snapshot"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("""
                INSERT INTO match_official_results
                (id, match_id, revision, predecessor_id, proposal_id, resolution_method,
                 actor_account_id, reason, tournament_id, owner_revision, games)
                SELECT :new, match_id, 2, id, proposal_id, resolution_method,
                       actor_account_id, reason, tournament_id, owner_revision,
                       '[{"game_number": 1, "side_1_points": 4, "side_2_points":
                       11}]'::jsonb
                FROM match_official_results WHERE id = :root
            """),
                {"new": uuid.uuid4(), "root": root.id},
            )


async def test_voided_pending_proposal_never_retires(db_session):
    from datetime import timedelta

    from app.notifications.service import NotificationService
    from app.official_results import official_history, void_official_match
    from app.retirement_jobs import RetirementOutcome, retire_if_lapsed
    from tests._helpers import FakeSender, directed_tournament_match

    match, owner = await directed_tournament_match(
        db_session, tag="official-void-pending", best_of=1
    )
    match.match_settings.retirement_window = timedelta(microseconds=1)
    await db_session.commit()
    player = min(match.sides, key=lambda s: s.side_number).players[0].user_id
    outcome = await propose_result(
        db_session, match.id, player, games=board(), supersedes_result_id=None
    )
    proposal = outcome.match.results[0]
    await void_official_match(
        db_session, match.id, owner.id, reason="Duplicate fixture"
    )
    await db_session.commit()
    match_id = match.id
    assert (
        await retire_if_lapsed(
            db_session,
            match_id,
            proposal.id,
            NotificationService(db_session, FakeSender()),
        )
        == RetirementOutcome.superseded
    )
    assert await official_history(db_session, match_id) == []


async def test_correction_rebuilds_ratings_and_preserves_downstream_fixtures(
    db_session,
):
    from sqlalchemy import text

    from app.official_results import correct_result, official_history
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="official-effects", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (root,) = await official_history(db_session, match.id)
    ratings_query = text(
        "SELECT row_to_json(r)::text FROM rating_history r "
        "WHERE match_id = :match ORDER BY id"
    )
    fixtures_query = text(
        "SELECT row_to_json(f)::text FROM tournament_fixtures f ORDER BY id"
    )
    ratings = (await db_session.execute(ratings_query, {"match": match.id})).all()
    fixtures = (await db_session.execute(fixtures_query)).all()
    assert len(ratings) == 2
    await correct_result(
        db_session,
        match.id,
        director.id,
        expected_revision_id=root.id,
        games=board(2),
        reason="Correct scores only",
    )
    await db_session.commit()
    assert (
        await db_session.execute(ratings_query, {"match": match.id})
    ).all() != ratings
    assert (await db_session.execute(fixtures_query)).all() == fixtures


async def test_stale_repeatable_read_cannot_use_a_revoked_director_grant(
    db_session, engine
):
    import uuid

    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.official_results import official_history
    from app.tournament_authority import grant_director, revoke_director
    from tests._helpers import directed_tournament_match

    match, owner = await directed_tournament_match(
        db_session, tag="official-stale-grant", best_of=1
    )
    await propose_result(
        db_session, match.id, owner.id, games=board(), supersedes_result_id=None
    )
    (root,) = await official_history(db_session, match.id)
    director = await make_user(db_session, "official-stale-director")
    grant = await grant_director(
        db_session, root.tournament_id, actor_id=owner.id, account_id=director.id
    )
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as stale:
        await stale.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        assert await stale.scalar(
            text(
                "SELECT revoked_at IS NULL FROM tournament_account_grants "
                "WHERE id = :id"
            ),
            {"id": grant.id},
        )
        await revoke_director(
            db_session, root.tournament_id, actor_id=owner.id, grant_id=grant.id
        )
        await db_session.commit()
        with pytest.raises(DBAPIError) as error:
            await stale.execute(
                text("""
                INSERT INTO match_official_results
                (id, match_id, revision, predecessor_id, resolution_method,
                 actor_account_id, reason, tournament_id, director_grant_id, games)
                SELECT :new, match_id, 2, id, 'administrator_ruling', :actor,
                       'Stale grant', tournament_id, :grant, games
                FROM match_official_results WHERE id = :root
            """),
                {
                    "new": uuid.uuid4(),
                    "actor": director.id,
                    "grant": grant.id,
                    "root": root.id,
                },
            )
        assert error.value.orig.sqlstate == "40001"


async def test_playing_owner_uses_participant_consent_then_can_explicitly_rule(
    db_session,
):
    from app.official_results import correct_result, official_history
    from app.result_acceptance import accept_result
    from tests._helpers import directed_tournament_match

    match, owner = await directed_tournament_match(
        db_session, tag="official-playing", best_of=1, director_is_participant=True
    )
    outcome = await propose_result(
        db_session, match.id, owner.id, games=board(), supersedes_result_id=None
    )
    assert outcome.awaiting_acceptance
    assert await official_history(db_session, match.id) == []
    opponent = max(match.sides, key=lambda s: s.side_number).players[0].user_id
    await accept_result(
        db_session, match.id, opponent, result_id=outcome.match.results[0].id
    )
    (root,) = await official_history(db_session, match.id)
    correction = await correct_result(
        db_session,
        match.id,
        owner.id,
        expected_revision_id=root.id,
        games=board(2),
        reason="I recorded the wrong winner",
    )
    await db_session.commit()
    assert root.resolution_method == "opponent_acceptance"
    assert correction.resolution_method == "administrator_ruling"
    assert correction.actor_account_id == owner.id
    assert correction.owner_revision == 0


async def test_account_merge_keeps_old_ruling_actor_and_uses_new_ownership_evidence(
    db_session,
):
    from app.account_merge import merge_user
    from app.official_results import correct_result, official_history
    from tests._helpers import directed_tournament_match

    match, owner = await directed_tournament_match(
        db_session, tag="official-merge", best_of=1
    )
    await propose_result(
        db_session, match.id, owner.id, games=board(), supersedes_result_id=None
    )
    (root,) = await official_history(db_session, match.id)
    survivor = await make_user(db_session, "official-owner-survivor")
    original_actor = owner.id
    await merge_user(db_session, from_user_id=owner.id, to_user_id=survivor.id)
    await db_session.commit()
    correction = await correct_result(
        db_session,
        match.id,
        survivor.id,
        expected_revision_id=root.id,
        games=board(2),
        reason="Review after account merge",
    )
    await db_session.commit()
    history = await official_history(db_session, match.id)
    assert history[0].actor_account_id == original_actor
    assert history[0].owner_revision == 0
    assert correction.actor_account_id == survivor.id
    assert correction.owner_revision == 1


async def test_sql_append_advances_pointer_and_stale_snapshot_cannot_branch(
    db_session, engine
):
    import uuid

    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError, IntegrityError
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.official_results import official_history
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="official-sql-append", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (root,) = await official_history(db_session, match.id)
    await db_session.commit()
    statement = text("""
        INSERT INTO match_official_results
        (id, match_id, revision, predecessor_id, resolution_method,
         actor_account_id, reason, tournament_id, owner_revision, games)
        SELECT :new, match_id, revision + 1, id, 'administrator_ruling',
               actor_account_id, 'Database ruling', tournament_id, owner_revision,
               '[{"game_number": 1,"side_1_points": 4,"side_2_points": 11}]'::jsonb
        FROM match_official_results WHERE id = :root
    """)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as stale:
        await stale.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        assert (
            await stale.scalar(
                text("SELECT current_official_result_id FROM matches WHERE id = :id"),
                {"id": match.id},
            )
            == root.id
        )
        successor = uuid.uuid4()
        await db_session.execute(statement, {"new": successor, "root": root.id})
        from app.ratings.recompute import recompute_league_ratings

        await recompute_league_ratings(
            db_session,
            match.league_id,
            {player.user_id for side in match.sides for player in side.players},
        )
        await db_session.commit()
        assert (
            await db_session.scalar(
                text("SELECT current_official_result_id FROM matches WHERE id = :id"),
                {"id": match.id},
            )
            == successor
        )
        from app.match_scoring import load_match_for_write
        from app.match_serialization import negotiation

        refreshed = await load_match_for_write(
            db_session, match.id, director.id, lock=False
        )
        assert [
            (g.score.side_1_points, g.score.side_2_points) for g in refreshed.games
        ] == [(4, 11)]
        assert [
            (s.score, s.won)
            for s in sorted(refreshed.sides, key=lambda s: s.side_number)
        ] == [(0, False), (1, True)]
        assert negotiation(refreshed, None).standing_result.games[0].side_2_points == 11
        with pytest.raises(DBAPIError) as error:
            await stale.execute(statement, {"new": uuid.uuid4(), "root": root.id})
        assert error.value.orig.sqlstate == "40001"
    with pytest.raises(IntegrityError, match="stale"):
        async with db_session.begin_nested():
            await db_session.execute(statement, {"new": uuid.uuid4(), "root": root.id})
    assert [r.id for r in await official_history(db_session, match.id)] == [
        root.id,
        successor,
    ]


async def test_sql_ruling_rejects_two_provenance_sources(db_session):
    import uuid

    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.official_results import official_history
    from tests._helpers import directed_tournament_match

    match, owner = await directed_tournament_match(
        db_session, tag="two-sources", best_of=1
    )
    await propose_result(
        db_session, match.id, owner.id, games=board(), supersedes_result_id=None
    )
    (root,) = await official_history(db_session, match.id)
    with pytest.raises(IntegrityError, match="single_source"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("""
                INSERT INTO match_official_results
                (id, match_id, revision, predecessor_id, proposal_id, restored_from_id,
                 resolution_method, actor_account_id, reason, tournament_id,
                 owner_revision, games)
                SELECT :new, match_id, 2, id, proposal_id, id,
                       resolution_method, actor_account_id, reason, tournament_id,
                       owner_revision, games
                FROM match_official_results WHERE id = :root
            """),
                {"new": uuid.uuid4(), "root": root.id},
            )


async def test_timeout_uses_database_clock_when_application_clock_is_ahead(
    db_session, monkeypatch
):
    from datetime import UTC, datetime, timedelta
    from unittest.mock import Mock

    from app.notifications.service import NotificationService
    from app.official_results import official_history
    from app.retirement_jobs import RetirementOutcome, retire_if_lapsed
    from tests._helpers import FakeSender, directed_tournament_match

    match, _ = await directed_tournament_match(
        db_session, tag="timeout-clock", best_of=1
    )
    match.match_settings.retirement_window = timedelta(days=1)
    await db_session.commit()
    player = min(match.sides, key=lambda s: s.side_number).players[0].user_id
    outcome = await propose_result(
        db_session, match.id, player, games=board(), supersedes_result_id=None
    )
    match_id, proposal_id = match.id, outcome.match.results[0].id
    clock = Mock(wraps=datetime)
    clock.now.return_value = datetime.now(UTC) + timedelta(days=2)
    monkeypatch.setattr("app.retirement_jobs.datetime", clock)
    assert (
        await retire_if_lapsed(
            db_session,
            match_id,
            proposal_id,
            NotificationService(db_session, FakeSender()),
        )
        == RetirementOutcome.not_yet_due
    )
    assert await official_history(db_session, match_id) == []


async def test_timeout_finalizes_after_both_participants_lose_managing_accounts(
    db_session,
):
    from datetime import timedelta

    from sqlalchemy import delete

    from app.models import AccountPlayer, MatchStatus
    from app.notifications.service import NotificationService
    from app.official_results import official_history
    from app.retirement_jobs import RetirementOutcome, retire_if_lapsed
    from tests._helpers import FakeSender, directed_tournament_match

    match, _ = await directed_tournament_match(
        db_session, tag="timeout-unmanaged", best_of=1
    )
    match.match_settings.retirement_window = timedelta(microseconds=1)
    await db_session.commit()
    sides = sorted(match.sides, key=lambda side: side.side_number)
    outcome = await propose_result(
        db_session,
        match.id,
        sides[0].players[0].user_id,
        games=board(),
        supersedes_result_id=None,
    )
    match_id, proposal_id = match.id, outcome.match.results[0].id
    assert outcome.match.results[0].participant_authorized
    await db_session.execute(
        delete(AccountPlayer).where(
            AccountPlayer.player_id.in_([side.players[0].user_id for side in sides])
        )
    )
    await db_session.commit()
    assert (
        await retire_if_lapsed(
            db_session,
            match_id,
            proposal_id,
            NotificationService(db_session, FakeSender()),
        )
        == RetirementOutcome.retired
    )
    (revision,) = await official_history(db_session, match_id)
    assert revision.resolution_method == "timeout"
    assert revision.actor_account_id is None
    await db_session.refresh(match)
    assert match.status == MatchStatus.completed


async def test_sweep_uses_database_clock_when_application_clock_is_behind(
    db_session, monkeypatch
):
    from datetime import UTC, datetime, timedelta
    from unittest.mock import Mock

    from app.notifications.service import NotificationService
    from app.official_results import official_history
    from app.retirement_jobs import RetirementOutcome, sweep_lapsed_retirements
    from tests._helpers import FakeSender, directed_tournament_match

    match, _ = await directed_tournament_match(db_session, tag="sweep-clock", best_of=1)
    match.match_settings.retirement_window = timedelta(microseconds=1)
    await db_session.commit()
    player = min(match.sides, key=lambda s: s.side_number).players[0].user_id
    await propose_result(
        db_session, match.id, player, games=board(), supersedes_result_id=None
    )
    clock = Mock(wraps=datetime)
    clock.now.return_value = datetime.now(UTC) - timedelta(days=2)
    monkeypatch.setattr("app.retirement_jobs.datetime", clock)
    assert await sweep_lapsed_retirements(
        db_session, NotificationService(db_session, FakeSender())
    ) == [RetirementOutcome.retired]
    assert len(await official_history(db_session, match.id)) == 1


async def test_sql_opponent_acceptance_rejects_same_account_managing_both_sides(
    db_session,
):
    import uuid

    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.models import AccountPlayer
    from tests._helpers import directed_tournament_match

    match, _ = await directed_tournament_match(
        db_session, tag="self-consent", best_of=1
    )
    sides = sorted(match.sides, key=lambda s: s.side_number)
    actor, opponent = (s.players[0].user_id for s in sides)
    db_session.add(AccountPlayer(account_id=actor, player_id=opponent))
    await db_session.commit()
    outcome = await propose_result(
        db_session, match.id, actor, games=board(), supersedes_result_id=None
    )
    proposal_id = outcome.match.results[0].id
    with pytest.raises(IntegrityError, match="opposing consent"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE match_results SET accepted_by_user_id = :actor, "
                    "accepted_at = clock_timestamp() WHERE id = :id"
                ),
                {"actor": actor, "id": proposal_id},
            )
            await db_session.execute(
                text("""
                INSERT INTO match_official_results
                (id, match_id, revision, proposal_id, resolution_method,
                 actor_account_id, games)
                SELECT :new, match_id, 1, id, 'opponent_acceptance',
                       accepted_by_user_id, games
                FROM match_results WHERE id = :id
            """),
                {"new": uuid.uuid4(), "id": proposal_id},
            )


async def test_sql_immediate_finalization_requires_managed_match_participant(
    db_session,
):
    import pytest
    from sqlalchemy.exc import IntegrityError

    from app.models import MatchResult
    from app.models.official_result import OfficialResult

    owner = await make_user(db_session, "immediate-owner")
    outsider = await make_user(db_session, "immediate-outsider")
    match = await create_match(
        db_session,
        creator=owner,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )
    for represented in (owner.id, outsider.id):
        with pytest.raises(IntegrityError, match="participant"):
            async with db_session.begin_nested():
                proposal = MatchResult(
                    match_id=match.id,
                    submitted_by_user_id=outsider.id,
                    submitted_for_player_id=represented,
                    games=[g.model_dump() for g in board()],
                )
                db_session.add(proposal)
                await db_session.flush()
                db_session.add(
                    OfficialResult(
                        match_id=match.id,
                        revision=1,
                        proposal_id=proposal.id,
                        resolution_method="immediate_finalization",
                        actor_account_id=outsider.id,
                        games=proposal.games,
                    )
                )
                await db_session.flush()


async def test_sql_cannot_add_participant_consent_after_official_finalization(
    db_session,
):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    player = await make_user(db_session, "late-consent")
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )
    outcome = await propose_result(
        db_session, match.id, player.id, games=board(), supersedes_result_id=None
    )
    with pytest.raises(IntegrityError, match="closed"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("""
                UPDATE match_results
                SET accepted_by_user_id = :actor, accepted_at = clock_timestamp()
                WHERE id = :id
            """),
                {"actor": player.id, "id": outcome.match.results[0].id},
            )

    with pytest.raises(IntegrityError, match="closed"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("""
                INSERT INTO match_results
                (id, match_id, submitted_by_user_id, submitted_for_player_id,
                 supersedes_result_id, accepted_by_user_id, accepted_at, games)
                SELECT gen_random_uuid(), match_id, submitted_by_user_id,
                       submitted_for_player_id, id, :actor, clock_timestamp(), games
                FROM match_results WHERE id = :id
            """),
                {"actor": player.id, "id": outcome.match.results[0].id},
            )


async def test_sql_root_revision_cannot_commit_without_match_completion(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.models import MatchResult
    from app.models.official_result import OfficialResult

    player = await make_user(db_session, "unfinished-official")
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )
    with pytest.raises(IntegrityError, match="completed"):
        async with db_session.begin_nested():
            proposal = MatchResult(
                match_id=match.id,
                submitted_by_user_id=player.id,
                submitted_for_player_id=player.id,
                games=[g.model_dump() for g in board()],
            )
            db_session.add(proposal)
            await db_session.flush()
            db_session.add(
                OfficialResult(
                    match_id=match.id,
                    revision=1,
                    proposal_id=proposal.id,
                    resolution_method="immediate_finalization",
                    actor_account_id=player.id,
                    games=proposal.games,
                )
            )
            await db_session.flush()
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_rated_casual_match_rejects_unclaimed_opponent(db_session):
    import pytest

    from app.match_errors import OpponentNotFoundError
    from app.models import Player

    creator = await make_user(db_session, "casual-claim-attacker")
    unclaimed = Player(username="director-entered-unclaimed")
    db_session.add(unclaimed)
    await db_session.commit()
    with pytest.raises(OpponentNotFoundError):
        await create_match(
            db_session,
            creator=creator,
            opponent_user_id=unclaimed.id,
            league_id=None,
            best_of=1,
            rated=True,
        )


async def test_sql_timeout_requires_participant_authority_at_submission(db_session):
    from datetime import UTC, datetime, timedelta

    import pytest
    from sqlalchemy.exc import IntegrityError

    from app.models import MatchResult
    from app.models.official_result import OfficialResult
    from tests._helpers import directed_tournament_match

    match, _ = await directed_tournament_match(
        db_session, tag="forged-timeout", best_of=1
    )
    outsider = await make_user(db_session, "forged-timeout-outsider")
    participant = min(match.sides, key=lambda s: s.side_number).players[0].user_id
    for represented in (participant, outsider.id):
        with pytest.raises(IntegrityError, match="participant authority"):
            async with db_session.begin_nested():
                proposal = MatchResult(
                    match_id=match.id,
                    submitted_by_user_id=outsider.id,
                    submitted_for_player_id=represented,
                    participant_authorized=True,
                    submitted_at=datetime.now(UTC) - timedelta(days=8),
                    games=[g.model_dump() for g in board()],
                )
                db_session.add(proposal)
                await db_session.flush()
                db_session.add(
                    OfficialResult(
                        match_id=match.id,
                        revision=1,
                        proposal_id=proposal.id,
                        resolution_method="timeout",
                        actor_account_id=None,
                        timeout_deadline=proposal.submitted_at
                        + match.match_settings.retirement_window,
                        timeout_policy="retirement_window_v1",
                        games=proposal.games,
                    )
                )
                await db_session.flush()


async def test_rated_casual_opponent_requires_primary_manager(db_session):
    import pytest
    from sqlalchemy import update

    from app.match_errors import OpponentNotFoundError
    from app.models import AccountPlayer

    creator = await make_user(db_session, "primary-manager-creator")
    opponent = await make_user(db_session, "secondary-only-opponent")
    await db_session.execute(
        update(AccountPlayer)
        .where(AccountPlayer.player_id == opponent.id)
        .values(is_primary=False)
    )
    await db_session.commit()
    with pytest.raises(OpponentNotFoundError):
        await create_match(
            db_session,
            creator=creator,
            opponent_user_id=opponent.id,
            league_id=None,
            best_of=1,
            rated=True,
        )


async def test_sql_consent_requires_the_acceptors_primary_player(db_session):
    import uuid

    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.models import AccountPlayer
    from tests._helpers import directed_tournament_match

    match, _ = await directed_tournament_match(
        db_session, tag="secondary-consent", best_of=1
    )
    sides = sorted(match.sides, key=lambda s: s.side_number)
    other = await make_user(db_session, "secondary-consent-manager")
    db_session.add(
        AccountPlayer(account_id=other.id, player_id=sides[1].players[0].user_id)
    )
    await db_session.commit()
    outcome = await propose_result(
        db_session,
        match.id,
        sides[0].players[0].user_id,
        games=board(),
        supersedes_result_id=None,
    )
    proposal_id = outcome.match.results[0].id
    with pytest.raises(IntegrityError, match="opposing consent"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE match_results SET accepted_by_user_id = :actor, "
                    "accepted_at = clock_timestamp() WHERE id = :id"
                ),
                {"actor": other.id, "id": proposal_id},
            )
            await db_session.execute(
                text("""
                INSERT INTO match_official_results
                (id, match_id, revision, proposal_id, resolution_method,
                 actor_account_id, games)
                SELECT :new, match_id, 1, id, 'opponent_acceptance',
                       accepted_by_user_id, games
                FROM match_results WHERE id = :id
            """),
                {"new": uuid.uuid4(), "id": proposal_id},
            )


async def test_rating_correction_reconciles_later_opponents_and_replay_is_idempotent(
    db_session,
):
    from sqlalchemy import select

    from app.models import RatingHistory, RatingHistorySource
    from app.official_results import correct_result, official_history
    from app.ratings.recompute import recompute_league_ratings
    from app.result_acceptance import accept_result
    from tests._helpers import directed_tournament_match

    match, director = await directed_tournament_match(
        db_session, tag="rating-replay", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (root,) = await official_history(db_session, match.id)
    player_id = min(match.sides, key=lambda s: s.side_number).players[0].user_id
    from app.models import Account

    player = await db_session.get(Account, player_id)
    third = await make_user(db_session, "rating-replay-third")
    later = await create_match(
        db_session,
        creator=player,
        opponent_user_id=third.id,
        league_id=match.league_id,
        best_of=1,
        rated=True,
    )
    outcome = await propose_result(
        db_session, later.id, player.id, games=board(), supersedes_result_id=None
    )
    await accept_result(
        db_session, later.id, third.id, result_id=outcome.match.results[0].id
    )
    query = (
        select(
            RatingHistory.match_id,
            RatingHistory.user_id,
            RatingHistory.rating_value,
            RatingHistory.rating_state,
            RatingHistory.previous_rating_value,
        )
        .where(
            RatingHistory.league_id == match.league_id,
            RatingHistory.source == RatingHistorySource.match,
        )
        .order_by(RatingHistory.match_id, RatingHistory.user_id)
    )
    before = (await db_session.execute(query)).all()
    assert len(before) == 4
    await correct_result(
        db_session,
        match.id,
        director.id,
        expected_revision_id=root.id,
        games=board(2),
        reason="Correct the scores and reconcile dependent ratings",
    )
    await db_session.commit()
    corrected = (await db_session.execute(query)).all()
    assert len(corrected) == 4
    assert corrected != before
    before_later = [row for row in before if row.match_id == later.id]
    corrected_later = [row for row in corrected if row.match_id == later.id]
    assert corrected_later != before_later
    await recompute_league_ratings(db_session, match.league_id, {player_id})
    await db_session.commit()
    assert (await db_session.execute(query)).all() == corrected


async def test_corrections_and_voids_hint_other_active_event_entrants(
    db_session, realtime_broker
):
    from sqlalchemy import select

    from app.models import TournamentEntry, TournamentFixture
    from app.official_results import (
        correct_result,
        official_history,
        void_official_match,
    )
    from app.realtime import EventKind
    from tests._helpers import directed_tournament_match
    from tests._realtime import watch_hints

    match, director = await directed_tournament_match(
        db_session, tag="ruling-audience", best_of=1
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (root,) = await official_history(db_session, match.id)
    third = await make_user(db_session, "ruling-other-entrant")
    outsider = await make_user(db_session, "ruling-outsider")
    event_id = await db_session.scalar(
        select(TournamentFixture.scope_event_id).where(
            TournamentFixture.match_id == match.id
        )
    )
    db_session.add(TournamentEntry(event_id=event_id, user_id=third.id))
    await db_session.commit()
    participant = min(match.sides, key=lambda s: s.side_number).players[0].user_id
    for action in ("correct", "void"):
        async with watch_hints(
            realtime_broker, participant, third.id, outsider.id
        ) as watch:
            if action == "correct":
                await correct_result(
                    db_session,
                    match.id,
                    director.id,
                    expected_revision_id=root.id,
                    games=board(2),
                    reason="Standings correction",
                )
            else:
                await void_official_match(
                    db_session, match.id, director.id, reason="Duplicate match"
                )
            await db_session.commit()
            hints = await watch.collect()
        assert hints[participant] == [EventKind.dashboard_changed]
        assert hints[third.id] == [EventKind.dashboard_changed]
        assert hints[outsider.id] == []
