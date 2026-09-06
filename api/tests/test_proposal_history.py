"""Proposal history guarantees through SQL on a fresh Alembic database (#1676)."""

import asyncio
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.account_merge import merge_user
from app.match_creation import create_match
from app.models import Account


@pytest.fixture
async def proposal_match(db_session):
    creator = Account(username="proposal-player")
    db_session.add(creator)
    await db_session.commit()
    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=None,
        league_id=None,
        best_of=3,
        rated=False,
    )
    return match.id, creator.id, creator.player_id


async def append(db, match, predecessor=None, *, result_id=None):
    result_id = result_id or uuid.uuid4()
    await db.execute(
        text("""
            INSERT INTO match_results
                (id, match_id, submitted_by_user_id, submitted_for_player_id,
                 supersedes_result_id, games)
            VALUES (:id, :match, :actor, :player, :predecessor,
                    '[{"game_number": 1,"side_1_points": 11,"side_2_points": 7}]')
        """),
        dict(
            id=result_id,
            match=match[0],
            actor=match[1],
            player=match[2],
            predecessor=predecessor,
        ),
    )
    return result_id


async def wait_for_blocked(observer, backend_pid, attempt):
    async def observe():
        while True:
            if attempt.done():
                await attempt
                pytest.fail("competing write did not wait for the open transaction")
            if await observer.scalar(
                text("SELECT cardinality(pg_blocking_pids(:pid)) > 0"),
                dict(pid=backend_pid),
            ):
                return
            await asyncio.sleep(0.01)

    await asyncio.wait_for(observe(), timeout=5)


async def test_match_cannot_have_two_proposal_roots(db_session, proposal_match):
    await append(db_session, proposal_match)
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await append(db_session, proposal_match)


async def test_predecessor_must_belong_to_same_match(db_session, proposal_match):
    predecessor = await append(db_session, proposal_match)
    creator = await db_session.get(Account, proposal_match[1])
    other = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=None,
        league_id=None,
        best_of=3,
        rated=False,
    )
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await append(db_session, (other.id, *proposal_match[1:]), predecessor)


async def test_proposal_cannot_precede_itself(db_session, proposal_match):
    result_id = uuid.uuid4()
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await append(db_session, proposal_match, result_id, result_id=result_id)


async def test_circular_batch_cannot_create_a_rootless_chain(
    db_session, proposal_match
):
    first, second, third = (uuid.uuid4() for _ in range(3))
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(text("SET CONSTRAINTS ALL DEFERRED"))
            await db_session.execute(
                text("""
                    INSERT INTO match_results
                        (id, match_id, submitted_by_user_id,
                         supersedes_result_id, games)
                    VALUES (:a, :match, :actor, :c, '[]'),
                           (:b, :match, :actor, :a, '[]'),
                           (:c, :match, :actor, :b, '[]')
                """),
                dict(
                    a=first,
                    b=second,
                    c=third,
                    match=proposal_match[0],
                    actor=proposal_match[1],
                ),
            )


@pytest.mark.parametrize(
    "assignment",
    [
        "id = gen_random_uuid()",
        "match_id = :other_match",
        "supersedes_result_id = :tail",
        "games = '[]'",
        "submitted_by_user_id = :other",
        "submitted_at = submitted_at + interval '1 second'",
    ],
)
async def test_proposal_snapshot_and_links_cannot_be_rewritten(
    db_session,
    proposal_match,
    assignment,
):
    root = await append(db_session, proposal_match)
    tail = None
    if assignment == "supersedes_result_id = :tail":
        middle = await append(db_session, proposal_match, root)
        tail = await append(db_session, proposal_match, middle)
    other = Account(username="other-actor")
    db_session.add(other)
    await db_session.flush()
    other_match = await create_match(
        db_session,
        creator=other,
        opponent_user_id=None,
        league_id=None,
        best_of=3,
        rated=False,
    )
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(f"UPDATE match_results SET {assignment} WHERE id = :id"),
                dict(id=root, tail=tail, other=other.id, other_match=other_match.id),
            )


