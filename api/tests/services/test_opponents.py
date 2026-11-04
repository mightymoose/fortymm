"""The rules of picking an opponent: recent opponents with no search text,
players by name with it."""

import uuid

import pytest
from match_setup import add_account, add_match, add_player, in_transaction, merge
from sqlalchemy import Engine, update
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.models import Player
from fortymm_api.services.matches import MatchDetails
from fortymm_api.services.opponents import (
    RECENT_LIMIT,
    SEARCH_LIMIT,
    Opponent,
    opponents,
)


def find(database: Engine, account: AccountId, search: str | None) -> list[PlayerId]:
    return [
        player.id
        for player in in_transaction(
            database, lambda session: opponents(session, account, search)
        )
    ]


def player_named(session: Session, name: str) -> PlayerId:
    player = add_player(session)
    session.execute(update(Player).where(Player.id == player).values(display_name=name))
    return player


def play(database: Engine, first: PlayerId, second: PlayerId) -> None:
    """One match, in its own transaction, so each match is newer than the
    last."""
    in_transaction(
        database,
        lambda session: add_match(
            session, MatchId(uuid.uuid4()), MatchDetails(3, False, (first, second))
        ),
    )


def me(database: Engine) -> tuple[AccountId, PlayerId]:
    def make(session: Session) -> tuple[AccountId, PlayerId]:
        player = add_player(session)
        return add_account(session, plays_as=player), player

    return in_transaction(database, make)


def test_recent_opponents_come_most_recent_first_each_once(
    migrated_database: Engine,
) -> None:
    account, mine = me(migrated_database)
    bea, cat, dan = (in_transaction(migrated_database, add_player) for _ in range(3))
    play(migrated_database, mine, bea)
    play(migrated_database, cat, mine)
    play(migrated_database, mine, bea)
    play(migrated_database, cat, dan)

    assert find(migrated_database, account, None) == [bea, cat]
    assert find(migrated_database, account, "  ") == [bea, cat]


def test_recent_opponents_stop_at_the_limit(migrated_database: Engine) -> None:
    account, mine = me(migrated_database)
    faced = [in_transaction(migrated_database, add_player) for _ in range(13)]
    for opponent in faced:
        play(migrated_database, mine, opponent)

    assert find(migrated_database, account, None) == faced[::-1][:RECENT_LIMIT]


def test_recent_opponents_follow_merges_on_both_sides(
    migrated_database: Engine,
) -> None:
    account, mine = me(migrated_database)
    old_me, bea, bea_alias = (
        in_transaction(migrated_database, add_player) for _ in range(3)
    )
    play(migrated_database, old_me, bea_alias)
    play(migrated_database, mine, bea)
    play(migrated_database, mine, old_me)

    def merge_both(session: Session) -> None:
        merge(session, old_me, mine)
        merge(session, bea_alias, bea)

    in_transaction(migrated_database, merge_both)

    assert find(migrated_database, account, None) == [bea]


def test_an_account_with_no_self_player_or_no_matches_has_no_recent_opponents(
    migrated_database: Engine,
) -> None:
    lonely, _ = me(migrated_database)
    playerless = in_transaction(migrated_database, add_account)

    assert find(migrated_database, lonely, None) == []
    assert find(migrated_database, playerless, None) == []


def test_a_search_finds_names_containing_it_whatever_its_case(
    migrated_database: Engine,
) -> None:
    account, _ = me(migrated_database)

    def make(session: Session) -> list[PlayerId]:
        return [
            player_named(session, name)
            for name in ("Zesty Zebra 900", "brave badger 214", "bright BADGER 300")
        ]

    zebra, brave, bright = in_transaction(migrated_database, make)

    found = in_transaction(
        migrated_database, lambda session: opponents(session, account, " Badger ")
    )

    assert found == [
        Opponent(brave, "brave badger 214"),
        Opponent(bright, "bright BADGER 300"),
    ]
    assert find(migrated_database, account, "zebra") == [zebra]


@pytest.mark.parametrize("term", ["%", "_", "\\"])
def test_a_search_matches_like_wildcards_literally(
    migrated_database: Engine, term: str
) -> None:
    account, _ = me(migrated_database)
    literal = in_transaction(
        migrated_database, lambda session: player_named(session, f"odd {term} otter")
    )
    in_transaction(
        migrated_database, lambda session: player_named(session, "plain otter")
    )

    assert find(migrated_database, account, term) == [literal]


def test_a_search_leaves_out_merged_players_and_the_account_s_own(
    migrated_database: Engine,
) -> None:
    account, mine = me(migrated_database)

    def make(session: Session) -> tuple[PlayerId, PlayerId]:
        session.execute(
            update(Player).where(Player.id == mine).values(display_name="mine marmot")
        )
        merged = player_named(session, "merged marmot")
        survivor = player_named(session, "kept marmot")
        merge(session, merged, survivor)
        return merged, survivor

    _, survivor = in_transaction(migrated_database, make)

    assert find(migrated_database, account, "marmot") == [survivor]


def test_a_search_stops_at_the_limit(migrated_database: Engine) -> None:
    account, _ = me(migrated_database)
    named = in_transaction(
        migrated_database,
        lambda session: [
            player_named(session, f"quiet quail {n:03}")
            for n in range(SEARCH_LIMIT + 1)
        ],
    )

    assert find(migrated_database, account, "quiet quail") == named[:SEARCH_LIMIT]
