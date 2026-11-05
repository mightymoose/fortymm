import uuid
from datetime import UTC, datetime, timedelta

from match_setup import add_match, add_player, add_result, in_transaction, merge
from sqlalchemy import Engine, insert, select
from sqlalchemy.orm import Session

from fortymm_api.accounts import PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.models import MatchSide, MatchSidePlayer, Player
from fortymm_api.services.matches import MatchDetails
from fortymm_api.services.player_matches import (
    RECENT_LIMIT,
    PlayedMatches,
    RecentMatch,
    RecentResult,
    has_played,
    played_matches,
)
from fortymm_api.signed_results import (
    Completed,
    Ending,
    GamePoints,
    MatchResult,
    Retired,
)

START = datetime(2026, 11, 1, 18, tzinfo=UTC)
COMPLETED = Completed()


def made(
    session: Session,
    players: tuple[PlayerId, PlayerId],
    at: datetime = START,
) -> MatchId:
    """A match between `players` with no result, made at `at`."""
    match = MatchId(uuid.uuid4())
    add_match(session, match, MatchDetails(3, False, players), created_at=at)
    return match


def name_of(session: Session, player: PlayerId) -> str:
    return session.scalars(select(Player.display_name).where(Player.id == player)).one()


def scored(
    session: Session,
    players: tuple[PlayerId, PlayerId],
    games: tuple[GamePoints, ...],
    ending: Ending = COMPLETED,
) -> MatchId:
    """A best of 3 between `players`, with `games` as its current result."""
    match = made(session, players)
    add_result(session, MatchResult(match, 3, False, players, games, ending))
    return match


def recent(database: Engine, player: PlayerId) -> RecentMatch:
    """The player's only recent match."""
    [found] = in_transaction(
        database, lambda session: played_matches(session, [player])
    )[player].recent
    return found


def test_a_player_in_no_match_has_not_played(migrated_database: Engine) -> None:
    player = in_transaction(migrated_database, add_player)

    found = in_transaction(
        migrated_database, lambda session: played_matches(session, [player])
    )

    assert found == {player: PlayedMatches(0, ())}
    assert not in_transaction(
        migrated_database, lambda session: has_played(session, player)
    )


