import uuid
from datetime import UTC, datetime, timedelta

from match_setup import add_match, add_player, in_transaction, merge
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from fortymm_api.accounts import PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.services.matches import MatchDetails
from fortymm_api.services.player_matches import (
    RECENT_LIMIT,
    PlayedMatches,
    RecentMatch,
    has_played,
    played_matches,
)

START = datetime(2026, 11, 1, 18, tzinfo=UTC)


def made(
    session: Session,
    players: tuple[PlayerId, PlayerId],
    at: datetime = START,
) -> MatchId:
    """A match between `players` with no result, made at `at`."""
    match = MatchId(uuid.uuid4())
    add_match(session, match, MatchDetails(3, False, players), created_at=at)
    return match


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
    def setup(session: Session) -> tuple[PlayerId, PlayerId, MatchId]:
        ann, bo = add_player(session), add_player(session)
        return ann, bo, made(session, (ann, bo))

    ann, bo, match = in_transaction(migrated_database, setup)

    found = in_transaction(
        migrated_database, lambda session: played_matches(session, [ann, bo])
    )

    assert found == {
        ann: PlayedMatches(1, (RecentMatch(match, START),)),
        bo: PlayedMatches(1, (RecentMatch(match, START),)),
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
