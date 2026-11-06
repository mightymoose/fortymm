import uuid
from collections.abc import Callable
from dataclasses import dataclass
from ipaddress import ip_address

import pytest
from locks import wait_behind
from match_setup import add_match
from match_setup import add_player as add_opponent
from sqlalchemy import Engine, text, update
from sqlalchemy.orm import Session, sessionmaker

from fortymm_api.accounts import AccountId, Email, PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.models import Account, Player, PlayerManager
from fortymm_api.services.adoption import adopt_guest, hand_over_players
from fortymm_api.services.matches import MatchDetails
from fortymm_api.services.player_merge import Merged
from fortymm_api.services.players import (
    AccountPlayer,
    Answer,
    Answered,
    PlayerNotManaged,
    QuestionClosed,
    Relationship,
    Reply,
    SameAs,
    SameAsItself,
    Settled,
    account_players,
    answer_question,
)
from fortymm_api.services.sessions import AccountAdopted, start_session

# A sign-in asks "Is this you?" only about a player that has played.
pytestmark = pytest.mark.usefixtures("players_have_activity")

ANN = ip_address("203.0.113.7")
EGRET = "excited egret 387"
# The answers that need no other player.
PLAIN_ANSWERS: list[Reply] = [Answer.YES, Answer.NO, Answer.NOT_MINE]


def in_transaction[T](database: Engine, work: Callable[[Session], T]) -> T:
    with sessionmaker(database).begin() as session:
        return work(session)


@dataclass(frozen=True)
class Question:
    """An open "Is this you?" question: the account, the player it asks
    about, and the guest account the player came from. `relationship` is
    the player's while the question is open, and `token` is a session of
    the account."""

    account: AccountId
    player: PlayerId
    adopted_from: AccountId
    relationship: Relationship = "managed"
    token: str = ""


def new_guest(session: Session, display_name: str) -> tuple[AccountId, PlayerId]:
    started = start_session(session, None, ANN, new_display_name=lambda: display_name)
    return started.account.id, started.player.id


def started_player(database: Engine, question: Question, display_name: str) -> PlayerId:
    """The self player of the account's next session."""
    return in_transaction(
        database,
        lambda session: (
            start_session(
                session, question.token, ANN, new_display_name=lambda: display_name
            ).player.id
        ),
    )


def adopted(database: Engine) -> Question:
    """A guest account that signed in to Bob's account, as AdoptGuest does."""

    def setup(session: Session) -> Question:
        bob = Account(email=Email("bob@example.com"))
        session.add(bob)
        session.flush()
        guest, player = new_guest(session, EGRET)
        token = adopt_guest(session, guest, bob.id)
        return Question(bob.id, player, guest, "managed", token)

    return in_transaction(database, setup)


def verified_in_place(database: Engine) -> Question:
    """A guest account that signed in with a new email, as VerifyInPlace
    does. The question names the account itself."""

    def setup(session: Session) -> Question:
        started = start_session(session, None, ANN, new_display_name=lambda: EGRET)
        guest = started.account.id
        session.execute(
            update(Account)
            .where(Account.id == guest)
            .values(email=Email("ann@example.com"))
        )
        hand_over_players(session, guest, guest)
        return Question(guest, started.player.id, guest, "self", started.token)

    return in_transaction(database, setup)


SETUPS = pytest.mark.parametrize(
    "setup", [adopted, verified_in_place], ids=["adopted", "verified_in_place"]
)
type Setup = Callable[[Engine], Question]


def add_player(
    database: Engine,
    account: AccountId,
    name: str,
    relationship: str,
    *,
    adopted_from: AccountId | None = None,
) -> PlayerId:
    def add(session: Session) -> PlayerId:
        player = Player(display_name=name)
        session.add(player)
        session.flush()
        session.add(
            PlayerManager(
                player_id=player.id,
                account_id=account,
                relationship=relationship,
                adopted_from=adopted_from,
            )
        )
        return player.id

    return in_transaction(database, add)


def players_of(database: Engine, account: AccountId) -> list[AccountPlayer]:
    return in_transaction(database, lambda session: account_players(session, account))


