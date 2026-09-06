"""Player participation must belong to the match that owns its side (#1675)."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.db import Base
from app.match_creation import create_match
from app.models import Account, Player
from tests._migration_database import empty_database, migrated_database


@pytest.fixture(scope="session", params=["metadata", "alembic"])
async def engine(request, postgres_url):
    if request.param == "metadata":
        async with empty_database(postgres_url) as database:
            async with database.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            yield database
    else:
        async with migrated_database(postgres_url) as database:
            # Standard conftest fixtures supply representative catalogue seeds.
            async with database.begin() as connection:
                for table in reversed(Base.metadata.sorted_tables):
                    await connection.execute(table.delete())
            yield database


@pytest.fixture
async def matches(db_session):
    creator = Account(username="ownership-player")
    db_session.add(creator)
    await db_session.commit()
    result = []
    for _ in range(2):
        result.append(
            await create_match(
                db_session,
                creator=creator,
                opponent_user_id=None,
                league_id=None,
                best_of=3,
                rated=False,
            )
        )
    return result


async def test_sql_rejects_cross_match_participant_immediately(db_session, matches):
    first, second = matches
    player = Player(username="unclaimed-participant")
    db_session.add(player)
    await db_session.flush()
    with pytest.raises(IntegrityError, match="fk_match_side_players_side_match"):
        async with db_session.begin_nested():
            await db_session.execute(text("SET CONSTRAINTS ALL DEFERRED"))
            await db_session.execute(
                text("""
                    INSERT INTO match_side_players (match_side_id, match_id, user_id)
                    VALUES (:side, :match, :player)
                """),
                {
                    "side": first.sides[1].id,
                    "match": second.id,
                    "player": player.id,
                },
            )
            pytest.fail("cross-match participation was accepted before commit")


async def test_orm_rejects_contradictory_match_and_side(db_session, matches):
    from app.models import MatchSidePlayer

    first, second = matches
    player = Player(username="contradictory-participant")
    db_session.add(player)
    await db_session.flush()
    with pytest.raises(IntegrityError, match="fk_match_side_players_side_match"):
        async with db_session.begin_nested():
            participant = MatchSidePlayer(
                match=second, match_side=first.sides[1], user=player
            )
            db_session.add(participant)
            await db_session.flush()


@pytest.mark.parametrize(
    "change", ["participant_side", "participant_match", "side_match"]
)
async def test_sql_rejects_updates_that_break_ownership(db_session, matches, change):
    first, second = matches
    # Leave a real target match without memberships or conflicting side numbers.
    await db_session.execute(
        text("DELETE FROM match_sides WHERE match_id = :match"), {"match": second.id}
    )
    new_side = await db_session.scalar(
        text(
            "INSERT INTO match_sides (match_id, side_number) "
            "VALUES (:match, 2) RETURNING id"
        ),
        {"match": second.id},
    )
    participant = first.sides[0].players[0]
    statements = {
        "participant_side": (
            "UPDATE match_side_players SET match_side_id = :target WHERE id = :id",
            {"target": new_side, "id": participant.id},
        ),
        "participant_match": (
            "UPDATE match_side_players SET match_id = :target WHERE id = :id",
            {"target": second.id, "id": participant.id},
        ),
        "side_match": (
            "UPDATE match_sides SET match_id = :target WHERE id = :id",
            {"target": second.id, "id": first.sides[0].id},
        ),
    }
    statement, parameters = statements[change]
    with pytest.raises(IntegrityError, match="fk_match_side_players_side_match"):
        async with db_session.begin_nested():
            await db_session.execute(text("SET CONSTRAINTS ALL DEFERRED"))
            await db_session.execute(text(statement), parameters)
            pytest.fail("ownership-breaking update was accepted before commit")


@pytest.mark.parametrize("side_index", [0, 1], ids=["same-side", "opposing-side"])
async def test_sql_rejects_duplicate_player_in_match(db_session, matches, side_index):
    match = matches[0]
    with pytest.raises(IntegrityError, match="uq_match_side_players_"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("""
                    INSERT INTO match_side_players (match_side_id, match_id, user_id)
                    VALUES (:side, :match, :player)
                """),
                {
                    "side": match.sides[side_index].id,
                    "match": match.id,
                    "player": match.sides[0].players[0].user_id,
                },
            )


@pytest.mark.parametrize(
    "shape", [(1, 0), (1, 1), (2, 2)], ids=["solo", "singles", "doubles"]
)
async def test_sql_accepts_valid_match_participation(db_session, matches, shape):
    match = matches[0]
    await db_session.execute(
        text("UPDATE match_settings SET team_size = :size WHERE id = :id"),
        {"size": max(shape), "id": match.match_settings_id},
    )
    for side_index, size in enumerate(shape):
        existing = 1 if side_index == 0 else 0
        for position in range(existing, size):
            player_id = await db_session.scalar(
                text(
                    "INSERT INTO players (id, username) "
                    "VALUES (gen_random_uuid(), :name) RETURNING id"
                ),
                {"name": f"unclaimed-{side_index}-{position}"},
            )
            await db_session.execute(
                text("""
                    INSERT INTO match_side_players (match_side_id, match_id, user_id)
                    VALUES (:side, :match, :player)
                """),
                {
                    "side": match.sides[side_index].id,
                    "match": match.id,
                    "player": player_id,
                },
            )
    await db_session.commit()
    counts = (
        (
            await db_session.execute(
                text("""
                SELECT count(p.id) FROM match_sides s
                LEFT JOIN match_side_players p ON p.match_side_id = s.id
                WHERE s.match_id = :match
                GROUP BY s.side_number ORDER BY s.side_number
            """),
                {"match": match.id},
            )
        )
        .scalars()
        .all()
    )
    assert tuple(counts) == shape
    # The same Player may still participate in another match.
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM match_side_players WHERE match_id = :match"),
            {"match": matches[1].id},
        )
        == 1
    )


@pytest.mark.parametrize("parent", ["side", "match"])
async def test_sql_parent_deletion_cascades_only_its_participation(
    db_session, matches, parent
):
    first, second = matches
    player_id = first.sides[0].players[0].user_id
    statement, target = (
        ("DELETE FROM match_sides WHERE id = :id", first.sides[0].id)
        if parent == "side"
        else ("DELETE FROM matches WHERE id = :id", first.id)
    )
    await db_session.execute(text(statement), {"id": target})
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM match_side_players WHERE match_id = :id"),
            {"id": first.id},
        )
        == 0
    )
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM match_side_players WHERE match_id = :id"),
            {"id": second.id},
        )
        == 1
    )
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM players WHERE id = :id"), {"id": player_id}
        )
        == 1
    )
