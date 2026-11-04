"""The rules of making a match."""

import uuid
from collections.abc import Callable

import pytest
from locks import wait_behind
from match_setup import add_account, add_player, in_transaction, merge
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.models import Match, MatchSidePlayer
from fortymm_api.services.matches import (
    Created,
    Difference,
    Found,
    MatchDetails,
    Refusal,
    Refused,
    SamePlayer,
    UnknownPlayer,
    create_match,
    stored_details,
)

MATCH = MatchId(uuid.UUID("01970000-0000-7000-8000-000000000001"))


def two_players(database: Engine) -> tuple[AccountId, PlayerId, PlayerId]:
    """An account playing as Ann, and Bea, a player nobody manages."""

    def make(session: Session) -> tuple[AccountId, PlayerId, PlayerId]:
        ann = add_player(session)
        return add_account(session, plays_as=ann), ann, add_player(session)

    return in_transaction(database, make)


def create(
    database: Engine, details: MatchDetails, account: AccountId, match: MatchId = MATCH
) -> Created | Found | Refused:
    return in_transaction(
        database, lambda session: create_match(session, match, details, account)
    )


def match_count(database: Engine) -> int:
    return in_transaction(
        database, lambda session: session.scalars(select(func.count(Match.id))).one()
    )


def test_a_created_match_has_its_details_and_creator(
    migrated_database: Engine,
) -> None:
    account, ann, bea = two_players(migrated_database)

    created = create(migrated_database, MatchDetails(5, True, (ann, bea)), account)

    assert created == Created(MATCH)
    details, creator = in_transaction(
        migrated_database,
        lambda session: (
            stored_details(session, session.get_one(Match, MATCH)),
            session.get_one(Match, MATCH).created_by,
        ),
    )
    assert details == MatchDetails(5, True, (ann, bea))
    assert creator == account


def test_the_creator_needs_not_play(migrated_database: Engine) -> None:
    _, ann, bea = two_players(migrated_database)
    bystander = in_transaction(migrated_database, add_account)

    created = create(migrated_database, MatchDetails(3, False, (ann, bea)), bystander)

    assert isinstance(created, Created)


def test_creating_it_again_finds_the_same_match(migrated_database: Engine) -> None:
    account, ann, bea = two_players(migrated_database)
    details = MatchDetails(3, False, (ann, bea))
    first = create(migrated_database, details, account)
    assert isinstance(first, Created)

    again = create(migrated_database, details, account)

    assert again == Found(MATCH)
    assert match_count(migrated_database) == 1


@pytest.mark.parametrize(
    ("change", "differences"),
    [
        pytest.param(lambda d, p: MatchDetails(5, d.rated, d.players), {"best_of"}),
        pytest.param(lambda d, p: MatchDetails(d.best_of, True, d.players), {"rated"}),
        pytest.param(
            lambda d, p: MatchDetails(d.best_of, d.rated, (d.players[1], d.players[0])),
            {"players"},
            id="sides swapped",
        ),
        pytest.param(
            lambda d, p: MatchDetails(d.best_of, d.rated, (d.players[0], p)),
            {"players"},
            id="another opponent",
        ),
        pytest.param(
            lambda d, p: MatchDetails(7, True, (d.players[0], p)),
            {"players", "best_of", "rated"},
            id="everything",
        ),
    ],
)
def test_a_create_with_other_details_is_refused_with_what_differs(
    migrated_database: Engine,
    change: Callable[[MatchDetails, PlayerId], MatchDetails],
    differences: set[Difference],
) -> None:
    account, ann, bea = two_players(migrated_database)
    details = MatchDetails(3, False, (ann, bea))
    create(migrated_database, details, account)
    other = in_transaction(migrated_database, add_player)

    refused = create(migrated_database, change(details, other), account)

    assert refused == Refused(Refusal.MATCH_DIFFERS, frozenset(differences))


def test_a_merged_player_is_stored_as_its_survivor(migrated_database: Engine) -> None:
    account, ann, bea = two_players(migrated_database)
    alias = in_transaction(migrated_database, add_player)
    in_transaction(migrated_database, lambda session: merge(session, alias, ann))

    created = create(migrated_database, MatchDetails(3, False, (alias, bea)), account)
    again = create(migrated_database, MatchDetails(3, False, (ann, bea)), account)

    assert isinstance(created, Created)
    assert again == Found(MATCH)
    stored = in_transaction(
        migrated_database,
        lambda session: set(
            session.scalars(
                select(MatchSidePlayer.player_id).where(
                    MatchSidePlayer.match_id == MATCH
                )
            )
        ),
    )
    assert stored == {ann, bea}


def test_a_create_from_before_a_merge_finds_the_match(
    migrated_database: Engine,
) -> None:
    account, ann, bea = two_players(migrated_database)
    first = create(migrated_database, MatchDetails(3, False, (ann, bea)), account)
    assert isinstance(first, Created)
    newer = in_transaction(migrated_database, add_player)
    in_transaction(migrated_database, lambda session: merge(session, newer, ann))

    again = create(migrated_database, MatchDetails(3, False, (newer, bea)), account)

    assert isinstance(again, Found)


def test_a_create_after_its_players_merged_finds_the_match(
    migrated_database: Engine,
) -> None:
    account, ann, bea = two_players(migrated_database)
    first = create(migrated_database, MatchDetails(3, False, (ann, bea)), account)
    assert isinstance(first, Created)
    in_transaction(migrated_database, lambda session: merge(session, bea, ann))

    again = create(migrated_database, MatchDetails(3, False, (ann, bea)), account)

    assert again == Found(MATCH)


def test_a_match_with_an_unknown_player_is_not_made(
    migrated_database: Engine,
) -> None:
    account, ann, _ = two_players(migrated_database)
    nobody = PlayerId(uuid.uuid4())

    with pytest.raises(UnknownPlayer):
        create(migrated_database, MatchDetails(3, False, (ann, nobody)), account)
    assert match_count(migrated_database) == 0


def test_one_player_on_both_sides_is_not_made(migrated_database: Engine) -> None:
    account, ann, _ = two_players(migrated_database)
    alias = in_transaction(migrated_database, add_player)
    in_transaction(migrated_database, lambda session: merge(session, alias, ann))

    with pytest.raises(SamePlayer):
        create(migrated_database, MatchDetails(3, False, (ann, ann)), account)
    with pytest.raises(SamePlayer):
        create(migrated_database, MatchDetails(3, False, (alias, ann)), account)
    assert match_count(migrated_database) == 0


def test_two_creates_of_one_match_take_turns(migrated_database: Engine) -> None:
    account, ann, bea = two_players(migrated_database)
    details = MatchDetails(3, False, (ann, bea))

    first, second = wait_behind(
        migrated_database,
        lambda session: create_match(session, MATCH, details, account),
        lambda session: create_match(session, MATCH, details, account),
    )

    assert isinstance(first, Created)
    assert second.result() == Found(MATCH)
    assert match_count(migrated_database) == 1
