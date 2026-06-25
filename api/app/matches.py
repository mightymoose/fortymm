import csv
import io
import logging
import math
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, cast

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
    status,
)
from pyrate_limiter import Duration, Rate
from sqlalchemy import CursorResult, Select, func, select, update
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, selectinload
from sqlalchemy.sql.base import ExecutableOption

from app.attention import (
    attention_priority,
    list_attention_kind,
)
from app.db import get_session
from app.domain.match.models import Match as MatchModel
from app.leagues import resolve_league
from app.mappers.match_details_mapper import serialize_match_details
from app.models import (
    League,
    Match,
    MatchGame,
    MatchGameScore,
    MatchResult,
    MatchResultResponse,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    RatingHistorySource,
    RatingStrategy,
    ResultOutcome,
    ResultResponseKind,
    User,
    UserLeagueRating,
)
from app.notifications.apns import MATCH_RESULT_CONFIRMATION_CATEGORY
from app.notifications.dependencies import get_notification_service
from app.notifications.service import NotificationService
from app.notifications.taxonomy import NotificationCategory
from app.players import escape_like
from app.rate_limiting import RedisRateLimiter
from app.ratings import get_calculator, state_rating_value, validate_state
from app.schemas.match import (
    MatchCreate,
    MatchDetails,
    MatchDetailsCurrentGame,
    MatchDetailsFormResult,
    MatchDetailsGame,
    MatchDetailsH2H,
    MatchDetailsH2HMeeting,
    MatchDetailsPlayer,
    MatchDetailsPlayerForm,
    MatchDetailsScore,
    MatchDetailsSide,
    MatchGameScoreConflict,
    MatchGameScoreUpdate,
    MatchGameScoreWrite,
    MatchLeague,
    MatchListFilter,
    MatchListResponse,
    MatchListRow,
    MatchResultsGameWrite,
    MatchResultsWrite,
    MatchSignatureView,
)
from app.schemas.notification import NotificationJob
from app.schemas.rating import RatingChange
from app.services.dependencies import get_match_service
from app.services.match_service import MatchService
from app.sessions import get_current_user, get_optional_user

router = APIRouter(prefix="/v1")

log = logging.getLogger(__name__)

MAX_PAGE_SIZE = 100
RECENT_FORM_LIMIT = 5
H2H_MEETINGS_LIMIT = 5
# Cap on the pre-match sparkline so the BFF stays cheap; the dashboard
# Sparkline already pads single points to 2.
RATING_HISTORY_LIMIT = 10


# ----- helpers -------------------------------------------------------------


def _side_schema(
    side: MatchSide,
    side_wins: dict[int, int],
    current_user_id: uuid.UUID | None,
    rating_changes: dict[uuid.UUID, RatingChange] | None = None,
) -> MatchDetailsSide:
    # Singles only for v1: each side has at most one rated player.
    rating_change = (
        rating_changes.get(side.players[0].user_id)
        if rating_changes and side.players
        else None
    )
    return MatchDetailsSide(
        side_number=side.side_number,
        players=[
            MatchDetailsPlayer(
                user_id=p.user_id,
                username=p.user.username,
                is_current_user=p.user_id == current_user_id,
            )
            for p in sorted(side.players, key=lambda p: p.user.username)
        ],
        games_won=side_wins.get(side.side_number, 0),
        won=side.won,
        is_current_user_side=any(p.user_id == current_user_id for p in side.players),
        rating_change=rating_change,
    )


# Shared eager-load chain. Used by every read path that returns a hierarchical
# match — async SQLAlchemy can't lazy-load mid-request, so all collections are
# pulled up front. The posted results (and their confirm/dispute responses) are
# needed wherever ``can_finalize`` / ``can_confirm`` / the awaiting-confirmation
# status label / the derived ``signatures`` + ``disputed_by_user_id`` are
# computed.
def match_eager_options() -> tuple[ExecutableOption, ...]:
    return (
        selectinload(Match.match_settings),
        selectinload(Match.league).selectinload(League.rating_strategy),
        selectinload(Match.results).selectinload(MatchResult.responses),
        *_match_history_options(),
    )


def _match_history_options() -> tuple[ExecutableOption, ...]:
    """Subset of ``match_eager_options`` for paths that only need sides + scores
    (recent form, H2H): no match_settings, no league/rating-strategy."""
    return (
        selectinload(Match.sides)
        .selectinload(MatchSide.players)
        .selectinload(MatchSidePlayer.user),
        selectinload(Match.games).selectinload(MatchGame.score),
    )


async def _load_match(db: AsyncSession, match_id: uuid.UUID) -> Match | None:
    result = await db.execute(
        select(Match).where(Match.id == match_id).options(*match_eager_options())
    )
    return result.scalar_one_or_none()


def my_side(match: Match, user_id: uuid.UUID) -> MatchSide | None:
    return next(
        (s for s in match.sides if any(p.user_id == user_id for p in s.players)),
        None,
    )


def opponent_side(match: Match, user_id: uuid.UUID) -> MatchSide | None:
    mine = my_side(match, user_id)
    if mine is None:
        return None
    return next((s for s in match.sides if s.side_number != mine.side_number), None)


def opponent_username(match: Match, user_id: uuid.UUID) -> str | None:
    opp = opponent_side(match, user_id)
    if opp is None or not opp.players:
        return None
    return opp.players[0].user.username


def _is_participant(match: Match, user_id: uuid.UUID) -> bool:
    return my_side(match, user_id) is not None


def _all_sides_have_players(match: Match) -> bool:
    """Solo matches (no opponent picked) carry one player-less sentinel side.
    The signature/confirmation flow needs a second human, so solo matches skip
    it entirely; this is the predicate that detects that case."""
    return len(match.sides) >= 2 and all(side.players for side in match.sides)


def latest_result(match: Match) -> MatchResult | None:
    """The most recently posted result, or ``None`` if none was ever posted.

    "Latest" by ``submitted_at`` — the lifecycle posts results strictly
    sequentially (a re-post only happens after the prior one is terminally
    disputed), so the newest row is the one the BFF derives everything from.
    """
    if not match.results:
        return None
    return max(match.results, key=lambda r: r.submitted_at)


def pending_result(match: Match) -> MatchResult | None:
    """The result currently awaiting confirmation, or ``None``.

    At most one result is ``pending`` at a time (posting moves the match to
    ``in_progress``; confirm/dispute make the result terminal), so this is the
    "is a result posted right now" marker — the successor to "``match`` has
    signatures"."""
    return next((r for r in match.results if r.outcome == ResultOutcome.pending), None)


def _signed_result(match: Match) -> MatchResult | None:
    """The result whose confirm responses the BFF surfaces as ``signatures``.

    A ``pending`` result (awaiting confirmation) or a ``confirmed`` one (a
    completed match) carries the sign-offs to display; a ``disputed`` /
    ``superseded`` result was rejected, so it contributes no signatures —
    mirroring the old "dispute clears signatures" behavior."""
    result = latest_result(match)
    if result is None or result.outcome in (
        ResultOutcome.disputed,
        ResultOutcome.superseded,
    ):
        return None
    return result


def _confirm_responses(result: MatchResult) -> list[MatchResultResponse]:
    return [r for r in result.responses if r.kind == ResultResponseKind.confirm]


def _signature_views(match: Match) -> list["MatchSignatureView"]:
    """The BFF ``signatures`` list — confirm responses on the current
    pending/confirmed result, oldest first. A ``response.created_at`` maps onto
    the historical ``signed_at`` field so the FE confirmation callout is
    unchanged."""
    result = _signed_result(match)
    if result is None:
        return []
    return [
        MatchSignatureView(user_id=r.user_id, signed_at=r.created_at)
        for r in sorted(_confirm_responses(result), key=lambda r: r.created_at)
    ]


def disputer_of(match: Match) -> uuid.UUID | None:
    """Who rejected the most recently posted result, or ``None`` on a
    non-disputed match. Derives the old ``matches.disputed_by_user_id`` column:
    the ``dispute`` response on the latest result when that result is
    ``disputed`` (cleared naturally once a re-post makes a new pending result
    the latest)."""
    result = latest_result(match)
    if result is None or result.outcome != ResultOutcome.disputed:
        return None
    dispute = next(
        (r for r in result.responses if r.kind == ResultResponseKind.dispute), None
    )
    return dispute.user_id if dispute else None


def _all_sides_responded_confirm(match: Match) -> bool:
    """True when every side has at least one of its players carrying a
    ``confirm`` response on the current pending result. Used to gate the
    in_progress → completed status flip in ``POST /confirmation``."""
    result = pending_result(match)
    if result is None:
        return False
    confirmers = {r.user_id for r in _confirm_responses(result)}
    return all(
        any(p.user_id in confirmers for p in side.players) for side in match.sides
    )


def _status_label(match: Match) -> str:
    """User-facing label for a match's lifecycle position. An ``in_progress``
    match with a pending posted result is waiting on the other side — surface
    that distinctly so the FE doesn't need to know about the result model to
    render it."""
    if match.status == MatchStatus.in_progress and pending_result(match) is not None:
        return "Awaiting confirmation"
    # Exhaustive — adding an enum member is a type error until handled.
    match match.status:
        case MatchStatus.pending:
            return "Scheduled"
        case MatchStatus.in_progress:
            return "Live"
        case MatchStatus.completed:
            return "Final"
        case MatchStatus.disputed:
            return "Disputed"
        case MatchStatus.voided:
            return "Voided"


