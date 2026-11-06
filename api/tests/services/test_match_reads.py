"""The rules of reading matches, through list_matches() and get_match(). Every
read of one match goes through both, and checks that they show it alike.
The boards, results and overrides are recorded through their services, so
the reads see what the routes write."""

import time
import uuid
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from locks import backend_waits_for_a_lock
from match_setup import (
    add_account,
    add_match,
    add_player,
    in_transaction,
    result_chain,
    sender,
)
from signed_result_vectors import KEYS
from sqlalchemy import Connection, Engine, event, select, text, update
from sqlalchemy.orm import Session, sessionmaker

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.models import Account, Match, MatchSubmission, Player
from fortymm_api.services.adoption import adopt_guest
from fortymm_api.services.match_reads import (
    MATCH_PAGE_SIZE,
    Awaiting,
    Disputed,
    Final,
    Live,
    MatchEvent,
    MatchSideView,
    MatchView,
    NotStarted,
    SidePlayer,
    get_match,
    list_matches,
)
from fortymm_api.services.match_results import (
    Recorded,
    override_result,
    record_result,
)
from fortymm_api.services.matches import (
    BoardPushed,
    MatchDetails,
    MatchNotFound,
    Refused,
    push_board,
)
from fortymm_api.services.players import Answer, answer_question
from fortymm_api.signed_results import (
    Completed,
    Ending,
    GamePoints,
    MatchResult,
    Retired,
    append_signature,
    encode_payload,
    sign,
)
from fortymm_api.signing_keys import SigningPrivateKey

ISSUED_AT = datetime(2026, 11, 4, 12, tzinfo=UTC)
COMPLETED = Completed()
ANN_KEY, BO_KEY, CY_KEY = KEYS["ann"], KEYS["bo"], KEYS["cy"]
MATCH = MatchId(uuid.UUID("01970000-0000-7000-8000-0000000000b1"))
FIRST = ((11, 5), (11, 7))
OTHER = ((11, 5), (7, 11), (11, 9))
THIRD = ((5, 11), (11, 7), (12, 10))


@dataclass(frozen=True)
class Scene:
    ann: PlayerId
    bo: PlayerId
    # Ann's account holds ann's key, Bo's bo's.
    ann_account: AccountId
    bo_account: AccountId
    # An account with no self player.
    spectator: AccountId


def named(session: Session, name: str) -> PlayerId:
    player = add_player(session)
    session.execute(update(Player).where(Player.id == player).values(display_name=name))
    return player


def scene(database: Engine, *, rated: bool = True) -> Scene:
    """A best of 3 between Ann, on side 0, and Bo, made by Ann's account."""

    def make(session: Session) -> Scene:
        ann, bo = named(session, "Ann"), named(session, "Bo")
        ann_account = add_account(session, plays_as=ann, keys=[ANN_KEY])
        bo_account = add_account(session, plays_as=bo, keys=[BO_KEY])
        add_match(session, MATCH, MatchDetails(3, rated, (ann, bo)), ann_account)
        return Scene(ann, bo, ann_account, bo_account, add_account(session))

    return in_transaction(database, make)


def result_of(
    s: Scene,
    games: tuple[GamePoints, ...],
    *,
    rated: bool = True,
    ending: Ending = COMPLETED,
    replaces: Recorded | None = None,
    match: MatchId = MATCH,
) -> MatchResult:
    return MatchResult(
        match=match,
        best_of=3,
        rated=rated,
        players=(s.ann, s.bo),
        games=games,
        ending=ending,
        replaces=None if replaces is None else replaces.hash,
    )


def envelope_of(
    result: MatchResult, *signers: tuple[SigningPrivateKey, PlayerId]
) -> bytes:
    (key, player), *rest = signers
    data = sign(result, ISSUED_AT, key, player)
    for key, player in rest:
        data = append_signature(data, key, player)
    return data


def upload(
    database: Engine,
    data: bytes,
    account: AccountId | None = None,
    match: MatchId = MATCH,
) -> Recorded:
    answer = in_transaction(
        database, lambda session: record_result(session, match, data, sender(account))
    )
    assert isinstance(answer, Recorded), answer
    return answer


def board(
    database: Engine, s: Scene, games: tuple[GamePoints, ...], account: AccountId
) -> BoardPushed:
    draft = encode_payload(result_of(s, games), ISSUED_AT)
    pushed = in_transaction(
        database, lambda session: push_board(session, MATCH, draft, sender(account))
    )
    assert isinstance(pushed, BoardPushed), pushed
    return pushed


