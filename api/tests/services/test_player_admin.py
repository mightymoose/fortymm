import uuid

import pytest
from match_setup import add_account, add_match, add_player, in_transaction, merge
from sqlalchemy import Engine, insert, update
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, Email, PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.models import Account, Player, PlayerManager
from fortymm_api.services.matches import MatchDetails
from fortymm_api.services.player_admin import (
    PLAYER_PAGE_SIZE,
    AdminPlayer,
    Manager,
    PlayerNotFound,
    Survivor,
    get_player,
    list_players,
)


def named(session: Session, name: str) -> PlayerId:
    player = add_player(session)
    session.execute(update(Player).where(Player.id == player).values(display_name=name))
    return player


def verify(session: Session, account: AccountId, email: str) -> None:
    session.execute(update(Account).where(Account.id == account).values(email=email))


def manage(
    session: Session, account: AccountId, player: PlayerId, *, asked: bool = False
) -> None:
    session.execute(
        insert(PlayerManager).values(
            account_id=account,
            player_id=player,
            relationship="managed",
            adopted_from=add_account(session) if asked else None,
        )
    )


def test_lists_players_by_name_with_the_account_that_plays_as_each(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> tuple[PlayerId, PlayerId, AccountId]:
        ann, bo = named(session, "Ann"), named(session, "bo")
        account = add_account(session, plays_as=ann)
        verify(session, account, "ann@example.com")
        manage(session, add_account(session), ann)
        return ann, bo, account

    ann, bo, account = in_transaction(migrated_database, setup)

    page = in_transaction(migrated_database, lambda session: list_players(session, ""))

    assert page.players == [
        AdminPlayer(ann, "Ann", account, Email("ann@example.com"), 2),
        AdminPlayer(bo, "bo", None, None, 0),
    ]
    assert not page.has_more


def test_a_guests_player_has_no_email(migrated_database: Engine) -> None:
    def setup(session: Session) -> tuple[PlayerId, AccountId]:
        player = named(session, "Cy")
        return player, add_account(session, plays_as=player)

    player, account = in_transaction(migrated_database, setup)

    page = in_transaction(
        migrated_database, lambda session: list_players(session, None)
    )

    assert page.players == [AdminPlayer(player, "Cy", account, None, 1)]


def test_finds_players_by_part_of_their_name_whatever_its_case(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> None:
        for name in ("Bo", "100% Ann", "Annie"):
            named(session, name)

    in_transaction(migrated_database, setup)

    def find(term: str) -> list[str]:
        page = in_transaction(
            migrated_database, lambda session: list_players(session, term)
        )
        return [player.display_name for player in page.players]

    assert find("  ANN ") == ["100% Ann", "Annie"]
    # `%` matches itself, not any text.
    assert find("%") == ["100% Ann"]


def test_leaves_out_a_merged_player(migrated_database: Engine) -> None:
    def setup(session: Session) -> None:
        ann, old = named(session, "Ann"), named(session, "Ann old")
        merge(session, old, into=ann)

    in_transaction(migrated_database, setup)

    page = in_transaction(migrated_database, lambda session: list_players(session, ""))

    assert [player.display_name for player in page.players] == ["Ann"]


def test_lists_at_most_a_page(migrated_database: Engine) -> None:
    def setup(session: Session) -> None:
        for _ in range(PLAYER_PAGE_SIZE + 1):
            add_player(session)

    in_transaction(migrated_database, setup)

    page = in_transaction(migrated_database, lambda session: list_players(session, ""))

    assert len(page.players) == PLAYER_PAGE_SIZE
    assert page.has_more


def test_gets_a_player_with_its_managers_self_first_then_by_email_then_guests(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> tuple[PlayerId, list[AccountId]]:
        player = named(session, "Ann")
        me = add_account(session, plays_as=player)
        verify(session, me, "zed@example.com")
        guest = add_account(session)
        manage(session, guest, player, asked=True)
        coach = add_account(session)
        verify(session, coach, "coach@example.com")
        manage(session, coach, player)
        return player, [me, coach, guest]

    player, (me, coach, guest) = in_transaction(migrated_database, setup)

    found = in_transaction(
        migrated_database, lambda session: get_player(session, player)
    )

    assert found.display_name == "Ann"
    assert found.merged_into is None
    assert found.managers == (
        Manager(me, Email("zed@example.com"), "self", open_question=False),
        Manager(coach, Email("coach@example.com"), "managed", open_question=False),
        Manager(guest, None, "managed", open_question=True),
    )
    assert found.leagues == ("FortyMM",)


def test_counts_a_players_matches_with_those_of_players_merged_into_it(
    migrated_database: Engine,
) -> None:
    def setup(session: Session) -> PlayerId:
        ann, old, bo, cy = (add_player(session) for _ in range(4))
        add_match(session, MatchId(uuid.uuid4()), MatchDetails(3, False, (ann, bo)))
        add_match(session, MatchId(uuid.uuid4()), MatchDetails(3, False, (old, cy)))
        add_match(session, MatchId(uuid.uuid4()), MatchDetails(3, False, (bo, cy)))
        merge(session, old, into=ann)
        return ann

    ann = in_transaction(migrated_database, setup)

    found = in_transaction(migrated_database, lambda session: get_player(session, ann))

    assert found.match_count == 2


def test_a_merged_player_names_its_survivor(migrated_database: Engine) -> None:
    def setup(session: Session) -> tuple[PlayerId, PlayerId]:
        ann, old = named(session, "Ann"), named(session, "Ann old")
        merge(session, old, into=ann)
        return ann, old

    ann, old = in_transaction(migrated_database, setup)

    found = in_transaction(migrated_database, lambda session: get_player(session, old))

    assert found.merged_into == Survivor(ann, "Ann")


def test_refuses_an_unknown_player(migrated_database: Engine) -> None:
    with pytest.raises(PlayerNotFound):
        in_transaction(
            migrated_database,
            lambda session: get_player(session, PlayerId(uuid.uuid4())),
        )
