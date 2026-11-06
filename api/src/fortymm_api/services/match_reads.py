"""Reading matches: the list of every match, and one match with its history.
references/matches.md explains the rules they read.

A match's state isn't stored. match_state() derives it from the head of its
result chain, the result that head replaced, and its newest board. Players
show as they survive any merge, and an adopted guest's acts as the account
that adopted it.
"""

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import ClassVar, Literal

from sqlalchemy import Select, and_, func, select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.orm import Session, aliased

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import BestOf, MatchId, MatchResultId
from fortymm_api.models import (
    Account,
    Match,
    MatchApproval,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchSubmission,
    Player,
    PlayerManager,
    StoredMatchResult,
)
from fortymm_api.services.matches import (
    ACCEPTED,
    MatchNotFound,
    as_best_of,
    as_side,
    board_result,
)
from fortymm_api.signed_results import (
    GamePoints,
    MatchResult,
    Retired,
    Side,
    decode_payload,
)

MATCH_PAGE_SIZE = 50


@dataclass(frozen=True)
class SidePlayer:
    # The player that survives any merge.
    id: PlayerId
    display_name: str


@dataclass(frozen=True)
class MatchSideView:
    side: Side
    players: tuple[SidePlayer, ...]


@dataclass(frozen=True)
class NotStarted:
    kind: ClassVar[Literal["not_started"]] = "not_started"


@dataclass(frozen=True)
class Live:
    """A board but no result: the games are the board's."""

    kind: ClassVar[Literal["live"]] = "live"


@dataclass(frozen=True)
class Awaiting:
    """One side signed the head, and the other side's approval is what it
    waits on."""

    kind: ClassVar[Literal["awaiting"]] = "awaiting"
    signed_by: Side
    signed_at: datetime


@dataclass(frozen=True)
class Disputed:
    """One side signed scores that replace the other side's pending
    result."""

    kind: ClassVar[Literal["disputed"]] = "disputed"
    signed_by: Side
    signed_at: datetime
    # The replaced result's games.
    their_games: tuple[GamePoints, ...]


@dataclass(frozen=True)
class Final:
    kind: ClassVar[Literal["final"]] = "final"
    accepted_at: datetime
    # Sorted. One side for an unrated result only one side approved, none for
    # an override.
    approved_by: tuple[Side, ...]
    override_reason: str | None


type MatchState = NotStarted | Live | Awaiting | Disputed | Final


@dataclass(frozen=True)
class MatchView:
    id: MatchId
    best_of: BestOf
    rated: bool
    started_at: datetime
    sides: tuple[MatchSideView, MatchSideView]
    # The side of the viewer's self player, if it plays.
    viewer_side: Side | None
    # The games the state is about.
    games: tuple[GamePoints, ...]
    # The side that retired in the shown result, None if it completed or
    # there is no result.
    retired_by: Side | None
    state: MatchState


type EventKind = Literal["created", "board", "signed", "approved", "override"]


@dataclass(frozen=True)
class MatchEvent:
    at: datetime
    kind: EventKind
    # The display name of who acted, None for an account with no self player.
    by: str | None
    # The side a signature was for.
    side: Side | None
    # None for `created`.
    games: tuple[GamePoints, ...] | None


@dataclass(frozen=True)
class MatchPage:
    # Newest first.
    matches: tuple[MatchView, ...]
    # More matches exist than the page holds.
    has_more: bool


@dataclass(frozen=True)
class MatchDetail:
    match: MatchView
    # Oldest first.
    history: tuple[MatchEvent, ...]


@dataclass(frozen=True)
class ChainResult:
    """A result of the match, with what its state depends on."""

    id: MatchResultId
    replaces: MatchResultId | None
    result: MatchResult
    accepted_at: datetime | None
    override_reason: str | None
    approved_by: frozenset[Side]
    # The result's first submission says who sent it, and when.
    first_submission: int
    first_sent_at: datetime


@dataclass(frozen=True)
class Shown:
    state: MatchState
    games: tuple[GamePoints, ...]
    retired_by: Side | None


def match_state(
    head: ChainResult | None, replaced: ChainResult | None, board: MatchResult | None
) -> Shown:
    """What the match shows, from its head, the result the head replaces and
    its newest board. A board after a result changes nothing, because the
    signed scores are what the match waits on.

    An accepted head is the current result. A pending head has approvals
    from exactly one side, because one approval accepts an unrated first
    result and two accept any other. It disputes the result it replaces
    when that one is pending and the other side signed it. A first result,
    a side signing again, and a correction of a final match await the other
    side.
    """
    if head is None:
        if board is None:
            return Shown(NotStarted(), (), None)
        return Shown(Live(), board.games, None)
    games = head.result.games
    ending = head.result.ending
    retired_by = ending.by if isinstance(ending, Retired) else None
    if head.accepted_at is not None:
        final = Final(
            head.accepted_at, tuple(sorted(head.approved_by)), head.override_reason
        )
        return Shown(final, games, retired_by)
    (signer,) = head.approved_by
    if (
        replaced is not None
        and replaced.accepted_at is None
        and replaced.approved_by == {1 - signer}
    ):
        disputed = Disputed(signer, head.first_sent_at, replaced.result.games)
        return Shown(disputed, games, retired_by)
    return Shown(Awaiting(signer, head.first_sent_at), games, retired_by)