def _games_to_win(best_of: int) -> int:
    return math.ceil(best_of / 2)


def _game_winner_side(score: MatchGameScore) -> int:
    # Ties are blocked by MatchGameScoreWrite; defensive fallback maps to side 2.
    return 1 if score.side_1_points > score.side_2_points else 2


def _score_view(score: MatchGameScore) -> MatchDetailsScore:
    return MatchDetailsScore(
        id=score.id,
        side_1_points=score.side_1_points,
        side_2_points=score.side_2_points,
        winner_side_number=_game_winner_side(score),
        version=score.version,
    )


# One message for every score-write conflict — a concurrent participant already
# saved this game. Both the create path (a second create loses the unique
# constraint) and the update path (a stale version loses the conditional UPDATE)
# raise it, always carrying the committed score so the client can show "your
# entry vs. what's saved". Sharing one structured body is what lets the client
# tell a real conflict apart from a plain-string 409 (e.g. a locked match) and
# never blindly retry a conflict over the committed value.
_SCORE_CONFLICT_MESSAGE = (
    "This game was saved by someone else while you were editing. "
    "Review the saved score before saving again."
)


def _score_conflict(committed: MatchDetailsScore | None) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail=MatchGameScoreConflict(
            message=_SCORE_CONFLICT_MESSAGE,
            committed_score=committed,
        ).model_dump(mode="json"),
    )


async def _committed_score(
    db: AsyncSession, match_id: uuid.UUID, game_number: int
) -> MatchDetailsScore | None:
    """The game's score as it actually stands now — for the conflict body after
    a create lost the unique-constraint race (the committed row belongs to a
    different transaction, so it isn't on our in-memory ``match``)."""
    reloaded = await _load_match(db, match_id)
    if reloaded is None:
        return None
    game = next((g for g in reloaded.games if g.game_number == game_number), None)
    return _score_view(game.score) if game and game.score else None


def side_win_counts(match: Match) -> dict[int, int]:
    counts = {side.side_number: 0 for side in match.sides}
    for game in match.games:
        if game.score is None:
            continue
        winner = _game_winner_side(game.score)
        counts[winner] = counts.get(winner, 0) + 1
    return counts


def current_game_number(match: Match) -> int | None:
    """The next un-scored game number for an open match. ``None`` when:

    - the match is finalized / voided / pending (not in progress or disputed);
    - a result is posted and awaiting confirmation (a pending result exists —
      score writes are locked);
    - the currently-saved games already decide the match — even if some game
      numbers in ``1..best_of`` were never played, there's no meaningful
      "next game to play" (a bo3 won 2-0 has no game 3). Returning a
      phantom number here would deep-link the dashboard / list / scoring
      page to a game that doesn't exist.

    Game rows are created lazily by the score-write endpoints, so the next
    game to score may not have a ``MatchGame`` row yet — this helper exposes
    the number rather than an object so deeplinks work either way."""
    if match.status not in (MatchStatus.in_progress, MatchStatus.disputed):
        return None
    if pending_result(match) is not None:
        return None
    target = _games_to_win(match.match_settings.best_of)
    wins = side_win_counts(match)
    if any(c >= target for c in wins.values()):
        return None
    best_of = match.match_settings.best_of
    scored = {g.game_number for g in match.games if g.score is not None}
    for n in range(1, best_of + 1):
        if n not in scored:
            return n
    return None


def _serialize_details(
    match: Match,
    current_user_id: uuid.UUID | None,
    extras: "ViewExtras | None" = None,
    domain_match: MatchModel | None = None,
) -> MatchDetails:
    extras = extras or _EMPTY_EXTRAS
    # The ``data`` view is built from the domain model. The match-details
    # endpoint loads it through MatchService/MatchRepository and passes it in;
    # the other serialize call sites already hold the full ORM row, so they
    # derive it directly rather than firing a second query.
    domain_match = domain_match or MatchModel.from_row(match)
    side_wins = side_win_counts(match)

    games_sorted = sorted(match.games, key=lambda g: g.game_number)
    games = [
        MatchDetailsGame(
            id=game.id,
            game_number=game.game_number,
            score=_score_view(game.score) if game.score else None,
        )
        for game in games_sorted
    ]

    next_number = current_game_number(match)
    current_game = (
        MatchDetailsCurrentGame(game_number=next_number)
        if next_number is not None
        else None
    )

    sides_sorted = sorted(match.sides, key=lambda s: s.side_number)
    # Anonymous viewers on the public route are never participants.
    is_participant = current_user_id is not None and _is_participant(
        match, current_user_id
    )

    return MatchDetails(
        id=match.id,
        status=match.status,
        status_label=_status_label(match),
        league=MatchLeague(id=match.league.id, name=match.league.name),
        best_of=match.match_settings.best_of,
        games_to_win=_games_to_win(match.match_settings.best_of),
        team_size=match.match_settings.team_size,
        affects_rating=match.match_settings.affects_rating,
        created_at=match.created_at,
        sides=[
            _side_schema(side, side_wins, current_user_id, extras.rating_changes)
            for side in sides_sorted
        ],
        games=games,
        current_game=current_game,
        # "This participant may edit scores" — true whenever the match is
        # scorable (no signature; see ``_is_scorable``), *independent* of
        # whether there's a next un-played game. A decided-but-unsigned board
        # (e.g. just after a dispute) is still editable, so this is True while
        # ``current_game`` is None. Spectators get the read-only view — writes
        # 404 for non-participants in the score endpoints regardless.
        can_score=(is_participant and _is_scorable(match)),
        # True iff the saved games already form a decided, validly-ordered
        # match AND no result is currently posted — the FE flips the scoring
        # page's submit button label to "Post result" when this is true.
        can_finalize=(
            is_participant and len(match.sides) >= 2 and _can_finalize(match)
        ),
        # True iff the current user can act on a posted result (Confirm or
        # Dispute). Same predicate gates both endpoints; the FE picks which
        # CTA to show based on whether the user has already signed.
        can_confirm=(
            current_user_id is not None and _can_confirm(match, current_user_id)
        ),
        signatures=_signature_views(match),
        disputed_by_user_id=disputer_of(match),
        recent_form=extras.recent_form,
        head_to_head=extras.head_to_head,
        data=serialize_match_details(domain_match),
    )


def _add_side(match: Match, side_number: int, player: User | None) -> None:
    """Attach a side to ``match``. ``player=None`` creates the sentinel
    "no opponent" side — a real second side carrying no player — so an
    opponent-less match still has two sides and is therefore scorable. It reads
    as opponent-less wherever the code inspects ``side.players`` (serialization
    renders the "No opponent" placeholder; rating updates skip player-less
    sides).

    Wiring up the ``match`` relationship on both the side and the side-player
    is what populates their (non-null, denormalized) ``match_id`` columns on
    flush."""
    side = MatchSide(match=match, side_number=side_number)
    if player is not None:
        side.players.append(MatchSidePlayer(match=match, user=player))


# ----- list helpers --------------------------------------------------------


def participant_filter[SelectT: Select[Any]](
    query: SelectT, current_user_id: uuid.UUID
) -> SelectT:
    me_in_match = (
        select(MatchSidePlayer.id)
        .where(
            MatchSidePlayer.match_id == Match.id,
            MatchSidePlayer.user_id == current_user_id,
        )
        .exists()
    )
    return query.where(me_in_match)


def _has_pending_result_exists() -> Any:
    """``EXISTS`` correlated subquery: this match has a result awaiting
    confirmation. The "posted result" marker — an ``in_progress`` match with
    this true is the derived "Awaiting confirmation" bucket (see
    ``_status_label``). Pulled into a helper so the list filter and the
    status-count aggregate split the Live vs awaiting buckets identically
    (issue #381)."""
    return (
        select(MatchResult.id)
        .where(
            MatchResult.match_id == Match.id,
            MatchResult.outcome == ResultOutcome.pending,
        )
        .exists()
    )


def _player_username_filter[SelectT: Select[Any]](query: SelectT, q: str) -> SelectT:
    """Restrict to matches that have *any* player whose username matches ``q``.

    A row-narrowing filter preserves the ``Select``'s row shape, so it's
    generic over whatever the caller is selecting (matches list vs. status
    counts).
    """
    pattern = f"%{escape_like(q.strip())}%"
    has_matching_player = (
        select(MatchSidePlayer.id)
        .join(User, User.id == MatchSidePlayer.user_id)
        .where(
            MatchSidePlayer.match_id == Match.id,
            User.username.ilike(pattern, escape="\\"),
        )
        .exists()
    )
    return query.where(has_matching_player)


# ----- endpoints -----------------------------------------------------------