@pytest.mark.parametrize("target", ["root", "tail", "match"])
async def test_proposal_history_cannot_be_deleted(db_session, proposal_match, target):
    root = await append(db_session, proposal_match)
    tail = await append(db_session, proposal_match, root)
    table = "matches" if target == "match" else "match_results"
    row_id = {"root": root, "tail": tail, "match": proposal_match[0]}[target]
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(f"DELETE FROM {table} WHERE id = :id"),
                {"id": row_id},
            )


async def accept(db, result_id, actor):
    await db.execute(
        text("""UPDATE match_results
                SET accepted_by_user_id = :actor, accepted_at = now()
                WHERE id = :id"""),
        dict(id=result_id, actor=actor),
    )


@pytest.mark.parametrize(
    "assignment",
    [
        "accepted_at = accepted_at + interval '1 second'",
        "accepted_by_user_id = :other",
        "accepted_by_user_id = NULL, accepted_at = NULL",
    ],
)
async def test_acceptance_cannot_be_rewritten(db_session, proposal_match, assignment):
    result_id = await append(db_session, proposal_match)
    await accept(db_session, result_id, proposal_match[1])
    other = Account(username="other-acceptor")
    db_session.add(other)
    await db_session.flush()
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(f"UPDATE match_results SET {assignment} WHERE id = :id"),
                dict(id=result_id, other=other.id),
            )


async def test_only_the_head_can_receive_acceptance(db_session, proposal_match):
    root = await append(db_session, proposal_match)
    head = await append(db_session, proposal_match, root)
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await accept(db_session, root, proposal_match[1])
    await accept(db_session, head, proposal_match[1])
    # Accepted history is not terminal: future director corrections can append.
    correction = await append(db_session, proposal_match, head)
    await accept(db_session, correction, proposal_match[1])


@pytest.mark.parametrize("isolation", ["READ COMMITTED", "REPEATABLE READ"])
async def test_acceptance_cannot_race_past_an_append(
    db_session,
    engine,
    proposal_match,
    isolation,
):
    root = await append(db_session, proposal_match)
    await db_session.commit()
    async with engine.connect() as writer, engine.connect() as reader:
        await reader.execution_options(isolation_level=isolation)
        # Fix the second transaction's snapshot before the append commits.
        await reader.execute(text("SELECT count(*) FROM match_results"))
        reader_pid = await reader.scalar(text("SELECT pg_backend_pid()"))
        await append(writer, proposal_match, root)
        attempt = asyncio.create_task(accept(reader, root, proposal_match[1]))
        try:
            await wait_for_blocked(writer, reader_pid, attempt)
            await writer.commit()
            with pytest.raises(DBAPIError) as error:
                await asyncio.wait_for(attempt, timeout=5)
            assert error.value.orig.sqlstate in {"23514", "40001"}
        finally:
            if not attempt.done():
                attempt.cancel()
            await asyncio.gather(attempt, return_exceptions=True)


@pytest.mark.parametrize("direction", ["other", "to_null", "from_null"])
async def test_represented_player_cannot_be_arbitrarily_reassigned(
    db_session,
    proposal_match,
    direction,
):
    other = Account(username="unrelated-player")
    db_session.add(other)
    await db_session.flush()
    initial = (
        (*proposal_match[:2], None) if direction == "from_null" else proposal_match
    )
    result_id = await append(db_session, initial)
    replacement = None if direction == "to_null" else other.player_id
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE match_results SET submitted_for_player_id = :player "
                    "WHERE id = :id"
                ),
                dict(id=result_id, player=replacement),
            )