def list_matches(session: Session, viewer: AccountId) -> MatchPage:
    """Every match, newest first by when it was made, then by id. At most
    MATCH_PAGE_SIZE."""
    rows = _match_rows(
        session,
        _MATCH_COLUMNS.order_by(Match.created_at.desc(), Match.id.desc()).limit(
            MATCH_PAGE_SIZE + 1
        ),
    )
    page = _load(session, rows[:MATCH_PAGE_SIZE])
    you = _self_player(session, viewer)
    return MatchPage(
        tuple(_view(match, you) for match in page),
        has_more=len(rows) > MATCH_PAGE_SIZE,
    )


def get_match(session: Session, match_id: MatchId, viewer: AccountId) -> MatchDetail:
    """The match with its history. Raises MatchNotFound."""
    rows = _match_rows(session, _MATCH_COLUMNS.where(Match.id == match_id))
    if not rows:
        raise MatchNotFound
    (match,) = _load(session, rows)
    return MatchDetail(
        _view(match, _self_player(session, viewer)), _history(session, match)
    )


@dataclass(frozen=True)
class _MatchRow:
    id: MatchId
    created_at: datetime
    created_by: AccountId | None
    best_of: BestOf
    rated: bool


@dataclass(frozen=True)
class _Loaded:
    row: _MatchRow
    sides: tuple[MatchSideView, MatchSideView]
    results: dict[MatchResultId, ChainResult]
    board: MatchResult | None


type _MatchQuery = Select[MatchId, datetime, AccountId | None, int, bool]
_MATCH_COLUMNS: _MatchQuery = select(
    Match.id,
    Match.created_at,
    Match.created_by,
    MatchSettings.best_of,
    MatchSettings.rated,
).join(MatchSettings, MatchSettings.id == Match.settings_id)


def _match_rows(session: Session, query: _MatchQuery) -> list[_MatchRow]:
    # Each later statement of the read sees what committed before it, so a
    # result committing between two of them would show half its rows. Every
    # write to a match holds lock_match() first, and the share lock makes it
    # wait for the read to end.
    locked = query.with_for_update(read=True, of=Match)
    return [
        _MatchRow(MatchId(id), created_at, created_by, as_best_of(best_of), rated)
        for id, created_at, created_by, best_of, rated in session.execute(locked)
    ]


def _load(session: Session, rows: Sequence[_MatchRow]) -> list[_Loaded]:
    """The sides, results and newest board of each match, in a fixed number
    of queries however many matches there are."""
    ids = [row.id for row in rows]
    written, survivor = aliased(Player), aliased(Player)
    sides: dict[MatchId, dict[Side, list[SidePlayer]]] = defaultdict(
        lambda: {0: [], 1: []}
    )
    for match, side, player, name in session.execute(
        select(
            MatchSidePlayer.match_id, MatchSide.side, survivor.id, survivor.display_name
        )
        .join(MatchSide, MatchSide.id == MatchSidePlayer.match_side_id)
        .join(written, written.id == MatchSidePlayer.player_id)
        .join(survivor, survivor.id == func.coalesce(written.merged_into, written.id))
        .where(MatchSidePlayer.match_id.in_(ids))
        .order_by(survivor.id)
    ):
        sides[match][as_side(side)].append(SidePlayer(player, name))

    approved_by: dict[MatchResultId, set[Side]] = defaultdict(set)
    for result, side in session.execute(
        select(MatchApproval.result_id, MatchApproval.side)
        .join(StoredMatchResult, StoredMatchResult.id == MatchApproval.result_id)
        .where(StoredMatchResult.match_id.in_(ids))
    ):
        approved_by[result].add(as_side(side))
    first_sent = {
        result: (submission, received_at)
        for result, submission, received_at in session.execute(
            select(
                MatchSubmission.result_id,
                MatchSubmission.id,
                MatchSubmission.received_at,
            )
            .ext(distinct_on(MatchSubmission.result_id))
            .where(
                MatchSubmission.match_id.in_(ids),
                MatchSubmission.result_id.is_not(None),
            )
            .order_by(MatchSubmission.result_id, MatchSubmission.id)
        )
    }
    results: dict[MatchId, dict[MatchResultId, ChainResult]] = defaultdict(dict)
    for stored in session.scalars(
        select(StoredMatchResult).where(StoredMatchResult.match_id.in_(ids))
    ):
        submission, sent_at = first_sent[stored.id]
        results[stored.match_id][stored.id] = ChainResult(
            stored.id,
            stored.replaces_id,
            decode_payload(stored.payload).result,
            stored.accepted_at,
            stored.override_reason,
            frozenset(approved_by[stored.id]),
            submission,
            sent_at,
        )
    boards = {
        match: board_result(body)
        for match, body in session.execute(
            select(MatchSubmission.match_id, MatchSubmission.body)
            .ext(distinct_on(MatchSubmission.match_id))
            .where(
                MatchSubmission.match_id.in_(ids),
                MatchSubmission.kind == "board",
                MatchSubmission.outcome == ACCEPTED,
            )
            .order_by(MatchSubmission.match_id, MatchSubmission.id.desc())
        )
    }
    return [
        _Loaded(
            row,
            (
                MatchSideView(0, tuple(sides[row.id][0])),
                MatchSideView(1, tuple(sides[row.id][1])),
            ),
            results[row.id],
            boards.get(row.id),
        )
        for row in rows
    ]