def read(database: Engine, viewer: AccountId, match: MatchId = MATCH) -> MatchView:
    """The match as get_match() shows it, which list_matches() must show
    alike."""
    detail = in_transaction(database, lambda session: get_match(session, match, viewer))
    listed = in_transaction(database, lambda session: list_matches(session, viewer))
    assert [m for m in listed.matches if m.id == match] == [detail.match]
    return detail.match


def history(database: Engine, viewer: AccountId) -> tuple[MatchEvent, ...]:
    return in_transaction(
        database, lambda session: get_match(session, MATCH, viewer)
    ).history


def sent_at(database: Engine) -> list[datetime]:
    """When each accepted request for the match arrived, oldest first."""
    return in_transaction(
        database,
        lambda session: list(
            session.scalars(
                select(MatchSubmission.received_at)
                .where(
                    MatchSubmission.match_id == MATCH,
                    MatchSubmission.outcome == "accepted",
                )
                .order_by(MatchSubmission.id)
            )
        ),
    )


def made_at(database: Engine) -> datetime:
    return in_transaction(
        database,
        lambda session: session.scalars(
            select(Match.created_at).where(Match.id == MATCH)
        ).one(),
    )


def accepted_at(database: Engine) -> datetime:
    head = result_chain(database, MATCH)[-1].accepted_at
    assert head is not None
    return head


def test_a_match_with_no_board_has_not_started(migrated_database: Engine) -> None:
    s = scene(migrated_database)

    view = read(migrated_database, s.ann_account)

    assert view.state == NotStarted()
    assert view.games == ()
    assert view.retired_by is None
    assert view.best_of == 3
    assert view.rated is True
    assert view.sides == (
        MatchSideView(0, (SidePlayer(s.ann, "Ann"),)),
        MatchSideView(1, (SidePlayer(s.bo, "Bo"),)),
    )


def test_a_match_with_a_board_is_live_with_the_newest_boards_games(
    migrated_database: Engine,
) -> None:
    s = scene(migrated_database)
    board(migrated_database, s, ((11, 5),), s.spectator)
    board(migrated_database, s, ((11, 5), (3, 2)), s.ann_account)

    view = read(migrated_database, s.ann_account)

    assert view.state == Live()
    assert view.games == ((11, 5), (3, 2))
    assert view.retired_by is None


def test_a_result_one_side_signed_awaits_the_other_from_its_first_upload(
    migrated_database: Engine,
) -> None:
    s = scene(migrated_database)
    board(migrated_database, s, ((11, 5),), s.ann_account)
    data = envelope_of(result_of(s, FIRST), (ANN_KEY, s.ann))
    upload(migrated_database, data)
    upload(migrated_database, data)
    # A board after a result changes nothing.
    board(migrated_database, s, ((1, 0),), s.bo_account)

    view = read(migrated_database, s.bo_account)

    _, first_upload, _, _ = sent_at(migrated_database)
    assert view.state == Awaiting(signed_by=0, signed_at=first_upload)
    assert view.games == FIRST


def test_other_scores_from_the_other_side_dispute_the_result(
    migrated_database: Engine,
) -> None:
    s = scene(migrated_database)
    r1 = upload(migrated_database, envelope_of(result_of(s, FIRST), (ANN_KEY, s.ann)))
    upload(
        migrated_database,
        envelope_of(result_of(s, OTHER, replaces=r1), (BO_KEY, s.bo)),
    )

    view = read(migrated_database, s.ann_account)

    _, counter = sent_at(migrated_database)
    assert view.state == Disputed(signed_by=1, signed_at=counter, their_games=FIRST)
    assert view.games == OTHER


def test_a_side_that_signs_again_still_awaits_the_other(
    migrated_database: Engine,
) -> None:
    s = scene(migrated_database)
    r1 = upload(migrated_database, envelope_of(result_of(s, FIRST), (ANN_KEY, s.ann)))
    upload(
        migrated_database,
        envelope_of(result_of(s, OTHER, replaces=r1), (ANN_KEY, s.ann)),
    )

    view = read(migrated_database, s.bo_account)

    _, second = sent_at(migrated_database)
    assert view.state == Awaiting(signed_by=0, signed_at=second)
    assert view.games == OTHER


def test_a_correction_of_a_final_match_awaits_the_other_side(
    migrated_database: Engine,
) -> None:
    s = scene(migrated_database)
    r1 = upload(
        migrated_database,
        envelope_of(result_of(s, FIRST), (ANN_KEY, s.ann), (BO_KEY, s.bo)),
    )
    upload(
        migrated_database,
        envelope_of(result_of(s, OTHER, replaces=r1), (BO_KEY, s.bo)),
    )

    view = read(migrated_database, s.ann_account)

    _, correction = sent_at(migrated_database)
    assert view.state == Awaiting(signed_by=1, signed_at=correction)
    assert view.games == OTHER