def listed(
    id: PlayerId, display_name: str, relationship: Relationship, *, open_question: bool
) -> AccountPlayer:
    """A listed player, in no match."""
    return AccountPlayer(
        id,
        display_name,
        relationship,
        open_question,
        match_count=0,
        recent_matches=(),
        played_against=frozenset(),
    )


def answer(database: Engine, question: Question, value: Reply) -> Answered:
    return in_transaction(
        database,
        lambda session: answer_question(
            session, question.account, question.player, value
        ),
    )


def manager_rows(database: Engine, player: PlayerId) -> list[tuple[object, ...]]:
    with database.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT account_id, relationship, adopted_from FROM player_managers"
                " WHERE player_id = :player"
            ),
            {"player": player},
        ).all()
    return [tuple(row) for row in rows]


def created(database: Engine, player: PlayerId, days_ago: int) -> None:
    with database.begin() as connection:
        connection.execute(
            text(
                "UPDATE players SET created_at = now() - make_interval(days => :days)"
                " WHERE id = :player"
            ),
            {"player": player, "days": days_ago},
        )


def merged_into(database: Engine, player: PlayerId) -> PlayerId | None:
    with database.connect() as connection:
        found: PlayerId | None = connection.scalar(
            text("SELECT merged_into FROM players WHERE id = :player"),
            {"player": player},
        )
        return found


def self_players(database: Engine, account: AccountId) -> list[PlayerId]:
    with database.connect() as connection:
        return list(
            connection.scalars(
                text(
                    "SELECT player_id FROM player_managers"
                    " WHERE account_id = :account AND relationship = 'self'"
                ),
                {"account": account},
            )
        )


def exists(database: Engine, table: str, id: uuid.UUID) -> bool:
    with database.connect() as connection:
        found: bool = connection.scalar(
            text(f"SELECT EXISTS (SELECT 1 FROM {table} WHERE id = :id)"), {"id": id}
        )
        return found


@SETUPS
def test_lists_a_player_with_an_open_question(
    migrated_database: Engine, setup: Setup
) -> None:
    question = setup(migrated_database)

    assert players_of(migrated_database, question.account) == [
        listed(question.player, EGRET, question.relationship, open_question=True)
    ]


def test_lists_the_self_player_first_then_the_rest_by_name(
    migrated_database: Engine,
) -> None:
    question = adopted(migrated_database)
    zebra = add_player(migrated_database, question.account, "zany zebra 101", "self")
    ant = add_player(migrated_database, question.account, "able ant 102", "managed")

    assert players_of(migrated_database, question.account) == [
        listed(zebra, "zany zebra 101", "self", open_question=False),
        listed(ant, "able ant 102", "managed", open_question=False),
        listed(question.player, EGRET, "managed", open_question=True),
    ]


def test_lists_a_players_matches(migrated_database: Engine) -> None:
    question = adopted(migrated_database)

    def setup(session: Session) -> MatchId:
        match = MatchId(uuid.uuid4())
        details = MatchDetails(3, False, (question.player, add_opponent(session)))
        add_match(session, match, details)
        return match

    match = in_transaction(migrated_database, setup)

    [player] = players_of(migrated_database, question.account)
    assert player.match_count == 1
    assert [recent.id for recent in player.recent_matches] == [match]


@SETUPS
def test_yes_makes_the_player_the_accounts_own(
    migrated_database: Engine, setup: Setup
) -> None:
    question = setup(migrated_database)

    found = answer(migrated_database, question, Answer.YES)

    assert found == Answered(
        Settled("self"), [listed(question.player, EGRET, "self", open_question=False)]
    )
    assert manager_rows(migrated_database, question.player) == [
        (question.account, "self", None)
    ]


@SETUPS
def test_no_makes_the_player_one_the_account_manages(
    migrated_database: Engine, setup: Setup
) -> None:
    question = setup(migrated_database)

    found = answer(migrated_database, question, Answer.NO)

    assert found == Answered(
        Settled("managed"),
        [listed(question.player, EGRET, "managed", open_question=False)],
    )
    assert manager_rows(migrated_database, question.player) == [
        (question.account, "managed", None)
    ]