async def test_same_person_merge_moves_representation_but_preserves_actors(
    db_session,
    proposal_match,
):
    result_id = await append(db_session, proposal_match)
    await accept(db_session, result_id, proposal_match[1])
    before = (
        (
            await db_session.execute(
                text("SELECT * FROM match_results WHERE id = :id"),
                dict(id=result_id),
            )
        )
        .mappings()
        .one()
    )
    survivor = Account(username="merge-survivor")
    db_session.add(survivor)
    await db_session.commit()
    await merge_user(db_session, from_user_id=proposal_match[1], to_user_id=survivor.id)
    await db_session.commit()
    after = (
        (
            await db_session.execute(
                text("SELECT * FROM match_results WHERE id = :id"),
                dict(id=result_id),
            )
        )
        .mappings()
        .one()
    )
    assert dict(after) == {**before, "submitted_for_player_id": survivor.player_id}


async def test_merge_record_cannot_be_erased_after_repointing_history(
    db_session,
    proposal_match,
):
    result_id = await append(db_session, proposal_match)
    survivor = Account(username="sql-merge-survivor")
    db_session.add(survivor)
    await db_session.flush()
    await db_session.execute(
        text(
            "UPDATE players SET merged_into_player_id = :target, merged_at = now() "
            "WHERE id = :source"
        ),
        dict(source=proposal_match[2], target=survivor.player_id),
    )
    assert (
        await db_session.scalar(
            text("SELECT submitted_for_player_id FROM match_results WHERE id = :id"),
            dict(id=result_id),
        )
        == survivor.player_id
    )
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE players SET merged_into_player_id = NULL, merged_at = NULL "
                    "WHERE id = :id"
                ),
                dict(id=proposal_match[2]),
            )


@pytest.mark.parametrize(
    "has_root", [False, True], ids=["duplicate-roots", "branching"]
)
async def test_concurrent_appends_have_one_winner(
    db_session,
    engine,
    proposal_match,
    has_root,
):
    predecessor = await append(db_session, proposal_match) if has_root else None
    await db_session.commit()
    ready = asyncio.Barrier(2)

    async def compete():
        async with engine.connect() as connection:
            await ready.wait()
            try:
                result_id = await append(connection, proposal_match, predecessor)
                await connection.commit()
                return result_id
            except IntegrityError as exc:
                assert exc.orig.sqlstate == "23505"
                return None

    outcomes = await asyncio.wait_for(asyncio.gather(compete(), compete()), timeout=10)
    assert sum(result is not None for result in outcomes) == 1
    assert await db_session.scalar(
        text("SELECT count(*) FROM match_results WHERE match_id = :match"),
        dict(match=proposal_match[0]),
    ) == (2 if has_root else 1)


async def test_rolling_back_a_merge_restores_proposal_representation(
    db_session,
    proposal_match,
):
    result_id = await append(db_session, proposal_match)
    survivor = Account(username="rollback-survivor")
    db_session.add(survivor)
    await db_session.commit()
    transaction = await db_session.begin_nested()
    await db_session.execute(
        text(
            "UPDATE players SET merged_into_player_id = :target, merged_at = now() "
            "WHERE id = :source"
        ),
        dict(source=proposal_match[2], target=survivor.player_id),
    )
    query = text("SELECT submitted_for_player_id FROM match_results WHERE id = :id")
    assert await db_session.scalar(query, dict(id=result_id)) == survivor.player_id
    await transaction.rollback()
    assert await db_session.scalar(query, dict(id=result_id)) == proposal_match[2]
    assert (
        await db_session.scalar(
            text("SELECT merged_into_player_id FROM players WHERE id = :id"),
            dict(id=proposal_match[2]),
        )
        is None
    )