def test_a_rated_result_both_sides_approved_is_final(
    migrated_database: Engine,
) -> None:
    s = scene(migrated_database)
    data = envelope_of(result_of(s, FIRST), (ANN_KEY, s.ann))
    upload(migrated_database, data)
    upload(migrated_database, append_signature(data, BO_KEY, s.bo))

    view = read(migrated_database, s.ann_account)

    assert view.state == Final(
        accepted_at=accepted_at(migrated_database),
        approved_by=(0, 1),
        override_reason=None,
    )
    assert view.games == FIRST
    assert view.retired_by is None


def test_an_unrated_result_one_side_approved_is_final_with_that_side(
    migrated_database: Engine,
) -> None:
    s = scene(migrated_database, rated=False)
    upload(
        migrated_database,
        envelope_of(result_of(s, FIRST, rated=False), (BO_KEY, s.bo)),
    )

    view = read(migrated_database, s.ann_account)

    assert view.state == Final(
        accepted_at=accepted_at(migrated_database),
        approved_by=(1,),
        override_reason=None,
    )


def test_an_override_is_final_with_no_side_and_its_reason(
    migrated_database: Engine,
) -> None:
    s = scene(migrated_database)
    upload(migrated_database, envelope_of(result_of(s, FIRST), (ANN_KEY, s.ann)))
    in_transaction(
        migrated_database,
        lambda session: override_result(
            session,
            MATCH,
            add_account(session),
            None,
            OTHER,
            Completed(),
            "  The score card says so ",
        ),
    )

    view = read(migrated_database, s.ann_account)

    assert view.state == Final(
        accepted_at=accepted_at(migrated_database),
        approved_by=(),
        override_reason="The score card says so",
    )
    assert view.games == OTHER


def test_a_retirement_shows_who_retired(migrated_database: Engine) -> None:
    s = scene(migrated_database)
    games = ((11, 5), (3, 2))
    upload(
        migrated_database,
        envelope_of(
            result_of(s, games, ending=Retired(1)), (ANN_KEY, s.ann), (BO_KEY, s.bo)
        ),
    )

    view = read(migrated_database, s.ann_account)

    assert isinstance(view.state, Final)
    assert view.games == games
    assert view.retired_by == 1


@pytest.mark.parametrize(
    ("viewer", "side"),
    [("ann_account", 0), ("bo_account", 1), ("spectator", None)],
)
def test_the_viewer_side_holds_the_viewers_self_player(
    migrated_database: Engine, viewer: str, side: int | None
) -> None:
    s = scene(migrated_database)

    assert read(migrated_database, getattr(s, viewer)).viewer_side == side


def test_a_guest_player_merged_into_an_account_player_shows_as_it(
    migrated_database: Engine,
) -> None:
    """A guest plays, signs in to Sam's account and answers "Is this you?"
    with Yes. Sam's player was made first, so it survives the merge and
    stands for the guest's player everywhere, the history too."""

    def make_sam(session: Session) -> tuple[PlayerId, AccountId]:
        sam = named(session, "Sam")
        account = add_account(session, plays_as=sam)
        session.execute(
            update(Account).where(Account.id == account).values(email="sam@example.com")
        )
        return sam, account

    def make(session: Session) -> Scene:
        guest_player, xena = named(session, "Guest 4821"), named(session, "Xena")
        guest = add_account(session, plays_as=guest_player, keys=[ANN_KEY])
        xena_account = add_account(session, plays_as=xena, keys=[BO_KEY])
        add_match(session, MATCH, MatchDetails(3, True, (guest_player, xena)), guest)
        return Scene(guest_player, xena, guest, xena_account, add_account(session))

    # A later transaction, so the guest's player is made after Sam's.
    sam, account = in_transaction(migrated_database, make_sam)
    s = in_transaction(migrated_database, make)
    guest, guest_player, xena = s.ann_account, s.ann, s.bo
    board(migrated_database, s, ((11, 5),), guest)
    upload(
        migrated_database,
        envelope_of(result_of(s, FIRST), (ANN_KEY, guest_player)),
        guest,
    )
    in_transaction(
        migrated_database, lambda session: adopt_guest(session, guest, account)
    )
    in_transaction(
        migrated_database,
        lambda session: answer_question(session, account, guest_player, Answer.YES),
    )

    view = read(migrated_database, account)

    assert view.sides == (
        MatchSideView(0, (SidePlayer(sam, "Sam"),)),
        MatchSideView(1, (SidePlayer(xena, "Xena"),)),
    )
    assert view.viewer_side == 0
    events = history(migrated_database, account)
    assert [(e.kind, e.by, e.side) for e in events] == [
        ("created", "Sam", None),
        ("board", "Sam", None),
        ("signed", "Sam", 0),
    ]