@SETUPS
def test_not_mine_takes_the_player_off_the_account_and_keeps_it(
    migrated_database: Engine, setup: Setup
) -> None:
    question = setup(migrated_database)

    found = answer(migrated_database, question, Answer.NOT_MINE)

    assert found == Answered(Settled("removed"), [])
    assert manager_rows(migrated_database, question.player) == []
    assert exists(migrated_database, "players", question.player)
    assert exists(migrated_database, "accounts", question.adopted_from)


def test_yes_merges_the_accounts_newer_self_player_into_the_player(
    migrated_database: Engine,
) -> None:
    question = adopted(migrated_database)
    dove = add_player(migrated_database, question.account, "dreamy dove 412", "self")
    created(migrated_database, question.player, days_ago=1)

    found = answer(migrated_database, question, Answer.YES)

    assert found == Answered(
        Merged(survivor=question.player, merged=dove),
        [listed(question.player, EGRET, "self", open_question=False)],
    )
    assert merged_into(migrated_database, dove) == question.player
    assert merged_into(migrated_database, question.player) is None
    assert self_players(migrated_database, question.account) == [question.player]
    assert manager_rows(migrated_database, dove) == [
        (question.account, "managed", None)
    ]


def test_yes_merges_the_player_into_the_accounts_older_self_player(
    migrated_database: Engine,
) -> None:
    question = adopted(migrated_database)
    zebra = add_player(migrated_database, question.account, "zany zebra 101", "self")
    created(migrated_database, zebra, days_ago=1)

    found = answer(migrated_database, question, Answer.YES)

    assert found == Answered(
        Merged(survivor=zebra, merged=question.player),
        [listed(zebra, "zany zebra 101", "self", open_question=False)],
    )
    assert merged_into(migrated_database, question.player) == zebra
    assert merged_into(migrated_database, zebra) is None
    assert self_players(migrated_database, question.account) == [zebra]
    assert manager_rows(migrated_database, question.player) == [
        (question.account, "managed", None)
    ]


def test_yes_on_the_accounts_own_player_keeps_it(migrated_database: Engine) -> None:
    question = verified_in_place(migrated_database)

    found = answer(migrated_database, question, Answer.YES)

    assert found == Answered(
        Settled("self"), [listed(question.player, EGRET, "self", open_question=False)]
    )
    assert merged_into(migrated_database, question.player) is None
    assert started_player(migrated_database, question, "zany zebra 101") == (
        question.player
    )
    assert self_players(migrated_database, question.account) == [question.player]


def test_the_accounts_own_player_with_an_open_question_stays_its_player(
    migrated_database: Engine,
) -> None:
    question = verified_in_place(migrated_database)

    assert started_player(migrated_database, question, "zany zebra 101") == (
        question.player
    )
    assert manager_rows(migrated_database, question.player) == [
        (question.account, "self", question.account)
    ]


@pytest.mark.parametrize(
    "reply",
    [lambda ant: Answer.NO, lambda ant: Answer.NOT_MINE, SameAs],
    ids=["no", "not_mine", "same_as"],
)
def test_an_answer_but_yes_on_the_accounts_own_player_gives_it_a_new_one(
    migrated_database: Engine, reply: Callable[[PlayerId], Reply]
) -> None:
    question = verified_in_place(migrated_database)
    ant = add_player(migrated_database, question.account, "able ant 102", "managed")

    found = in_transaction(
        migrated_database,
        lambda session: answer_question(
            session,
            question.account,
            question.player,
            reply(ant),
            new_display_name=lambda: "zany zebra 101",
        ),
    )

    [zebra] = self_players(migrated_database, question.account)
    assert zebra not in (question.player, ant)
    assert found.players[0] == listed(
        zebra, "zany zebra 101", "self", open_question=False
    )
    assert started_player(migrated_database, question, "calm crane 765") == zebra