@pytest.mark.parametrize("isolation", ["READ COMMITTED", "REPEATABLE READ"])
async def test_proposal_cannot_race_past_a_player_merge(
    db_session,
    engine,
    proposal_match,
    isolation,
):
    survivor = Account(username="concurrent-merge-survivor")
    db_session.add(survivor)
    await db_session.commit()
    async with engine.connect() as merger, engine.connect() as poster:
        await poster.execution_options(isolation_level=isolation)
        await poster.execute(text("SELECT count(*) FROM players"))
        poster_pid = await poster.scalar(text("SELECT pg_backend_pid()"))
        await merger.execute(
            text(
                "UPDATE players SET merged_into_player_id = :target, merged_at = now() "
                "WHERE id = :source"
            ),
            dict(source=proposal_match[2], target=survivor.player_id),
        )
        attempt = asyncio.create_task(append(poster, proposal_match))
        try:
            await wait_for_blocked(merger, poster_pid, attempt)
            await merger.commit()
            with pytest.raises(DBAPIError) as error:
                await asyncio.wait_for(attempt, timeout=5)
            assert error.value.orig.sqlstate in {"23514", "40001"}
        finally:
            if not attempt.done():
                attempt.cancel()
            await asyncio.gather(attempt, return_exceptions=True)


@pytest.mark.parametrize("isolation", ["READ COMMITTED", "REPEATABLE READ"])
async def test_player_merge_cannot_miss_an_uncommitted_proposal(
    db_session,
    engine,
    proposal_match,
    isolation,
):
    survivor = Account(username="merge-after-proposal")
    db_session.add(survivor)
    await db_session.commit()
    merge = text(
        "UPDATE players SET merged_into_player_id = :target, merged_at = now() "
        "WHERE id = :source"
    )
    params = dict(source=proposal_match[2], target=survivor.player_id)
    async with engine.connect() as poster, engine.connect() as merger:
        await merger.execution_options(isolation_level=isolation)
        await merger.execute(text("SELECT count(*) FROM match_results"))
        merger_pid = await merger.scalar(text("SELECT pg_backend_pid()"))
        result_id = await append(poster, proposal_match)
        attempt = asyncio.create_task(merger.execute(merge, params))
        try:
            await wait_for_blocked(poster, merger_pid, attempt)
            await poster.commit()
            try:
                await asyncio.wait_for(attempt, timeout=5)
                await merger.commit()
            except DBAPIError as exc:
                assert isolation == "REPEATABLE READ" and exc.orig.sqlstate == "40001"
                await merger.rollback()
                await merger.execute(merge, params)
                await merger.commit()
            assert (
                await poster.scalar(
                    text(
                        "SELECT submitted_for_player_id FROM match_results "
                        "WHERE id = :id"
                    ),
                    dict(id=result_id),
                )
                == survivor.player_id
            )
        finally:
            if not attempt.done():
                attempt.cancel()
            await asyncio.gather(attempt, return_exceptions=True)


async def test_recorded_player_merge_cannot_be_deleted(db_session, proposal_match):
    await append(db_session, proposal_match)
    survivor = Account(username="retained-merge-survivor")
    db_session.add(survivor)
    await db_session.commit()
    await merge_user(db_session, from_user_id=proposal_match[1], to_user_id=survivor.id)
    await db_session.commit()
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text("DELETE FROM players WHERE id = :source"),
                dict(source=proposal_match[2]),
            )


@pytest.mark.parametrize("head_accepted", [False, True])
async def test_match_details_show_the_head_instead_of_historical_acceptance(
    api_client,
    db_session,
    proposal_match,
    head_accepted,
):
    root = await append(db_session, proposal_match)
    await accept(db_session, root, proposal_match[1])
    await db_session.commit()
    head = await append(db_session, proposal_match, root)
    if head_accepted:
        await accept(db_session, head, proposal_match[1])
    await db_session.commit()
    db_session.expire_all()
    response = await api_client.get(f"/v1/matches/{proposal_match[0]}")
    assert response.status_code == 200
    result = response.json()["negotiation"]
    assert result["standing_result"]["id"] == str(head)
    assert result["viewer_state"] == ("final" if head_accepted else "review")