def test_a_match_with_no_result_counts_for_both_players(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> tuple[PlayerId, PlayerId, MatchId, str, str]:
        ann, bo = add_player(session), add_player(session)
        match = made(session, (ann, bo))
        return ann, bo, match, name_of(session, ann), name_of(session, bo)

    ann, bo, match, ann_name, bo_name = in_transaction(migrated_database, setup)

    found = in_transaction(
        migrated_database, lambda session: played_matches(session, [ann, bo])
    )

    assert found == {
        ann: PlayedMatches(1, (RecentMatch(match, START, (bo_name,), None),)),
        bo: PlayedMatches(1, (RecentMatch(match, START, (ann_name,), None),)),
    }
    assert in_transaction(migrated_database, lambda session: has_played(session, ann))


def test_recent_matches_are_the_latest_newest_first(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> tuple[PlayerId, list[MatchId]]:
        ann, bo = add_player(session), add_player(session)
        matches = [
            made(session, (ann, bo), START + timedelta(hours=hour))
            for hour in range(RECENT_LIMIT + 2)
        ]
        return ann, matches

    ann, matches = in_transaction(migrated_database, setup)

    found = in_transaction(
        migrated_database, lambda session: played_matches(session, [ann])
    )[ann]

    assert found.count == RECENT_LIMIT + 2
    assert [match.id for match in found.recent] == matches[::-1][:RECENT_LIMIT]


def test_a_player_counts_the_matches_of_players_merged_into_it(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> tuple[PlayerId, PlayerId]:
        ann, old, bo = add_player(session), add_player(session), add_player(session)
        made(session, (ann, bo))
        made(session, (old, bo), START + timedelta(hours=1))
        merge(session, old, into=ann)
        return ann, old

    ann, old = in_transaction(migrated_database, setup)

    found = in_transaction(
        migrated_database, lambda session: played_matches(session, [ann])
    )

    assert found[ann].count == 2
    # A merged player still has its own matches, for the admin page.
    merged = in_transaction(
        migrated_database, lambda session: played_matches(session, [old])
    )
    assert merged[old].count == 1


def test_a_match_counts_once_when_both_sides_merged_into_one_player(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> PlayerId:
        ann, old = add_player(session), add_player(session)
        made(session, (ann, old))
        merge(session, old, into=ann)
        return ann

    ann = in_transaction(migrated_database, setup)

    found = in_transaction(
        migrated_database, lambda session: played_matches(session, [ann])
    )

    assert found[ann].count == 1
    assert len(found[ann].recent) == 1


def test_an_opponent_is_named_by_its_survivor(migrated_database: Engine) -> None:
    def setup(session: Session) -> tuple[PlayerId, str]:
        ann, old, sam = add_player(session), add_player(session), add_player(session)
        made(session, (ann, old))
        merge(session, old, into=sam)
        return ann, name_of(session, sam)

    ann, sam_name = in_transaction(migrated_database, setup)

    assert recent(migrated_database, ann).opponents == (sam_name,)


def test_the_other_sides_players_are_in_name_order(migrated_database: Engine) -> None:
    # A side of two fails the team size check at commit, so this rolls back.
    with Session(migrated_database) as session:
        ann, zed, amy = (
            add_player(session, "ann"),
            add_player(session, "zed"),
            add_player(session, "amy"),
        )
        match = made(session, (ann, zed))
        side = session.scalars(
            select(MatchSide.id).where(MatchSide.match_id == match, MatchSide.side == 1)
        ).one()
        session.execute(
            insert(MatchSidePlayer).values(
                match_side_id=side, match_id=match, player_id=amy
            )
        )

        [found] = played_matches(session, [ann])[ann].recent

        assert found.opponents == (name_of(session, amy), name_of(session, zed))
        session.rollback()


def test_a_match_with_no_other_side_has_no_opponents(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> PlayerId:
        ann, old = add_player(session), add_player(session)
        scored(session, (ann, old), ((11, 5), (11, 7)))
        merge(session, old, into=ann)
        return ann

    ann = in_transaction(migrated_database, setup)

    found = recent(migrated_database, ann)
    assert found.opponents == ()
    # Both sides are the player's, so neither won.
    assert found.result is None


def test_a_completed_result_is_from_each_players_side(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> tuple[PlayerId, PlayerId]:
        ann, bo = add_player(session), add_player(session)
        scored(session, (ann, bo), ((11, 5), (9, 11), (11, 7)))
        return ann, bo

    ann, bo = in_transaction(migrated_database, setup)

    assert recent(migrated_database, ann).result == RecentResult(True, (2, 1))
    assert recent(migrated_database, bo).result == RecentResult(False, (1, 2))


def test_a_retired_player_lost_and_an_unfinished_game_counts_for_nobody(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> tuple[PlayerId, PlayerId]:
        ann, bo = add_player(session), add_player(session)
        scored(session, (ann, bo), ((11, 5), (3, 7)), Retired(by=0))
        return ann, bo

    ann, bo = in_transaction(migrated_database, setup)

    assert recent(migrated_database, ann).result == RecentResult(False, (1, 0))
    assert recent(migrated_database, bo).result == RecentResult(True, (0, 1))


def test_a_result_counts_for_the_player_merged_into(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> tuple[PlayerId, str]:
        ann, old, bo = add_player(session), add_player(session), add_player(session)
        scored(session, (bo, old), ((11, 5), (11, 7)))
        merge(session, old, into=ann)
        return ann, name_of(session, bo)

    ann, bo_name = in_transaction(migrated_database, setup)

    found = recent(migrated_database, ann)
    assert found.opponents == (bo_name,)
    assert found.result == RecentResult(False, (0, 2))