@router.post(
    "/matches",
    response_model=MatchDetails,
    status_code=status.HTTP_201_CREATED,
)
async def create_match(
    payload: MatchCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchDetails:
    opponent: User | None = None
    if payload.opponent_user_id is not None:
        if payload.opponent_user_id == current_user.id:
            raise HTTPException(
                status_code=422,
                detail="You cannot start a match against yourself.",
            )
        opponent = (
            await db.execute(select(User).where(User.id == payload.opponent_user_id))
        ).scalar_one_or_none()
        if opponent is None:
            raise HTTPException(status_code=404, detail="Opponent not found.")

    if payload.rated and opponent is None:
        raise HTTPException(
            status_code=422,
            detail="A rated match needs a registered opponent.",
        )

    # Solo matches (no opponent picked) get a player-less sentinel opponent
    # side below, so they're scorable but can never affect ratings regardless
    # of the requested flag.
    affects_rating = payload.rated and opponent is not None

    league = await resolve_league(db, payload.league_id)

    settings = MatchSettings(
        team_size=1,
        best_of=payload.best_of,
        affects_rating=affects_rating,
    )
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=current_user.id,
        status=MatchStatus.in_progress,
    )
    _add_side(match, 1, current_user)
    # Always create side 2. With no opponent it's a player-less sentinel side,
    # which keeps the match scorable (two sides) while reading as "No opponent".
    _add_side(match, 2, opponent)
    # Games are no longer pre-created at match-create time — they're written
    # lazily by ``POST .../games/{n}/scores/new`` keyed on the game number, so
    # the FE can deep-link to any 1..best_of without us guessing.

    db.add(match)
    await db.commit()

    created = await _load_match(db, match.id)
    assert created is not None
    return _serialize_details(created, current_user.id)


def _apply_list_filter[SelectT: Select[Any]](
    query: SelectT, filter_: MatchListFilter
) -> SelectT:
    """Narrow ``query`` to one filter bucket. ``live`` and
    ``awaiting_confirmation`` both sit on the ``in_progress`` status but split
    on whether a result has been posted (a pending result), so neither bucket
    leaks into the other (issue #381). Every other bucket is a plain status
    match."""
    if filter_ is MatchListFilter.live:
        return query.where(
            Match.status == MatchStatus.in_progress, ~_has_pending_result_exists()
        )
    if filter_ is MatchListFilter.awaiting_confirmation:
        return query.where(
            Match.status == MatchStatus.in_progress, _has_pending_result_exists()
        )
    return query.where(Match.status == MatchStatus(filter_.value))


def _filtered_matches_query(
    q: str | None, filter_: MatchListFilter | None
) -> Select[tuple[Match]]:
    """Shared base query for the matches list + CSV export (filter + search)."""
    base = select(Match)
    if q:
        base = _player_username_filter(base, q)
    return base if filter_ is None else _apply_list_filter(base, filter_)


# Open statuses the Attention filter ranges over — the only ones where the
# current user can still owe (or be owed) a move. Completed/voided drop out.
_ATTENTION_STATUSES = (
    MatchStatus.pending,
    MatchStatus.in_progress,
    MatchStatus.disputed,
)


def _attention_matches_query(
    q: str | None, current_user_id: uuid.UUID
) -> Select[tuple[Match]]:
    """The caller's own open matches (optionally search-narrowed) — the row set
    behind the Attention tab and its tab-badge count. Restricted to
    participation, unlike the perspective-neutral browsing query."""
    base = participant_filter(select(Match), current_user_id).where(
        Match.status.in_(_ATTENTION_STATUSES)
    )
    if q:
        base = _player_username_filter(base, q)
    return base


def _attention_sort_key(
    match: Match, current_user_id: uuid.UUID
) -> tuple[int, datetime]:
    """Priority then oldest-first, so the most urgent (and most-stalled within a
    bucket) attention rows float to the top — the same order the dashboard
    panel uses."""
    kind = list_attention_kind(match, current_user_id)
    if kind is None:
        # Defensive: an open participant match always classifies. Sink any
        # surprise to the bottom rather than crash the page.
        return (len(_ATTENTION_STATUSES) + 99, match.updated_at)
    return (
        attention_priority(kind, match.match_settings.affects_rating),
        match.updated_at,
    )