def test_an_unknown_match_is_not_found(migrated_database: Engine) -> None:
    s = scene(migrated_database)

    with pytest.raises(MatchNotFound):
        in_transaction(
            migrated_database,
            lambda session: get_match(session, MatchId(uuid.uuid4()), s.ann_account),
        )


def test_lists_the_newest_matches_first_at_most_a_page(
    migrated_database: Engine,
) -> None:
    start = datetime(2026, 11, 1, tzinfo=UTC)

    def make(session: Session) -> tuple[AccountId, list[tuple[datetime, MatchId]]]:
        ann, bo = named(session, "Ann"), named(session, "Bo")
        made = []
        for n in range(MATCH_PAGE_SIZE + 1):
            # Pairs share a time, so the id breaks the tie.
            at = start + timedelta(minutes=n // 2)
            match = MatchId(uuid.uuid4())
            add_match(session, match, MatchDetails(3, True, (ann, bo)), created_at=at)
            made.append((at, match))
        return add_account(session), made

    viewer, made = in_transaction(migrated_database, make)

    page = in_transaction(
        migrated_database, lambda session: list_matches(session, viewer)
    )

    newest = sorted(made, reverse=True)[:MATCH_PAGE_SIZE]
    assert [(m.started_at, m.id) for m in page.matches] == newest
    assert page.has_more is True


def test_a_full_page_with_nothing_after_has_no_more(
    migrated_database: Engine,
) -> None:
    def make(session: Session) -> AccountId:
        ann, bo = named(session, "Ann"), named(session, "Bo")
        for _ in range(MATCH_PAGE_SIZE):
            add_match(session, MatchId(uuid.uuid4()), MatchDetails(3, True, (ann, bo)))
        return add_account(session)

    viewer = in_transaction(migrated_database, make)

    page = in_transaction(
        migrated_database, lambda session: list_matches(session, viewer)
    )

    assert len(page.matches) == MATCH_PAGE_SIZE
    assert page.has_more is False


def test_the_list_reads_any_number_of_matches_in_the_same_queries(
    migrated_database: Engine,
) -> None:
    s = scene(migrated_database)
    upload(migrated_database, envelope_of(result_of(s, FIRST), (ANN_KEY, s.ann)))

    def statements(extra: int) -> int:
        def make(session: Session) -> None:
            for _ in range(extra):
                match = MatchId(uuid.uuid4())
                add_match(session, match, MatchDetails(3, True, (s.ann, s.bo)))

        in_transaction(migrated_database, make)
        count = 0

        def counted(*_: object) -> None:
            nonlocal count
            count += 1

        event.listen(migrated_database, "before_cursor_execute", counted)
        try:
            in_transaction(
                migrated_database, lambda session: list_matches(session, s.ann_account)
            )
        finally:
            event.remove(migrated_database, "before_cursor_execute", counted)
        return count

    assert statements(1) == statements(5)


def test_the_history_holds_the_accepted_requests_oldest_first(
    migrated_database: Engine,
) -> None:
    s = scene(migrated_database)
    cy = in_transaction(
        migrated_database,
        lambda session: add_account(session, plays_as=named(session, "Cy")),
    )
    board(migrated_database, s, ((11, 5),), s.bo_account)
    board(migrated_database, s, ((11, 5), (2, 1)), s.spectator)
    refused = in_transaction(
        migrated_database,
        lambda session: push_board(session, MATCH, b"\x00", sender(s.ann_account)),
    )
    assert isinstance(refused, Refused)
    first = envelope_of(result_of(s, FIRST), (ANN_KEY, s.ann))
    r1 = upload(migrated_database, first)
    upload(migrated_database, first)
    counter = envelope_of(result_of(s, OTHER, replaces=r1), (BO_KEY, s.bo))
    upload(migrated_database, counter)
    upload(migrated_database, append_signature(counter, ANN_KEY, s.ann))
    in_transaction(
        migrated_database,
        lambda session: override_result(
            session, MATCH, cy, None, THIRD, Completed(), "Umpire's card"
        ),
    )

    events = history(migrated_database, s.spectator)

    b1, b2, signed, _retry, countered, approved, overridden = sent_at(migrated_database)
    assert events == (
        MatchEvent(made_at(migrated_database), "created", "Ann", None, None),
        MatchEvent(b1, "board", "Bo", None, ((11, 5),)),
        MatchEvent(b2, "board", None, None, ((11, 5), (2, 1))),
        MatchEvent(signed, "signed", "Ann", 0, FIRST),
        MatchEvent(countered, "signed", "Bo", 1, OTHER),
        MatchEvent(approved, "approved", "Ann", 0, OTHER),
        MatchEvent(overridden, "override", "Cy", None, THIRD),
    )


def test_one_upload_both_sides_signed_gives_an_event_per_side(
    migrated_database: Engine,
) -> None:
    s = scene(migrated_database)
    upload(
        migrated_database,
        envelope_of(result_of(s, FIRST), (BO_KEY, s.bo), (ANN_KEY, s.ann)),
    )

    events = history(migrated_database, s.spectator)

    (uploaded,) = sent_at(migrated_database)
    assert events[1:] == (
        MatchEvent(uploaded, "signed", "Ann", 0, FIRST),
        MatchEvent(uploaded, "signed", "Bo", 1, FIRST),
    )


def statements_of(database: Engine, work: Callable[[Session], object]) -> int:
    count = 0

    def counted(*_: object) -> None:
        nonlocal count
        count += 1

    event.listen(database, "before_cursor_execute", counted)
    try:
        in_transaction(database, work)
    finally:
        event.remove(database, "before_cursor_execute", counted)
    return count


def countered_during_each_statement[T](
    database: Engine, s: Scene, reading: Callable[[Session, MatchId], T]
) -> None:
    """For each statement of the read, a new match whose result Ann signed,
    and Bo's counter to it, committed from another connection just after
    that statement. The read shows the match as it was before the counter
    or after it, and never fails."""
    upload(database, envelope_of(result_of(s, FIRST), (ANN_KEY, s.ann)))
    statements = statements_of(database, lambda session: reading(session, MATCH))
    for k in range(1, statements + 1):
        countered_after_statement(database, s, reading, k)


def countered_after_statement[T](
    database: Engine, s: Scene, reading: Callable[[Session, MatchId], T], k: int
) -> None:
    match = MatchId(uuid.uuid4())
    in_transaction(
        database,
        lambda session: add_match(
            session, match, MatchDetails(3, True, (s.ann, s.bo)), s.ann_account
        ),
    )
    r1 = upload(
        database,
        envelope_of(result_of(s, FIRST, match=match), (ANN_KEY, s.ann)),
        match=match,
    )
    counter = envelope_of(result_of(s, OTHER, replaces=r1, match=match), (BO_KEY, s.bo))
    before = in_transaction(database, lambda session: reading(session, match))
    sessions = sessionmaker(database)
    pids: list[int] = []
    reader: Connection | None = None
    seen = 0
    writer: Future[Recorded | Refused] | None = None

    def write() -> Recorded | Refused:
        with sessions.begin() as session:
            pids.append(session.scalar(text("SELECT pg_backend_pid()")))
            return record_result(session, match, counter, sender(None))

    def read(session: Session) -> T:
        nonlocal reader
        reader = session.connection()
        return reading(session, match)

    with ThreadPoolExecutor(max_workers=1) as executor:

        def after(conn: Connection, *_: object) -> None:
            nonlocal seen, writer
            if conn is not reader:
                return
            seen += 1
            if seen != k:
                return
            writer = executor.submit(write)
            deadline = time.monotonic() + 10
            while not (
                writer.done() or (pids and backend_waits_for_a_lock(database, pids[0]))
            ):
                assert time.monotonic() < deadline, "the counter never ran"
                time.sleep(0.02)

        event.listen(database, "after_cursor_execute", after)
        try:
            during = in_transaction(database, read)
        finally:
            event.remove(database, "after_cursor_execute", after)
        assert writer is not None, f"statement {k} never ran"
        assert isinstance(writer.result(timeout=10), Recorded)

    after_counter = in_transaction(database, lambda session: reading(session, match))
    assert during in (before, after_counter), f"after statement {k}"


def test_the_list_holds_still_while_a_result_commits(
    migrated_database: Engine,
) -> None:
    s = scene(migrated_database)

    countered_during_each_statement(
        migrated_database, s, lambda session, _: list_matches(session, s.spectator)
    )


def test_a_match_and_its_history_hold_still_while_a_result_commits(
    migrated_database: Engine,
) -> None:
    s = scene(migrated_database)

    countered_during_each_statement(
        migrated_database,
        s,
        lambda session, match: get_match(session, match, s.spectator),
    )