def _view(match: _Loaded, you: PlayerId | None) -> MatchView:
    replaced_ids = {result.replaces for result in match.results.values()}
    head = next((r for r in match.results.values() if r.id not in replaced_ids), None)
    replaced = (
        None if head is None or head.replaces is None else match.results[head.replaces]
    )
    shown = match_state(head, replaced, match.board)
    viewer_side = next(
        (
            side.side
            for side in match.sides
            if any(player.id == you for player in side.players)
        ),
        None,
    )
    return MatchView(
        match.row.id,
        match.row.best_of,
        match.row.rated,
        match.row.created_at,
        match.sides,
        viewer_side,
        shown.games,
        shown.retired_by,
        shown.state,
    )


def _history(session: Session, match: _Loaded) -> tuple[MatchEvent, ...]:
    """The match's making, then each accepted board, approval and override,
    oldest first. Refused requests and retries that approved nothing leave
    no event."""
    submissions = session.execute(
        select(
            MatchSubmission.id,
            MatchSubmission.kind,
            MatchSubmission.body,
            MatchSubmission.account_id,
            MatchSubmission.received_at,
            MatchSubmission.result_id,
        )
        .where(
            MatchSubmission.match_id == match.row.id,
            MatchSubmission.outcome == ACCEPTED,
        )
        .order_by(MatchSubmission.id)
    ).all()
    written, survivor = aliased(Player), aliased(Player)
    signatures: dict[int, list[tuple[Side, str]]] = defaultdict(list)
    for submission, side, name in session.execute(
        select(MatchApproval.submission_id, MatchApproval.side, survivor.display_name)
        .join(written, written.id == MatchApproval.player_id)
        .join(survivor, survivor.id == func.coalesce(written.merged_into, written.id))
        .where(MatchApproval.result_id.in_(list(match.results)))
        .order_by(MatchApproval.submission_id, MatchApproval.side)
    ):
        signatures[submission].append((as_side(side), name))
    names = _account_names(
        session,
        {match.row.created_by} | {row.account_id for row in submissions},
    )

    def name_of(account: AccountId | None) -> str | None:
        return None if account is None else names.get(account)

    events = [
        MatchEvent(
            match.row.created_at, "created", name_of(match.row.created_by), None, None
        )
    ]
    for id, kind, body, account, received_at, result_id in submissions:
        if kind == "board":
            games = board_result(body).games
            events.append(
                MatchEvent(received_at, "board", name_of(account), None, games)
            )
        # An accepted result or override always names its result.
        elif result_id is not None:
            result = match.results[result_id]
            games = result.result.games
            if kind == "override":
                events.append(
                    MatchEvent(received_at, "override", name_of(account), None, games)
                )
                continue
            signed: EventKind = (
                "signed" if result.first_submission == id else "approved"
            )
            events.extend(
                MatchEvent(received_at, signed, name, side, games)
                for side, name in signatures[id]
            )
    return tuple(events)


def _account_names(
    session: Session, accounts: set[AccountId | None]
) -> dict[AccountId, str]:
    """Each account's self player's display name, as it survives any merge.
    An adopted guest names the self player of the account it went into."""
    written, survivor = aliased(Player), aliased(Player)
    rows = session.execute(
        select(Account.id, survivor.display_name)
        .join(
            PlayerManager,
            and_(
                PlayerManager.account_id
                == func.coalesce(Account.adopted_into, Account.id),
                PlayerManager.relationship == "self",
            ),
        )
        .join(written, written.id == PlayerManager.player_id)
        .join(survivor, survivor.id == func.coalesce(written.merged_into, written.id))
        .where(Account.id.in_([account for account in accounts if account]))
    )
    return {AccountId(account): name for account, name in rows}


def _self_player(session: Session, account: AccountId) -> PlayerId | None:
    """The account's self player, as it survives any merge."""
    return session.scalar(
        select(func.coalesce(Player.merged_into, Player.id))
        .join(PlayerManager, PlayerManager.player_id == Player.id)
        .where(
            PlayerManager.account_id == account, PlayerManager.relationship == "self"
        )
    )