@router.get("/matches.csv", response_class=Response)
async def export_matches_csv(
    status_: MatchListFilter | None = Query(default=None, alias="status"),
    q: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Response:
    """CSV export of the whole filtered match set (every match, not paginated),
    served as an attachment so the browser downloads it directly."""
    matches = (
        (
            await db.execute(
                _filtered_matches_query(q, status_)
                .options(*match_eager_options())
                .order_by(Match.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    csv_text = _matches_to_csv([_list_row(match, current_user.id) for match in matches])
    filename = f"fortymm-matches-{datetime.now(UTC).strftime('%Y-%m-%d')}.csv"
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/matches", response_model=MatchListResponse)
async def list_matches(
    status_: MatchListFilter | None = Query(default=None, alias="status"),
    attention: bool = Query(
        default=False,
        description=(
            "When true, return only the caller's open matches that need "
            "attention (theirs or someone else's), ranked by urgency. This is "
            "its own dimension — ``status`` is ignored when it's set."
        ),
    ),
    q: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=MAX_PAGE_SIZE),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchListResponse:
    # status_counts honors `q` but ignores the status/attention filter, so it's
    # built from its own aggregate and powers the All/Live/Awaiting/Up-next/Final
    # badges (and the browsing `total`) for either filter mode. The
    # awaiting-confirmation bucket is an `in_progress` row with a pending result,
    # so it's counted separately and peeled out of the `in_progress` total — the
    # `in_progress` count then reads as true-live (no posted result), keeping the
    # two buckets disjoint (issue #381).
    counts_query = select(Match.status, func.count(Match.id))
    awaiting_query = select(func.count(Match.id)).where(
        Match.status == MatchStatus.in_progress, _has_pending_result_exists()
    )
    if q:
        counts_query = _player_username_filter(counts_query, q)
        awaiting_query = _player_username_filter(awaiting_query, q)
    status_counts: dict[MatchStatus, int] = {s: 0 for s in MatchStatus}
    for status_value, count in (
        await db.execute(counts_query.group_by(Match.status))
    ).all():
        status_counts[status_value] = count
    awaiting_count = (await db.execute(awaiting_query)).scalar_one()
    # Split the raw in_progress total into true-live + awaiting-confirmation.
    status_counts[MatchStatus.in_progress] -= awaiting_count

    # The list is open to every signed-in user. Writes still gate on
    # `_is_participant` downstream.
    if attention:
        # The Attention set is bounded by the caller's *open* matches — a handful
        # even for an active player — so we load them all, rank by attention
        # priority in Python (no SQL ordering captures the per-user bucketing),
        # and paginate the sorted list. Its length *is* the tab-badge count, so
        # no separate aggregate is needed on this path.
        open_matches = (
            (
                await db.execute(
                    _attention_matches_query(q, current_user.id).options(
                        *match_eager_options()
                    )
                )
            )
            .scalars()
            .all()
        )
        ranked = sorted(
            open_matches, key=lambda m: _attention_sort_key(m, current_user.id)
        )
        total = attention_count = len(ranked)
        start = (page - 1) * page_size
        items = [
            _list_row(match, current_user.id)
            for match in ranked[start : start + page_size]
        ]
    else:
        matches = (
            (
                await db.execute(
                    _filtered_matches_query(q, status_)
                    .options(*match_eager_options())
                    .order_by(Match.created_at.desc())
                    .offset((page - 1) * page_size)
                    .limit(page_size)
                )
            )
            .scalars()
            .all()
        )
        items = [_list_row(match, current_user.id) for match in matches]
        if status_ is None:
            total = sum(status_counts.values()) + awaiting_count
        elif status_ is MatchListFilter.awaiting_confirmation:
            total = awaiting_count
        else:
            total = status_counts[MatchStatus(status_.value)]
        # The Attention badge must read its own count even while another tab is
        # active, so it's a dedicated participant-scoped aggregate (honoring `q`).
        attention_count = await _attention_count(db, q, current_user.id)

    return MatchListResponse(
        items=items,
        page=page,
        page_size=page_size,
        total=total,
        awaiting_confirmation_count=awaiting_count,
        status_counts=status_counts,
        attention_count=attention_count,
    )


async def _attention_count(
    db: AsyncSession, q: str | None, current_user_id: uuid.UUID
) -> int:
    """Count of the caller's open matches under the active search — the Attention
    tab's badge when a different tab is showing."""
    query = participant_filter(select(func.count(Match.id)), current_user_id).where(
        Match.status.in_(_ATTENTION_STATUSES)
    )
    if q:
        query = _player_username_filter(query, q)
    return int((await db.execute(query)).scalar_one())


def _list_row(match: Match, current_user_id: uuid.UUID) -> MatchListRow:
    side_wins = side_win_counts(match)
    sides_sorted = sorted(match.sides, key=lambda s: s.side_number)
    next_number = current_game_number(match)
    is_participant = _is_participant(match, current_user_id)
    # Editability follows the no-signature scratchpad rule (``_is_scorable``),
    # not whether a next game exists — so a decided-but-unsigned row still reads
    # as scorable. ``current_game_number`` stays the next-playable-game
    # deep-link target (None when decided or signed); suppressed for spectators.
    can_score = is_participant and _is_scorable(match)

    return MatchListRow(
        id=match.id,
        status=match.status,
        status_label=_status_label(match),
        league=MatchLeague(id=match.league.id, name=match.league.name),
        sides=[_side_schema(side, side_wins, current_user_id) for side in sides_sorted],
        best_of=match.match_settings.best_of,
        affects_rating=match.match_settings.affects_rating,
        created_at=match.created_at,
        current_game_number=next_number if is_participant else None,
        can_score=can_score,
        can_confirm=_can_confirm(match, current_user_id),
        attention=list_attention_kind(match, current_user_id),
    )


_CSV_HEADER = [
    "Match ID",
    "Created",
    "Status",
    "League",
    "Side 1",
    "Side 2",
    "Score",
    "Best of",
]


def _csv_side_names(side: MatchDetailsSide | None) -> str:
    return " & ".join(p.username for p in side.players) if side else ""


def _matches_to_csv(rows: list[MatchListRow]) -> str:
    """Serialize list rows to RFC-4180 CSV (the `csv` module handles quoting)."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(_CSV_HEADER)
    for row in rows:
        sides = sorted(row.sides, key=lambda s: s.side_number)
        side1 = sides[0] if sides else None
        side2 = sides[1] if len(sides) > 1 else None

        score = ""
        if (
            row.status in {MatchStatus.in_progress, MatchStatus.completed}
            and side1 is not None
            and side2 is not None
        ):
            score = f"{side1.games_won}-{side2.games_won}"

        writer.writerow(
            [
                str(row.id),
                row.created_at.isoformat(),
                row.status_label,
                row.league.name,
                _csv_side_names(side1),
                _csv_side_names(side2),
                score,
                row.best_of,
            ]
        )
    return buf.getvalue()


async def _match_details_ip_key(request: Request) -> str:
    """Per-IP key for the public match-details endpoint — applies to both
    anonymous and signed-in callers so an open URL can't be scraped from a
    single source."""
    client = request.client
    ip = client.host if client else "unknown"
    return f"match-details-ip:{ip}"


# 60/min per IP: matches the public-player endpoint's limiter. Comfortably
# above a human opening several shared match links in quick succession, well
# below scrape volume.
match_details_ip_rate_limit = RedisRateLimiter(
    rates=[Rate(60, Duration.MINUTE)],
    bucket_key="match-details-ip",
    identifier=_match_details_ip_key,
)


@router.get(
    "/matches/{match_id}",
    response_model=MatchDetails,
    dependencies=[Depends(match_details_ip_rate_limit)],
)
async def get_match(
    match_id: uuid.UUID,
    current_user: User | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_session),
    match_service: MatchService = Depends(get_match_service),
) -> MatchDetails:
    """Open to anyone, signed in or not. A signed-in caller gets
    is_current_user / can_score flags; an anonymous caller gets the same
    scorecard with those flags off. Per-IP rate-limited (60/min) so an open URL
    can't be scraped from one source.

    The richer history payload — recent form, head-to-head, and per-side rating
    changes — is *only* loaded for a caller who is a participant on this match
    (see #515). Non-participants (anonymous holders of the share URL or
    signed-in spectators) get the scorecard with those extras empty/null, so a
    public link reveals the result but not the players' rivalry / rating
    metadata.

    The serializer flags whether the current user is on a side; write paths
    below still gate on participation via `get_current_user`."""
    match = await _load_match(db, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found.")
    domain_match = await match_service.get_match(match_id)
    if domain_match is None:
        raise HTTPException(status_code=404, detail="Match not found.")
    # Gate the history/rivalry/rating payload on participation. Anonymous and
    # spectator callers never see another player's form or rating trajectory —
    # they get the scorecard with empty extras (see #515).
    is_participant = current_user is not None and _is_participant(
        match, current_user.id
    )
    extras = await _load_view_extras(db, match) if is_participant else _EMPTY_EXTRAS
    return _serialize_details(
        match,
        current_user.id if current_user else None,
        extras,
        domain_match,
    )


# ----- score writes --------------------------------------------------------


# A match that has reached one of these states is read-only — never scorable.
# ``disputed`` is deliberately absent: a dispute reopens the match for score
# correction (either side may edit — see ``dispute_match_result``), so a
# disputed match is scorable again with its games intact.
_TERMINAL_STATUSES = {
    MatchStatus.completed,
    MatchStatus.voided,
}


def _is_scorable(match: Match) -> bool:
    """Whether a match accepts score writes right now (ignoring who's asking).

    The saved games are a provisional *scratchpad* until somebody posts the
    result: editable regardless of whether they already decide the match. So
    the only gates are structural — two sides, a non-terminal status, and **no
    pending posted result**. A posted result locks the scores until it's
    confirmed or disputed; a dispute makes that result terminal and the match
    is scorable again with its games intact.

    Single source of truth shared by the write-path guard
    (``_enforce_scorable``) and the BFF ``can_score`` flag, so the flag the
    clients trust can never disagree with what the score endpoints accept."""
    return (
        len(match.sides) >= 2
        and match.status not in _TERMINAL_STATUSES
        and pending_result(match) is None
    )


def _enforce_scorable(match: Match) -> None:
    """Raise when a match can't be scored. ``_is_scorable`` owns the *decision*;
    this only picks the reason-specific status/message for a rejection, so the
    write guard can't drift from the ``can_score`` flag — a future gate added to
    ``_is_scorable`` falls through to the catch-all 409 rather than being
    silently accepted."""
    if _is_scorable(match):
        return
    if len(match.sides) < 2:
        raise HTTPException(
            status_code=422,
            detail="This match has no opponent and can't be scored.",
        )
    # A posted result locks the scores until somebody calls /confirmation
    # (finalize) or /dispute (rewind). Both per-game writes and a second
    # /results call hit this branch.
    if pending_result(match) is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                "This match has a posted result awaiting confirmation. "
                "Confirm or dispute it before editing scores."
            ),
        )
    # Terminal status (``completed``/``disputed``/``voided``) — or any future
    # ``_is_scorable`` gate without a message of its own.
    raise HTTPException(status_code=409, detail="This match is no longer scorable.")


def _enforce_confirmable(match: Match, user_id: uuid.UUID) -> MatchResult:
    """Shared preconditions for ``POST /confirmation`` and ``POST /dispute``.
    Caller is already known to be a participant (``_load_match_for_scoring``
    handles the 404). Returns the pending result the caller will respond to, so
    the handler doesn't have to re-load (and re-None-check) it."""
    if not _all_sides_have_players(match):
        raise HTTPException(
            status_code=409,
            detail="This match has no opponent and can't be signed.",
        )
    if match.status != MatchStatus.in_progress:
        raise HTTPException(
            status_code=409,
            detail="This match is no longer awaiting confirmation.",
        )
    result = pending_result(match)
    if result is None:
        raise HTTPException(
            status_code=409,
            detail="No posted result to act on. Post the result first.",
        )
    if any(r.user_id == user_id for r in result.responses):
        raise HTTPException(status_code=409, detail="You've already signed this match.")
    return result


async def _add_response_or_409(
    db: AsyncSession,
    result: MatchResult,
    user_id: uuid.UUID,
    kind: ResultResponseKind,
    detail: str,
) -> None:
    """Append a ``MatchResultResponse(user_id, kind)`` to ``result`` and flush
    it immediately. Maps the ``uq_match_result_responses_result_id_user_id``
    violation (same user racing themselves: rapid double-click, retry, browser
    back-button refire) to a clean 409 instead of bubbling a 500.

    Flushing here, not at commit, is load-bearing: it forces the
    IntegrityError to surface inside this helper's try/except no matter
    what the caller does next, so it can't escape from a context the
    handler isn't guarding. The sharpest case is ``confirm_match_result``,
    which calls ``_apply_rating_update`` right after — that helper's
    ``rating_history`` SELECT would otherwise autoflush the pending
    insert mid-read and raise IntegrityError from outside the try/except.
    ``post_match_result`` doesn't have an intervening SELECT, but the
    same flush-first contract still makes the error surface consistently
    across both call sites."""
    result.responses.append(MatchResultResponse(user_id=user_id, kind=kind))
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=409, detail=detail) from exc


def _can_confirm(match: Match, user_id: uuid.UUID | None) -> bool:
    """Mirrors ``_enforce_confirmable`` as a boolean for the BFF surface.
    True iff a ``POST /confirmation`` or ``POST /dispute`` from ``user_id``
    would currently succeed (ignoring transport-layer auth)."""
    if user_id is None:
        return False
    if match.status != MatchStatus.in_progress:
        return False
    result = pending_result(match)
    if result is None:
        return False
    if not _all_sides_have_players(match):
        return False
    if not _is_participant(match, user_id):
        return False
    if any(r.user_id == user_id for r in result.responses):
        return False
    return True


# ----- result-confirmation push -------------------------------------------

# En-dash between scores reads better than a hyphen in notification copy.
_SCORE_DASH = "–"


def _game_scores_text(match: Match, poster_side_number: int) -> str:
    """Compact per-game scores oriented poster-first (e.g. ``"11–7, 9–11"``),
    so they line up with the games-won headline the recipient sees. Games with
    no saved score are skipped."""
    parts: list[str] = []
    for game in sorted(match.games, key=lambda g: g.game_number):
        if game.score is None:
            continue
        if poster_side_number == 1:
            poster_pts, recipient_pts = (
                game.score.side_1_points,
                game.score.side_2_points,
            )
        else:
            poster_pts, recipient_pts = (
                game.score.side_2_points,
                game.score.side_1_points,
            )
        parts.append(f"{poster_pts}{_SCORE_DASH}{recipient_pts}")
    return ", ".join(parts)


def _result_confirmation_copy(
    match: Match, poster_id: uuid.UUID
) -> tuple[str, str] | None:
    """Title + body for the "confirm or dispute the result your opponent
    posted" push, framed for the *recipient* (the side that didn't post).

    The headline carries the games-won score and, where there's room, the
    body lists the individual game scores — both oriented so the poster's
    number comes first. Returns ``None`` when the match isn't a two-human
    match (nothing to confirm)."""
    poster_side = my_side(match, poster_id)
    recipient_side = opponent_side(match, poster_id)
    if poster_side is None or recipient_side is None or not poster_side.players:
        return None

    poster_name = poster_side.players[0].user.username
    wins = side_win_counts(match)
    poster_games = wins.get(poster_side.side_number, 0)
    recipient_games = wins.get(recipient_side.side_number, 0)

    # Score always reads winner-first; the verb tells the recipient which side
    # the poster claims won.
    if poster_games >= recipient_games:
        verb, hi, lo = "beating", poster_games, recipient_games
    else:
        verb, hi, lo = "losing", recipient_games, poster_games
    headline = f"{poster_name} reported {verb} you {hi}{_SCORE_DASH}{lo}"

    games = _game_scores_text(match, poster_side.side_number)
    body = (
        f"{headline}. Games: {games}. Approve or dispute?"
        if games
        else f"{headline}. Approve or dispute?"
    )
    return "Confirm your match result", body


async def _notify_result_posted(
    notifications: NotificationService, match: Match, poster_id: uuid.UUID
) -> None:
    """Queue a confirm/dispute prompt to every player on the side that now owes
    a sign-off. Each enqueued job persists the in-app record (the bell feed) and
    fans out push/email per the recipient's preferences in the worker. The APNs
    ``category``/``data`` carry the Approve/Dispute action group and the match
    id so a tapped push deep-links to the right match."""
    copy = _result_confirmation_copy(match, poster_id)
    recipient_side = opponent_side(match, poster_id)
    if copy is None or recipient_side is None:
        return
    title, body = copy
    for player in recipient_side.players:
        notifications.enqueue_notification(
            NotificationJob(
                user_id=player.user_id,
                category=NotificationCategory.RESULT_CONFIRM,
                title=title,
                body=body,
                link=f"/matches/{match.id}",
                action_label="Review",
                push_category=MATCH_RESULT_CONFIRMATION_CATEGORY,
                push_data={"match_id": str(match.id)},
            )
        )


async def _load_rating_changes(
    db: AsyncSession, match_id: uuid.UUID
) -> dict[uuid.UUID, RatingChange]:
    """Returns ``user_id -> RatingChange`` for every rating row this match
    produced. Empty for matches that didn't move ratings."""
    rows = (
        (
            await db.execute(
                select(RatingHistory).where(RatingHistory.match_id == match_id)
            )
        )
        .scalars()
        .all()
    )
    return {row.user_id: RatingChange.from_history(row) for row in rows}


def _singles_user_ids(match: Match) -> list[uuid.UUID]:
    """Singles player IDs, ordered by side number. Sides without exactly one
    player are skipped — no doubles surface yet."""
    sides_in_order = sorted(match.sides, key=lambda s: s.side_number)
    return [
        side.players[0].user_id for side in sides_in_order if len(side.players) == 1
    ]


def _history_base_query(
    current_match_id: uuid.UUID, before: datetime | None = None
) -> Select[tuple[Match]]:
    """Foundation for both recent-form and H2H lookups: completed matches
    other than this one, eagerly loading just the sides + games subtree.

    Pass ``before`` to restrict to matches completed before that instant, so a
    match viewed in the past shows the form as it stood then rather than the
    players' current form. Ordering and the ``before`` cutoff both key off the
    stable ``completed_at`` (not the mutable ``updated_at``) so editing an old
    completed match can't shuffle it within — or out of — a history window."""
    query = (
        select(Match)
        .where(
            Match.status == MatchStatus.completed,
            Match.id != current_match_id,
        )
        .options(*_match_history_options())
        .order_by(Match.completed_at.desc())
    )
    if before is not None:
        query = query.where(Match.completed_at < before)
    return query


async def _load_recent_form(
    db: AsyncSession,
    user_ids: list[uuid.UUID],
    match: Match,
) -> list[MatchDetailsPlayerForm]:
    if not user_ids:
        return []

    result: list[MatchDetailsPlayerForm] = []
    for user_id in user_ids:
        rows = (
            (
                await db.execute(
                    participant_filter(
                        _history_base_query(match.id, before=match.created_at),
                        user_id,
                    ).limit(RECENT_FORM_LIMIT)
                )
            )
            .scalars()
            .all()
        )
        rating_before, rating_history = await _load_pre_match_rating(
            db, user_id, match.league_id, match.created_at
        )
        matches_before, wins_before = await _load_career_before(
            db, user_id, match.id, match.created_at
        )
        result.append(
            MatchDetailsPlayerForm(
                user_id=user_id,
                recent_results=[_build_form_result(past, user_id) for past in rows],
                rating_before=rating_before,
                rating_history=rating_history,
                career_matches_before=matches_before,
                career_wins_before=wins_before,
            )
        )
    return result


async def _load_pre_match_rating(
    db: AsyncSession,
    user_id: uuid.UUID,
    league_id: uuid.UUID,
    before: datetime,
) -> tuple[float | None, list[float]]:
    """Returns ``(most-recent-value, chronological-list)``. Strict ``<`` on
    ``before`` so this match's own rating row never leaks in."""
    rows = (
        (
            await db.execute(
                select(RatingHistory.rating_value)
                .where(
                    RatingHistory.user_id == user_id,
                    RatingHistory.league_id == league_id,
                    RatingHistory.created_at < before,
                )
                .order_by(RatingHistory.created_at.desc())
                .limit(RATING_HISTORY_LIMIT)
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        return None, []
    history = list(reversed(rows))
    return history[-1], history


async def _load_career_before(
    db: AsyncSession,
    user_id: uuid.UUID,
    current_match_id: uuid.UUID,
    before: datetime,
) -> tuple[int, int]:
    """Cross-league ``(matches, wins)``. Excludes ``current_match_id`` so a
    just-completed match isn't double-counted into its own pre-match record."""
    side = aliased(MatchSide)
    player = aliased(MatchSidePlayer)
    row = (
        await db.execute(
            select(
                func.count(Match.id),
                func.count(Match.id).filter(side.won.is_(True)),
            )
            .join(side, side.match_id == Match.id)
            .join(player, player.match_side_id == side.id)
            .where(
                player.user_id == user_id,
                Match.status == MatchStatus.completed,
                Match.id != current_match_id,
                Match.completed_at < before,
            )
        )
    ).one()
    return int(row[0]), int(row[1])


def _build_form_result(past_match: Match, user_id: uuid.UUID) -> MatchDetailsFormResult:
    mine = my_side(past_match, user_id)
    assert mine is not None  # participant_filter guarantees membership
    # The history query filters status == completed, so completed_at is set.
    assert past_match.completed_at is not None
    side_wins = side_win_counts(past_match)
    player_games = side_wins.get(mine.side_number, 0)
    opp_games = sum(wins for n, wins in side_wins.items() if n != mine.side_number)
    return MatchDetailsFormResult(
        match_id=past_match.id,
        is_win=mine.won is True,
        player_games_won=player_games,
        opponent_games_won=opp_games,
        opponent_username=opponent_username(past_match, user_id),
        completed_at=past_match.completed_at,
    )


async def _load_head_to_head(
    db: AsyncSession,
    user_ids: list[uuid.UUID],
    match: Match,
) -> MatchDetailsH2H | None:
    if len(user_ids) != 2:
        return None
    current_match_id = match.id
    user_a, user_b = user_ids
    rows_query = participant_filter(
        participant_filter(
            _history_base_query(current_match_id, before=match.created_at), user_a
        ),
        user_b,
    ).options(selectinload(Match.match_settings))
    rows = (await db.execute(rows_query.limit(H2H_MEETINGS_LIMIT))).scalars().all()

    meetings: list[MatchDetailsH2HMeeting] = []
    for past in rows:
        past_a = my_side(past, user_a)
        past_b = my_side(past, user_b)
        assert past_a is not None and past_b is not None
        # The history query filters status == completed, so completed_at is set.
        assert past.completed_at is not None
        side_wins = side_win_counts(past)
        a_games = side_wins.get(past_a.side_number, 0)
        b_games = side_wins.get(past_b.side_number, 0)
        winner_side: int | None = (
            1 if past_a.won is True else 2 if past_b.won is True else None
        )
        meetings.append(
            MatchDetailsH2HMeeting(
                match_id=past.id,
                completed_at=past.completed_at,
                side_1_games_won=a_games,
                side_2_games_won=b_games,
                winner_side_number=winner_side,
                rated=past.match_settings.affects_rating,
            )
        )

    # Prior-meetings aggregates (completed before this match) so the displayed
    # window doesn't undercount the rivalry going into this match. Driven from
    # MatchSide.won so a future void/dispute that leaves `won` null naturally
    # drops out of both totals.
    a_side = aliased(MatchSide)
    b_side = aliased(MatchSide)
    a_player = aliased(MatchSidePlayer)
    b_player = aliased(MatchSidePlayer)
    counts_query = (
        select(
            func.count(Match.id),
            func.count(Match.id).filter(a_side.won.is_(True)),
            func.count(Match.id).filter(b_side.won.is_(True)),
        )
        .join(a_side, a_side.match_id == Match.id)
        .join(a_player, a_player.match_side_id == a_side.id)
        .join(b_side, b_side.match_id == Match.id)
        .join(b_player, b_player.match_side_id == b_side.id)
        .where(
            Match.status == MatchStatus.completed,
            Match.id != current_match_id,
            Match.completed_at < match.created_at,
            a_player.user_id == user_a,
            b_player.user_id == user_b,
            a_side.id != b_side.id,
        )
    )
    total, a_wins, b_wins = (await db.execute(counts_query)).one()

    return MatchDetailsH2H(
        total_meetings=total,
        side_1_wins=a_wins,
        side_2_wins=b_wins,
        recent_meetings=meetings,
    )


@dataclass
class ViewExtras:
    rating_changes: dict[uuid.UUID, RatingChange]
    recent_form: list[MatchDetailsPlayerForm]
    head_to_head: MatchDetailsH2H | None


_EMPTY_EXTRAS = ViewExtras(rating_changes={}, recent_form=[], head_to_head=None)


async def _load_view_extras(db: AsyncSession, match: Match) -> ViewExtras:
    user_ids = _singles_user_ids(match)
    return ViewExtras(
        rating_changes=await _load_rating_changes(db, match.id),
        recent_form=await _load_recent_form(db, user_ids, match),
        head_to_head=await _load_head_to_head(
            db, user_ids if len(user_ids) == 2 else [], match
        ),
    )


async def _get_or_create_user_league_rating(
    db: AsyncSession,
    league_id: uuid.UUID,
    user_id: uuid.UUID,
    strategy: RatingStrategy,
) -> UserLeagueRating:
    existing = (
        await db.execute(
            select(UserLeagueRating).where(
                UserLeagueRating.league_id == league_id,
                UserLeagueRating.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    rating = UserLeagueRating.seed_for_strategy(league_id, user_id, strategy)
    db.add(rating)
    await db.flush()
    return rating


async def _apply_rating_update(db: AsyncSession, match: Match) -> None:
    """When ``match`` has just transitioned to completed and its league runs an
    automatic rating strategy, compute the singles update and persist a
    ``rating_history`` row + bump ``user_league_ratings`` for each side.

    Idempotent on subsequent score edits: if any history row already exists for
    this match, we skip. Re-applying ratings after a score correction is its own
    feature (tied to dispute/void flows, which aren't wired up yet)."""
    if match.status != MatchStatus.completed:
        return
    if not match.match_settings.affects_rating:
        return
    if match.match_settings.team_size != 1:
        return

    league = match.league
    strategy = league.rating_strategy
    if not strategy.is_automatic:
        return
    calculator = get_calculator(strategy.key)
    if calculator is None:
        return

    already_applied = (
        await db.execute(
            select(RatingHistory.id).where(RatingHistory.match_id == match.id).limit(1)
        )
    ).scalar_one_or_none()
    if already_applied is not None:
        return

    winning_side = next((s for s in match.sides if s.won is True), None)
    losing_side = next((s for s in match.sides if s.won is False), None)
    if winning_side is None or losing_side is None:
        return
    if not winning_side.players or not losing_side.players:
        return

    winner_player = winning_side.players[0]
    loser_player = losing_side.players[0]

    winner_rating = await _get_or_create_user_league_rating(
        db, league.id, winner_player.user_id, strategy
    )
    loser_rating = await _get_or_create_user_league_rating(
        db, league.id, loser_player.user_id, strategy
    )
    if winner_rating.rating_state is None or loser_rating.rating_state is None:
        return

    prev_winner_value = winner_rating.rating_value
    prev_loser_value = loser_rating.rating_value

    new_winner_state, new_loser_state = calculator.update_singles(
        winner_rating.rating_state, loser_rating.rating_state
    )
    validate_state(new_winner_state, strategy)
    validate_state(new_loser_state, strategy)

    new_winner_value = state_rating_value(new_winner_state)
    new_loser_value = state_rating_value(new_loser_state)

    winner_rating.rating_state = new_winner_state
    winner_rating.rating_value = new_winner_value
    loser_rating.rating_state = new_loser_state
    loser_rating.rating_value = new_loser_value

    db.add(
        RatingHistory(
            league_id=league.id,
            user_id=winner_player.user_id,
            match_id=match.id,
            rating_strategy_id=strategy.id,
            rating_value=new_winner_value,
            rating_state=new_winner_state,
            previous_rating_value=prev_winner_value,
            source=RatingHistorySource.match,
        )
    )
    db.add(
        RatingHistory(
            league_id=league.id,
            user_id=loser_player.user_id,
            match_id=match.id,
            rating_strategy_id=strategy.id,
            rating_value=new_loser_value,
            rating_state=new_loser_state,
            previous_rating_value=prev_loser_value,
            source=RatingHistorySource.match,
        )
    )


# ----- finalize-payload validation + apply --------------------------------


def _validate_finalize_games(games: list[MatchResultsGameWrite], best_of: int) -> int:
    """Cross-game invariants for a finalize payload. Per-game point legality
    is already enforced by ``MatchResultsGameWrite``. Returns the decided side
    number (1 or 2); raises ``ValueError`` with a human-readable detail on any
    failure (the route handler maps that to 422)."""
    if not games:
        raise ValueError("A match needs at least one game to finalize.")

    numbers = [g.game_number for g in games]
    if any(n > best_of for n in numbers):
        raise ValueError(f"Each game_number must be ≤ best_of ({best_of}).")
    if len(set(numbers)) != len(numbers):
        raise ValueError("Duplicate game_number in payload.")
    if sorted(numbers) != list(range(1, len(numbers) + 1)):
        raise ValueError("Games must be numbered 1..N consecutively with no gaps.")

    target = _games_to_win(best_of)
    games_in_order = sorted(games, key=lambda g: g.game_number)
    wins: dict[int, int] = {1: 0, 2: 0}
    decided_at: int | None = None
    decided_side: int | None = None
    for g in games_in_order:
        winner = 1 if g.side_1_points > g.side_2_points else 2
        wins[winner] += 1
        if decided_side is None and wins[winner] >= target:
            decided_side = winner
            decided_at = g.game_number

    if decided_side is None or decided_at is None:
        raise ValueError(
            f"No side reached {target} game wins — the match isn't decided."
        )
    if decided_at != games_in_order[-1].game_number:
        raise ValueError(
            "Scored games extend past the deciding game; "
            "drop any games after the decider."
        )
    return decided_side


def _games_payload_from_match(match: Match) -> list[MatchResultsGameWrite]:
    """Recast currently-saved scores as a finalize payload, so ``_can_finalize``
    can reuse ``_validate_finalize_games`` instead of duplicating its rules."""
    return [
        MatchResultsGameWrite(
            game_number=g.game_number,
            side_1_points=g.score.side_1_points,
            side_2_points=g.score.side_2_points,
        )
        for g in match.games
        if g.score is not None
    ]


def _can_finalize(match: Match) -> bool:
    """Whether ``POST /v1/matches/{id}/results`` would succeed on the
    currently-saved scores (ignoring authorization). Drives the FE's
    ``can_finalize`` flag and the submit button's adaptive label.

    Returns False once anyone has posted a result — the next action on a match
    with a pending result is /confirmation or /dispute, not another /results. A
    ``disputed`` match has no pending result and stays finalizable so the
    disputer can re-post a corrected (or unchanged) board back into the sign-off
    flow."""
    if match.status not in (MatchStatus.in_progress, MatchStatus.disputed):
        return False
    if pending_result(match) is not None:
        return False
    try:
        _validate_finalize_games(
            _games_payload_from_match(match), match.match_settings.best_of
        )
    except ValueError:
        return False
    return True


def _result_games_snapshot(payload: MatchResultsWrite) -> list[dict[str, int]]:
    """The immutable JSONB snapshot stored on a ``MatchResult`` — the claimed
    board frozen at post time, ordered by game number. (A typed read-side decode
    lands with #366, the first consumer of the snapshot.)"""
    return [
        {
            "game_number": g.game_number,
            "side_1_points": g.side_1_points,
            "side_2_points": g.side_2_points,
        }
        for g in sorted(payload.games, key=lambda g: g.game_number)
    ]


async def _commit_canonical_games(
    db: AsyncSession,
    match: Match,
    payload: MatchResultsWrite,
) -> None:
    """Replace ``match.games`` (and the attached score rows) with the canonical
    payload and set ``side.score`` from it. **Does not change ``match.status``
    or ``side.won``** — the caller picks whether the result is final
    (solo/unrated: immediately at /results) or awaiting confirmation (rated),
    and stamps ``side.won`` via ``_set_side_won`` only at that final moment."""
    # ``Match.games`` cascades ``all, delete-orphan``; clearing the collection
    # marks each existing MatchGame (and via MatchGame.score's own cascade,
    # the MatchGameScore) for delete. We must flush the deletes before
    # inserting new games at the same numbers, otherwise the
    # ``uq_match_games_match_id_game_number`` constraint trips during
    # autoflush.
    match.games.clear()
    await db.flush()

    for game in sorted(payload.games, key=lambda g: g.game_number):
        match.games.append(
            MatchGame(
                game_number=game.game_number,
                score=MatchGameScore(
                    side_1_points=game.side_1_points,
                    side_2_points=game.side_2_points,
                ),
            )
        )

    new_wins: dict[int, int] = {1: 0, 2: 0}
    for g in payload.games:
        new_wins[1 if g.side_1_points > g.side_2_points else 2] += 1
    for side in match.sides:
        side.score = new_wins.get(side.side_number, 0)


def _set_side_won(match: Match, decided_side: int) -> None:
    """Stamp the W/L outcome on each side. Called only at the moment a match
    becomes ``completed`` — /results for matches that skip confirmation,
    /confirmation for rated ones — so a profile never shows a WIN/LOSS for a
    result the opponent hasn't ratified yet (issue #485)."""
    for side in match.sides:
        side.won = side.side_number == decided_side


def _requires_confirmation(match: Match) -> bool:
    """Only rated matches go through the sign-off round-trip. Confirmation
    exists to protect ratings from one-sided claims; an unrated match has no
    stakes worth a second signature, and a solo match has no second human to
    sign anyway (rated already implies a registered opponent at creation —
    the player check is defensive)."""
    return match.match_settings.affects_rating and _all_sides_have_players(match)


def _posted_decided_side(match: Match) -> int:
    """Winner side number per the committed canonical games. Only meaningful
    once a result has been posted: /results validated the games as decided,
    and ``_enforce_scorable`` freezes them while a result is pending, so exactly
    one side has clinched by the time /confirmation reads this."""
    target = _games_to_win(match.match_settings.best_of)
    for side_number, count in sorted(side_win_counts(match).items()):
        if count >= target:
            return side_number
    raise HTTPException(
        status_code=409, detail="The posted games no longer decide this match."
    )


# ----- scoring endpoints ---------------------------------------------------


class MatchLockUnavailable(Exception):
    """``SELECT ... FOR UPDATE NOWAIT`` found the match row already locked by a
    concurrent sign-off transaction. Raised by ``_lock_match_row(nowait=True)``
    so the caller can translate it into a fast, clean 409 instead of blocking
    on the lock (see ``post_match_result``)."""


# Postgres SQLSTATE for a ``NOWAIT`` lock that could not be acquired.
_LOCK_NOT_AVAILABLE = "55P03"


async def _lock_match_row(
    db: AsyncSession, match_id: uuid.UUID, *, nowait: bool = False
) -> None:
    """Take a transaction-scoped row lock on the ``matches`` row so the
    sign-off transitions (``/results``, ``/confirmation``, ``/dispute``)
    serialize against each other.

    Without this, a participant firing ``/confirmation`` and ``/dispute``
    concurrently lets both transactions pass ``_enforce_confirmable`` on the
    same pre-image and both commit — finalizing the match with ``won=None``,
    a single signature, and a rating change applied (issue #365). The lock
    forces the second transaction to wait for the first to commit and then
    re-read the post-image, so its guard returns a clean 409.

    It's a thin ``SELECT matches.id ... FOR UPDATE`` rather than adding
    ``.with_for_update()`` to the eager ``_load_match`` query: a narrow
    lock-only select is cheaper than re-running ``match_eager_options`` (which
    fans out into a selectinload query per relationship) just to take the lock,
    and acquiring it on its own line makes the lock-then-read ordering explicit
    — the subsequent load sees the serialized state. Locking just the parent
    row is enough — every sign-off transition reads and writes that match's
    children under cover of this lock.

    ``nowait=True`` adds ``NOWAIT``: if the row is already locked, Postgres
    raises immediately instead of blocking, which we surface as
    ``MatchLockUnavailable``. ``post_match_result`` uses this so a double-tapped
    finalize doesn't park a request (and its pooled DB connection) on the lock
    for the full duration of the in-flight post — the pile-up that wedged the
    whole instance under a stray double-click (issue #641). The blocking form
    is kept for /confirmation and /dispute, where a second concurrent caller is
    a *legitimate* signer that must wait, re-read, and proceed."""
    stmt = select(Match.id).where(Match.id == match_id).with_for_update(nowait=nowait)
    try:
        await db.execute(stmt)
    except DBAPIError as exc:
        if nowait and getattr(exc.orig, "sqlstate", None) == _LOCK_NOT_AVAILABLE:
            raise MatchLockUnavailable from exc
        raise


async def _load_match_for_scoring(
    db: AsyncSession,
    match_id: uuid.UUID,
    current_user_id: uuid.UUID,
    *,
    lock: bool = False,
    nowait: bool = False,
) -> Match:
    # ``lock`` callers (the sign-off transitions) take the row lock *before*
    # the eager load so the match state they read is the serialized one.
    if lock:
        await _lock_match_row(db, match_id, nowait=nowait)
    match = await _load_match(db, match_id)
    if match is None or not _is_participant(match, current_user_id):
        raise HTTPException(status_code=404, detail="Match not found.")
    return match


# Per-game endpoints are addressed by ``game_number``: a game row may not
# exist yet (the FE deeplinks straight into ``/games/N/scores/new``). The
# create handler lookups-or-inserts the MatchGame; update and delete operate
# on an existing score. All three are pure "save / clear scratchpad state" —
# they never touch match.status, side wins, side.won, or ratings. The single
# canonical commit happens in ``finalize_match`` below.


@router.post(
    "/matches/{match_id}/games/{game_number}/scores/new",
    response_model=MatchDetails,
    status_code=status.HTTP_201_CREATED,
    responses={409: {"model": MatchGameScoreConflict}},
)
async def create_game_score(
    match_id: uuid.UUID,
    payload: MatchGameScoreWrite,
    game_number: Annotated[int, Path(ge=1, le=7)],
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchDetails:
    match = await _load_match_for_scoring(db, match_id, current_user.id)
    _enforce_scorable(match)
    if game_number > match.match_settings.best_of:
        raise HTTPException(
            status_code=422,
            detail=(
                f"This match is best of {match.match_settings.best_of}; "
                f"game {game_number} can't exist."
            ),
        )

    game = next((g for g in match.games if g.game_number == game_number), None)
    if game is None:
        game = MatchGame(game_number=game_number)
        match.games.append(game)
    elif game.score is not None:
        # A concurrent participant already created this game's score — the same
        # conflict the update path guards against, just on first write. Hand
        # back the committed score so the client surfaces it for review instead
        # of overwriting it.
        raise _score_conflict(_score_view(game.score))

    game.score = MatchGameScore(
        side_1_points=payload.side_1_points,
        side_2_points=payload.side_2_points,
    )

    try:
        await db.commit()
    except IntegrityError as exc:
        # Two participants on the same game-entry page submitting at once both
        # lazily insert the same game row (uq_match_games_match_id_game_number)
        # and/or its score (uq_match_game_scores_match_game_id). The pre-checks
        # above pass for both before either commits, so the loser of the race
        # trips a unique constraint. The committed row belongs to the winner's
        # transaction, so reload to read it for the conflict body.
        await db.rollback()
        raise _score_conflict(
            await _committed_score(db, match_id, game_number)
        ) from exc

    reloaded = await _load_match(db, match.id)
    assert reloaded is not None
    extras = await _load_view_extras(db, reloaded)
    return _serialize_details(reloaded, current_user.id, extras)


@router.put(
    "/matches/{match_id}/games/{game_number}/scores",
    response_model=MatchDetails,
    responses={409: {"model": MatchGameScoreConflict}},
)
async def update_game_score(
    match_id: uuid.UUID,
    payload: MatchGameScoreUpdate,
    game_number: Annotated[int, Path(ge=1, le=7)],
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchDetails:
    match = await _load_match_for_scoring(db, match_id, current_user.id)
    _enforce_scorable(match)

    game = next((g for g in match.games if g.game_number == game_number), None)
    if game is None or game.score is None:
        raise HTTPException(status_code=404, detail="Score not found.")

    # Optimistic concurrency: replace the points only while the committed row is
    # still at the version the caller last read. The ``WHERE version =`` clause
    # is the whole guard — if a concurrent participant has saved this game since,
    # zero rows match and we reject the write rather than overwrite their result
    # (the data-loss the client used to walk into by re-issuing as a blind PUT).
    result = await db.execute(
        update(MatchGameScore)
        .where(
            MatchGameScore.id == game.score.id,
            MatchGameScore.version == payload.expected_version,
        )
        .values(
            side_1_points=payload.side_1_points,
            side_2_points=payload.side_2_points,
            version=MatchGameScore.version + 1,
        )
    )
    if cast(CursorResult[Any], result).rowcount == 0:
        # Lost the race: a concurrent participant saved this game since the
        # caller last read it, so the conditional UPDATE matched no row. The
        # update changed nothing, so there's nothing to undo — we just refresh
        # the score to the value as it actually stands now and 409 (the request
        # teardown rolls the no-op transaction back). The client shows "your
        # stale entry vs. what's committed" rather than overwriting their save.
        await db.refresh(game.score)
        raise _score_conflict(_score_view(game.score))

    await db.commit()

    reloaded = await _load_match(db, match.id)
    assert reloaded is not None
    extras = await _load_view_extras(db, reloaded)
    return _serialize_details(reloaded, current_user.id, extras)


@router.delete(
    "/matches/{match_id}/games/{game_number}/scores",
    response_model=MatchDetails,
)
async def delete_game_score(
    match_id: uuid.UUID,
    game_number: Annotated[int, Path(ge=1, le=7)],
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchDetails:
    match = await _load_match_for_scoring(db, match_id, current_user.id)
    _enforce_scorable(match)

    game = next((g for g in match.games if g.game_number == game_number), None)
    if game is None or game.score is None:
        raise HTTPException(status_code=404, detail="Score not found.")

    # Drop the score; the MatchGame stays so a subsequent POST .../scores/new
    # for the same number just attaches a fresh score row to the existing game.
    # delete-orphan on ``MatchGame.score`` removes the row on flush.
    game.score = None

    await db.commit()

    reloaded = await _load_match(db, match.id)
    assert reloaded is not None
    extras = await _load_view_extras(db, reloaded)
    return _serialize_details(reloaded, current_user.id, extras)


@router.post(
    "/matches/{match_id}/results",
    response_model=MatchDetails,
    status_code=status.HTTP_201_CREATED,
)
async def post_match_result(
    match_id: uuid.UUID,
    payload: MatchResultsWrite,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
    notifications: NotificationService = Depends(get_notification_service),
) -> MatchDetails:
    """Post the result of a match. Any previously-saved per-game scores are
    discarded; the payload's games (validated as a complete, decided match)
    become canon.

    A new ``MatchResult`` row is created carrying an immutable snapshot of the
    claimed board; a prior disputed result stays as history. For a rated match
    the caller's ``confirm`` response is recorded on it and status stays
    ``in_progress`` until every side confirms — the other side acts on the
    posted result via ``POST /confirmation`` or ``POST /dispute``, and
    ``side.won`` plus the rating update fire inside /confirmation when the final
    confirm lands. Unrated matches (nothing at stake worth a second sign-off)
    and solo matches (no second party to attest) finalize immediately here, with
    the result created already ``confirmed``."""
    try:
        match = await _load_match_for_scoring(
            db, match_id, current_user.id, lock=True, nowait=True
        )
    except MatchLockUnavailable as exc:
        # A concurrent /results is mid-flight (a double-tapped finalize). Only
        # one result can be posted, so the loser of the race has no work to do —
        # bail out fast with a 409 rather than blocking on the lock and tying up
        # a connection for the duration of the in-flight post (issue #641). The
        # winner's 201 carries the canonical result; the client refetches it.
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="A result is already being posted for this match. "
            "Refresh to see the latest.",
        ) from exc
    _enforce_scorable(match)

    try:
        decided_side = _validate_finalize_games(
            payload.games, match.match_settings.best_of
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    await _commit_canonical_games(db, match, payload)

    # The new posting is its own first-class row. A prior disputed result stays
    # as history alongside it; "latest result" derivation makes this the current
    # one. The board is snapshotted immutably here even though the working
    # ``match_games`` were just synced to the same payload — the two diverge once
    # a dispute reopens the scratchpad for editing.
    result = MatchResult(
        submitted_by_user_id=current_user.id,
        games=_result_games_snapshot(payload),
    )
    match.results.append(result)

    # Drives the post-commit push: only a rated match leaves the other side
    # owing a confirm/dispute. Computed before commit; the recipient gets
    # pinged once the result is durably saved.
    awaiting_confirmation = _requires_confirmation(match)
    if not awaiting_confirmation:
        # Solo / unrated path: no second sign-off needed — the result is born
        # ``confirmed`` and the match finalizes immediately (stamping
        # ``completed_at``), no response row inserted.
        result.outcome = ResultOutcome.confirmed
        match.mark_completed()
        _set_side_won(match, decided_side)
        await _apply_rating_update(db, match)
    else:
        # Rated path: the result is ``pending`` and the caller is its first
        # confirmer. Status is (re)set to in_progress — load-bearing when
        # re-posting a ``disputed`` match, a no-op otherwise — and side.won
        # stays unset until /confirmation lands the last needed confirm.
        match.status = MatchStatus.in_progress
        await _add_response_or_409(
            db,
            result,
            current_user.id,
            ResultResponseKind.confirm,
            "Result already posted; use /confirmation.",
        )

    await db.commit()

    reloaded = await _load_match(db, match.id)
    assert reloaded is not None
    extras = await _load_view_extras(db, reloaded)
    details = _serialize_details(reloaded, current_user.id, extras)
    # Record + notify the side that now owes a sign-off. Built after the
    # response and best-effort: the result is already committed, so *nothing*
    # here may turn the 201 into a 500 — not a DB error, and not a delivery-side
    # failure (e.g. a malformed APNs key making jwt.encode raise). Hence the
    # blanket catch, mirroring the fire-and-forget enqueue guards in
    # app.sessions. The session is rolled back so the request's teardown is
    # clean even when the failure was the in-app persist commit.
    if awaiting_confirmation:
        try:
            await _notify_result_posted(notifications, reloaded, current_user.id)
        except Exception:
            await db.rollback()
            log.exception(
                "Failed to record result-confirmation notification",
                extra={"match_id": str(match.id)},
            )
    return details


@router.post(
    "/matches/{match_id}/confirmation",
    response_model=MatchDetails,
    status_code=status.HTTP_201_CREATED,
)
async def confirm_match_result(
    match_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchDetails:
    """Sign off on a posted result. When this is the last confirm needed
    (every side has at least one confirming player) the result flips to
    ``confirmed``, the match to ``completed``, ``side.won`` is stamped from the
    posted games, and the rating update runs — exactly once."""
    match = await _load_match_for_scoring(db, match_id, current_user.id, lock=True)
    result = _enforce_confirmable(match, current_user.id)

    await _add_response_or_409(
        db,
        result,
        current_user.id,
        ResultResponseKind.confirm,
        "You've already signed this match.",
    )
    if _all_sides_responded_confirm(match):
        result.outcome = ResultOutcome.confirmed
        match.mark_completed()
        _set_side_won(match, _posted_decided_side(match))
        await _apply_rating_update(db, match)

    await db.commit()

    reloaded = await _load_match(db, match.id)
    assert reloaded is not None
    extras = await _load_view_extras(db, reloaded)
    return _serialize_details(reloaded, current_user.id, extras)


@router.post(
    "/matches/{match_id}/dispute",
    response_model=MatchDetails,
    # 200 (not 201): dispute is response-like but terminal for the result — it
    # rejects the pending result and rewinds side win flags rather than creating
    # a confirmable resource. Declared explicitly so the contrast with /results
    # and /confirmation (both 201) is intentional in the source, not a default.
    status_code=status.HTTP_200_OK,
)
async def dispute_match_result(
    match_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchDetails:
    """Reject a posted result. A ``dispute`` response is recorded on the pending
    result, marking it ``disputed`` (it stays as history — its ``games``
    snapshot preserves the rejected board), and the side win flags reset to
    ``None``. The working ``match_games`` themselves stay in place so the
    disputer can navigate to the contested game and PUT a corrected score; the
    per-game endpoints unblock automatically once the result is no longer
    pending (see ``_enforce_scorable``)."""
    match = await _load_match_for_scoring(db, match_id, current_user.id, lock=True)
    result = _enforce_confirmable(match, current_user.id)

    # Record who rejected the result, then mark it terminally disputed. The
    # ``dispute`` response (and the submitter's ``confirm``) persist as history;
    # the BFF derives ``disputed_by_user_id`` from this response.
    await _add_response_or_409(
        db,
        result,
        current_user.id,
        ResultResponseKind.dispute,
        "You've already signed this match.",
    )
    result.outcome = ResultOutcome.disputed
    # Move out of ``in_progress`` into the dedicated ``disputed`` state so a
    # reopened match is unambiguous to the dashboard classifier and the matches
    # list, instead of being indistinguishable from a never-posted live match.
    # Scoring is reopened anyway (no pending result + ``disputed`` is
    # non-terminal), and re-posting via /results flips it back to ``in_progress``.
    match.status = MatchStatus.disputed
    # Un-completed: drop the completion stamp so a re-post stamps a fresh one
    # and this match doesn't linger in any history window while disputed.
    match.completed_at = None
    for side in match.sides:
        # ``side.won`` is only stamped at completion now, so it's still None
        # on an awaiting-confirmation match — nulling it here is defensive.
        # ``side.score`` is the denormalized games-won mirror — zero it so a
        # direct DB reader doesn't see won=None with score>0 (the games still
        # imply 2-1 etc., but the BFF derives that from MatchGame, not from
        # side.score).
        side.won = None
        side.score = 0

    await db.commit()

    reloaded = await _load_match(db, match.id)
    assert reloaded is not None
    extras = await _load_view_extras(db, reloaded)
    return _serialize_details(reloaded, current_user.id, extras)
