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


async def test_correction_preserves_rating_output_and_downstream_fixtures(db_session):
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
    ).all() == ratings
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
               actor_account_id, 'Database ruling', tournament_id, owner_revision, games
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
        await db_session.commit()
        assert (
            await db_session.scalar(
                text("SELECT current_official_result_id FROM matches WHERE id = :id"),
                {"id": match.id},
            )
            == successor
        )
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