@pytest.mark.parametrize("other_older", [False, True], ids=["own_older", "other_older"])
def test_yes_on_another_player_makes_it_the_accounts_own_and_keeps_the_own_question(
    migrated_database: Engine, other_older: bool
) -> None:
    own = verified_in_place(migrated_database)
    badger = add_player(
        migrated_database,
        own.account,
        "brave badger 214",
        "managed",
        adopted_from=own.adopted_from,
    )
    if other_older:
        created(migrated_database, badger, days_ago=1)

    found = answer(
        migrated_database, Question(own.account, badger, own.adopted_from), Answer.YES
    )

    assert found == Answered(
        Settled("self"),
        [
            listed(badger, "brave badger 214", "self", open_question=False),
            listed(own.player, EGRET, "managed", open_question=True),
        ],
    )
    assert answer(migrated_database, own, Answer.NO).players == [
        listed(badger, "brave badger 214", "self", open_question=False),
        listed(own.player, EGRET, "managed", open_question=False),
    ]
    assert started_player(migrated_database, own, "calm crane 765") == badger


def test_an_unplayed_guest_becomes_the_accounts_own_player_in_place_of_one_with_an_open_question(
    migrated_database: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    own = verified_in_place(migrated_database)
    monkeypatch.setattr(
        "fortymm_api.services.adoption.has_activity", lambda session, player: False
    )

    def second_device(session: Session) -> PlayerId:
        guest, player = new_guest(session, "brave badger 214")
        adopt_guest(session, guest, own.account)
        return player

    badger = in_transaction(migrated_database, second_device)
    created(migrated_database, badger, days_ago=7)

    assert players_of(migrated_database, own.account) == [
        listed(badger, "brave badger 214", "self", open_question=False),
        listed(own.player, EGRET, "managed", open_question=True),
    ]
    assert answer(migrated_database, own, Answer.YES) == Answered(
        Merged(survivor=badger, merged=own.player),
        [listed(badger, "brave badger 214", "self", open_question=False)],
    )


def test_two_answers_at_once_that_each_need_an_own_player_leave_one(
    migrated_database: Engine,
) -> None:
    own = verified_in_place(migrated_database)
    badger = add_player(
        migrated_database,
        own.account,
        "brave badger 214",
        "managed",
        adopted_from=own.adopted_from,
    )

    wait_behind(
        migrated_database,
        lambda session: answer_question(session, own.account, own.player, Answer.NO),
        lambda session: answer_question(session, own.account, badger, Answer.YES),
    )[1].result()

    assert self_players(migrated_database, own.account) == [badger]


@pytest.mark.parametrize("answer_first", [True, False], ids=["answer", "session"])
def test_no_on_the_accounts_own_player_and_a_session_at_once_leave_one_own_player(
    migrated_database: Engine, answer_first: bool
) -> None:
    own = verified_in_place(migrated_database)

    def no(session: Session) -> Answered:
        return answer_question(session, own.account, own.player, Answer.NO)

    def start(session: Session) -> PlayerId:
        return start_session(
            session, own.token, ANN, new_display_name=lambda: "calm crane 765"
        ).player.id

    holder, waiter = (no, start) if answer_first else (start, no)
    wait_behind(migrated_database, holder, waiter)[1].result()

    assert len(self_players(migrated_database, own.account)) == 1


@pytest.mark.parametrize("value", PLAIN_ANSWERS)
def test_a_merged_player_is_no_longer_the_accounts(
    migrated_database: Engine, value: Reply
) -> None:
    question = adopted(migrated_database)
    zebra = add_player(migrated_database, question.account, "zany zebra 101", "self")
    created(migrated_database, zebra, days_ago=1)
    answer(migrated_database, question, Answer.YES)

    with pytest.raises(PlayerNotManaged):
        answer(migrated_database, question, value)


@pytest.mark.parametrize(
    "second_device_older", [False, True], ids=["first_older", "second_older"]
)
def test_a_second_devices_yes_merges_into_the_oldest_player(
    migrated_database: Engine, second_device_older: bool
) -> None:
    first = adopted(migrated_database)
    dove = add_player(migrated_database, first.account, "dreamy dove 412", "self")
    created(migrated_database, first.player, days_ago=2)
    answer(migrated_database, first, Answer.YES)

    def second_device(session: Session) -> Question:
        guest, player = new_guest(session, "brave badger 214")
        adopt_guest(session, guest, first.account)
        return Question(first.account, player, guest)

    second = in_transaction(migrated_database, second_device)
    if second_device_older:
        created(migrated_database, second.player, days_ago=3)
    survivor, merged = (
        (second.player, first.player)
        if second_device_older
        else (first.player, second.player)
    )

    found = answer(migrated_database, second, Answer.YES)

    assert found.outcome == Merged(survivor, merged)
    assert [(player.id, player.relationship) for player in found.players] == [
        (survivor, "self")
    ]
    assert self_players(migrated_database, first.account) == [survivor]
    assert merged_into(migrated_database, merged) == survivor
    # The player merged on the first device follows, so no chain forms.
    assert merged_into(migrated_database, dove) == survivor
    assert merged_into(migrated_database, survivor) is None


def test_a_new_player_can_take_a_merged_players_name(
    migrated_database: Engine,
) -> None:
    question = adopted(migrated_database)
    zebra = add_player(migrated_database, question.account, "zany zebra 101", "self")
    created(migrated_database, zebra, days_ago=1)
    answer(migrated_database, question, Answer.YES)

    _, player = in_transaction(
        migrated_database, lambda session: new_guest(session, EGRET)
    )

    assert player != question.player
    assert merged_into(migrated_database, question.player) == zebra


@SETUPS
@pytest.mark.parametrize(
    ("first", "second"),
    [
        (Answer.NO, Answer.YES),
        (Answer.YES, Answer.NO),
        (Answer.YES, Answer.YES),
        (Answer.NO, Answer.NO),
    ],
)
def test_a_second_answer_changes_nothing(
    migrated_database: Engine, setup: Setup, first: Reply, second: Reply
) -> None:
    question = setup(migrated_database)
    after_first = answer(migrated_database, question, first)
    rows = manager_rows(migrated_database, question.player)

    assert answer(migrated_database, question, second) == Answered(
        Settled("already_answered"), after_first.players
    )
    assert manager_rows(migrated_database, question.player) == rows


@SETUPS
@pytest.mark.parametrize("first", [Answer.YES, Answer.NO])
def test_not_mine_is_refused_once_the_question_is_answered(
    migrated_database: Engine, setup: Setup, first: Reply
) -> None:
    question = setup(migrated_database)
    answer(migrated_database, question, first)
    rows = manager_rows(migrated_database, question.player)

    with pytest.raises(QuestionClosed):
        answer(migrated_database, question, Answer.NOT_MINE)

    assert manager_rows(migrated_database, question.player) == rows


@pytest.mark.parametrize("value", PLAIN_ANSWERS)
def test_a_player_the_account_doesnt_manage_is_refused(
    migrated_database: Engine, value: Reply
) -> None:
    question = adopted(migrated_database)
    _, someone_elses = in_transaction(
        migrated_database, lambda session: new_guest(session, "brave badger 214")
    )
    rows = manager_rows(migrated_database, someone_elses)

    for player in (someone_elses, PlayerId(uuid.uuid4())):
        with pytest.raises(PlayerNotManaged):
            answer(
                migrated_database,
                Question(question.account, player, question.adopted_from),
                value,
            )

    assert manager_rows(migrated_database, someone_elses) == rows


def test_an_adopted_account_can_neither_list_nor_answer(
    migrated_database: Engine,
) -> None:
    question = adopted(migrated_database)
    guest = question.adopted_from

    with pytest.raises(AccountAdopted):
        players_of(migrated_database, guest)
    with pytest.raises(AccountAdopted):
        answer(
            migrated_database,
            Question(guest, question.player, guest),
            Answer.NO,
        )


def test_two_yes_answers_at_once_make_one_self_player(
    migrated_database: Engine,
) -> None:
    question = adopted(migrated_database)
    badger = add_player(
        migrated_database,
        question.account,
        "brave badger 214",
        "managed",
        adopted_from=question.adopted_from,
    )
    created(migrated_database, question.player, days_ago=1)

    first_result, waiter = wait_behind(
        migrated_database,
        lambda session: answer_question(
            session, question.account, question.player, Answer.YES
        ),
        lambda session: answer_question(session, question.account, badger, Answer.YES),
    )

    assert first_result.outcome == Settled("self")
    assert [player.relationship for player in first_result.players] == [
        "self",
        "managed",
    ]
    assert waiter.result() == Answered(
        Merged(survivor=question.player, merged=badger),
        [listed(question.player, EGRET, "self", open_question=False)],
    )
    assert self_players(migrated_database, question.account) == [question.player]
    assert merged_into(migrated_database, badger) == question.player


@SETUPS
@pytest.mark.parametrize("answered_older", [True, False], ids=["answered", "target"])
def test_same_as_merges_with_a_managed_player_into_the_oldest(
    migrated_database: Engine, setup: Setup, answered_older: bool
) -> None:
    question = setup(migrated_database)
    ant = add_player(migrated_database, question.account, "able ant 102", "managed")
    created(migrated_database, question.player if answered_older else ant, 1)
    survivor, merged = (
        (question.player, ant) if answered_older else (ant, question.player)
    )

    found = answer(migrated_database, question, SameAs(ant))

    assert found.outcome == Merged(survivor, merged)
    assert [(player.id, player.open_question) for player in found.players] == [
        (survivor, False)
    ]
    assert merged_into(migrated_database, merged) == survivor
    assert merged_into(migrated_database, survivor) is None
    assert manager_rows(migrated_database, survivor) == [
        (question.account, "managed", None)
    ]
    assert manager_rows(migrated_database, merged) == [
        (question.account, "managed", None)
    ]
    assert self_players(migrated_database, question.account) == []


def test_same_as_keeps_the_accounts_self_player(migrated_database: Engine) -> None:
    question = adopted(migrated_database)
    zebra = add_player(migrated_database, question.account, "zany zebra 101", "self")
    ant = add_player(migrated_database, question.account, "able ant 102", "managed")

    found = answer(migrated_database, question, SameAs(ant))

    assert found.outcome == Merged(survivor=question.player, merged=ant)
    assert self_players(migrated_database, question.account) == [zebra]


@SETUPS
def test_same_as_the_answered_player_is_refused(
    migrated_database: Engine, setup: Setup
) -> None:
    question = setup(migrated_database)
    rows = manager_rows(migrated_database, question.player)

    with pytest.raises(SameAsItself):
        answer(migrated_database, question, SameAs(question.player))

    assert manager_rows(migrated_database, question.player) == rows


def test_same_as_refuses_a_player_that_isnt_a_managed_player_of_the_account(
    migrated_database: Engine,
) -> None:
    question = adopted(migrated_database)
    zebra = add_player(migrated_database, question.account, "zany zebra 101", "self")
    merged = add_player(
        migrated_database,
        question.account,
        "merged mole 333",
        "managed",
        adopted_from=question.adopted_from,
    )
    ant = add_player(migrated_database, question.account, "able ant 102", "managed")
    created(migrated_database, ant, days_ago=1)
    answer(
        migrated_database,
        Question(question.account, merged, question.adopted_from),
        SameAs(ant),
    )
    _, someone_elses = in_transaction(
        migrated_database, lambda session: new_guest(session, "brave badger 214")
    )
    rows = manager_rows(migrated_database, question.player)

    for target in (zebra, merged, someone_elses, PlayerId(uuid.uuid4())):
        with pytest.raises(PlayerNotManaged):
            answer(migrated_database, question, SameAs(target))

    assert manager_rows(migrated_database, question.player) == rows
    assert merged_into(migrated_database, question.player) is None


def test_same_as_refuses_a_player_with_an_open_question(
    migrated_database: Engine,
) -> None:
    question = adopted(migrated_database)
    badger = add_player(
        migrated_database,
        question.account,
        "brave badger 214",
        "managed",
        adopted_from=question.adopted_from,
    )

    with pytest.raises(PlayerNotManaged):
        answer(migrated_database, question, SameAs(badger))

    assert merged_into(migrated_database, badger) is None
    assert merged_into(migrated_database, question.player) is None


@SETUPS
@pytest.mark.parametrize("first", [Answer.YES, Answer.NO])
def test_same_as_changes_nothing_once_the_question_is_answered(
    migrated_database: Engine, setup: Setup, first: Reply
) -> None:
    question = setup(migrated_database)
    ant = add_player(migrated_database, question.account, "able ant 102", "managed")
    after_first = answer(migrated_database, question, first)

    assert answer(migrated_database, question, SameAs(ant)) == Answered(
        Settled("already_answered"), after_first.players
    )
    assert merged_into(migrated_database, ant) is None
