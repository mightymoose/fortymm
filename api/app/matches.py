import csv
import io
import logging
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
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    User,
)
from app.notifications.apns import MATCH_RESULT_CONFIRMATION_CATEGORY
from app.notifications.dependencies import get_notification_service
from app.notifications.service import NotificationService
from app.notifications.taxonomy import NotificationCategory
from app.players import escape_like
from app.rate_limiting import RedisRateLimiter
from app.result_acceptance import (
    PostedGamesNotDecisiveError,
    StandingResultConflictError,
    _apply_rating_update,
    _game_winner_side,
    _games_to_win,
    _set_side_won,
    accept_standing_result,
)
from app.result_acceptance import (
    side_win_counts as side_win_counts,  # noqa: PLC0414  (explicit re-export: app.dashboard imports it from here)
)
from app.result_chain import accepted_result, standing_result
from app.retirement import retirement_deadline
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
    MatchNegotiation,
    MatchResultsGameWrite,
    MatchResultsWrite,
    NegotiationDiffEntry,
    NegotiationGame,
    NegotiationResult,
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
# pulled up front. The posted results (the propose/accept chain) are needed
# wherever ``can_finalize`` / the awaiting-acceptance status label / the
# derived ``negotiation`` block are computed.
def match_eager_options() -> tuple[ExecutableOption, ...]:
    return (
        selectinload(Match.match_settings),
        selectinload(Match.league).selectinload(League.rating_strategy),
        selectinload(Match.results),
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
    The acceptance flow needs a second human, so solo matches skip
    it entirely; this is the predicate that detects that case."""
    return len(match.sides) >= 2 and all(side.players for side in match.sides)


def _status_label(match: Match) -> str:
    """User-facing label for a match's lifecycle position. An ``in_progress``
    match with a standing posted result is waiting on the other side — surface
    that distinctly so the FE doesn't need to know about the result model to
    render it."""
    if match.status == MatchStatus.in_progress and standing_result(match) is not None:
        return "Awaiting acceptance"
    # Exhaustive — adding an enum member is a type error until handled.
    match match.status:
        case MatchStatus.pending:
            return "Scheduled"
        case MatchStatus.in_progress:
            return "Live"
        case MatchStatus.completed:
            return "Final"
        case MatchStatus.disputed:
            # Dead: nothing sets MatchStatus.disputed under the propose/accept
            # model (there is no dispute verb). Kept only to satisfy the
            # exhaustive match; follow-up: drop the enum value entirely.
            return "In review"
        case MatchStatus.voided:
            return "Voided"


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


def current_game_number(match: Match) -> int | None:
    """The next un-scored game number for an open match. ``None`` when:

    - the match is finalized / voided / pending (not in progress or disputed);
    - any result has been posted (the board is frozen — score writes are locked
      once a result exists);
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
    if match.results:
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


def _negotiation_game(snapshot: dict[str, int]) -> NegotiationGame:
    return NegotiationGame(
        game_number=snapshot["game_number"],
        side_1_points=snapshot["side_1_points"],
        side_2_points=snapshot["side_2_points"],
    )


def _negotiation_result(result: MatchResult) -> NegotiationResult:
    return NegotiationResult(
        id=result.id,
        games=[
            _negotiation_game(g)
            for g in sorted(result.games, key=lambda g: g["game_number"])
        ],
        submitted_by=result.submitted_by_user_id,
        submitted_at=result.submitted_at,
    )


def _negotiation_diff(
    baseline_games: list[dict[str, int]],
    standing_games: list[dict[str, int]],
) -> list[NegotiationDiffEntry]:
    """Viewer-relative diff between the viewer's own last proposal (baseline)
    and the standing proposal. Emits one entry per game that differs, ordered by
    game number over the union of both boards. A correction may add, remove, or
    change games (a decided board can shorten or lengthen — CONTEXT.md
    "Correction", ADR-0001), so an entry is one of:

    - **added** — the standing board has a game the baseline lacked (``old=None``);
    - **removed** — the baseline had a game the standing board dropped (``new=None``);
    - **changed** — both present, points differ.

    Unchanged games are skipped. Computed purely from the two snapshots; the
    chain walk to pick the baseline is what collapses the opponent's intermediate
    self-edits."""
    baseline_by_number = {g["game_number"]: g for g in baseline_games}
    standing_by_number = {g["game_number"]: g for g in standing_games}
    entries: list[NegotiationDiffEntry] = []
    for number in sorted(baseline_by_number.keys() | standing_by_number.keys()):
        old = baseline_by_number.get(number)
        new = standing_by_number.get(number)
        if (
            old is not None
            and new is not None
            and old["side_1_points"] == new["side_1_points"]
            and old["side_2_points"] == new["side_2_points"]
        ):
            continue  # unchanged — omit
        # ``old``/``new`` null encode removed/added; both-present is a change.
        entries.append(
            NegotiationDiffEntry(
                game_number=number,
                old=_negotiation_game(old) if old is not None else None,
                new=_negotiation_game(new) if new is not None else None,
            )
        )
    return entries


def _submitted_on_side(match: Match, result: MatchResult, side: MatchSide) -> bool:
    """True iff the result's submitter is a player on ``side``."""
    return any(p.user_id == result.submitted_by_user_id for p in side.players)


def _negotiation(match: Match, current_user_id: uuid.UUID | None) -> MatchNegotiation:
    """Viewer-relative negotiation state for the BFF (#713).

    The viewer's "side" is the side the current user is on; the opponent side is
    the other. A standing proposal submitted by the viewer's own side is
    ``awaiting`` (they consented; it's the opponent's move); one submitted by the
    opponent makes it the viewer's turn — ``review`` if the viewer never
    proposed, ``corrected`` (with a diff vs the viewer's own last proposal) if
    they did. ``final`` once a result is accepted; ``live`` before any result.

    Non-participants / anonymous callers get a neutral spectator mapping
    (``your_turn=False``, no diff/prior)."""
    accepted = accepted_result(match)
    if accepted is not None:
        return MatchNegotiation(
            viewer_state="final",
            your_turn=False,
            standing_result=_negotiation_result(accepted),
            prior_result=None,
            diff=None,
            retirement_deadline=retirement_deadline(match),
        )

    standing = standing_result(match)
    if standing is None:
        return MatchNegotiation(
            viewer_state="live",
            your_turn=False,
            standing_result=None,
            prior_result=None,
            diff=None,
            retirement_deadline=retirement_deadline(match),
        )

    standing_view = _negotiation_result(standing)
    viewer_side = (
        my_side(match, current_user_id) if current_user_id is not None else None
    )
    # Spectators / anonymous: neutral mapping — there is a standing proposal but
    # the viewer has no side, so treat as a read-only "review" view.
    if viewer_side is None:
        return MatchNegotiation(
            viewer_state="review",
            your_turn=False,
            standing_result=standing_view,
            prior_result=None,
            diff=None,
            retirement_deadline=retirement_deadline(match),
        )

    if _submitted_on_side(match, standing, viewer_side):
        # The viewer's own side proposed the standing result; await the opponent.
        return MatchNegotiation(
            viewer_state="awaiting",
            your_turn=False,
            standing_result=standing_view,
            prior_result=None,
            diff=None,
            retirement_deadline=retirement_deadline(match),
        )

    # The opponent submitted the standing result → the viewer must act. Walk the
    # supersede chain back from the standing result to the viewer's own last
    # proposal (the baseline that collapses the opponent's intermediate edits).
    by_id = {r.id: r for r in match.results}
    prior: MatchResult | None = None
    cursor = standing.supersedes_result_id
    while cursor is not None:
        candidate = by_id.get(cursor)
        if candidate is None:
            break
        if _submitted_on_side(match, candidate, viewer_side):
            prior = candidate
            break
        cursor = candidate.supersedes_result_id

    if prior is None:
        return MatchNegotiation(
            viewer_state="review",
            your_turn=True,
            standing_result=standing_view,
            prior_result=None,
            diff=None,
            retirement_deadline=retirement_deadline(match),
        )

    return MatchNegotiation(
        viewer_state="corrected",
        your_turn=True,
        standing_result=standing_view,
        prior_result=_negotiation_result(prior),
        diff=_negotiation_diff(prior.games, standing.games),
        retirement_deadline=retirement_deadline(match),
    )


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
        # scorable (no result posted yet; see ``_is_scorable``), *independent*
        # of whether there's a next un-played game. A decided-but-unposted
        # board is still editable, so this is True while ``current_game`` is
        # None. Spectators get the read-only view — writes
        # 404 for non-participants in the score endpoints regardless.
        can_score=(is_participant and _is_scorable(match)),
        # True iff the saved games already form a decided, validly-ordered
        # match AND no result is currently posted — the FE flips the scoring
        # page's submit button label to "Post result" when this is true.
        can_finalize=(
            is_participant and len(match.sides) >= 2 and _can_finalize(match)
        ),
        # Viewer-relative negotiation state — the standing proposal, whose turn
        # it is, and (when the opponent corrected the viewer's own proposal) the
        # diff. Drives the accept CTA + the negotiation callouts (#713).
        negotiation=_negotiation(match, current_user_id),
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


def _has_result_exists() -> Any:
    """``EXISTS`` correlated subquery: this match has any result row. On an
    ``in_progress`` match the presence of any result means a standing proposal
    exists (acceptance moves the match to ``completed``, so the head of the
    chain is necessarily unaccepted) — making "has a result" the derived
    "Awaiting acceptance" bucket (see ``_status_label``). Pulled into a helper
    so the list filter and the status-count aggregate split the Live vs awaiting
    buckets identically (issue #381)."""
    return select(MatchResult.id).where(MatchResult.match_id == Match.id).exists()


def my_standing_proposal_exists(current_user_id: uuid.UUID) -> Any:
    """``EXISTS`` correlated subquery: ``current_user`` submitted the *standing*
    proposal on this match — the unaccepted result nothing else supersedes.

    On an ``in_progress`` match that means the match is parked *waiting on the
    opponent* to accept: the current user has already signed and owes no move.
    It's the SQL twin of ``list_attention_kind``'s ``waiting_opponent`` bucket.
    Shared by the dashboard's waiting/actionable split and the matches-list
    Attention filter so the two can never disagree about who owes a move.

    Singles-only assumption: this keys on ``submitted_by_user_id ==
    current_user``, whereas ``list_attention_kind`` treats a proposal from *any*
    player on the viewer's side as theirs (``_submitted_on_side``). For
    ``team_size == 1`` (the only topology today — see ``create_match``) the two
    coincide. When doubles lands, a partner's proposal would make this ``False``
    while the classifier says ``waiting_opponent``, so this must move to a
    side-based match to keep the SQL and Python twins aligned."""
    superseding = aliased(MatchResult)
    return (
        select(MatchResult.id)
        .where(
            MatchResult.match_id == Match.id,
            MatchResult.accepted_by_user_id.is_(None),
            MatchResult.submitted_by_user_id == current_user_id,
            ~select(superseding.id)
            .where(superseding.supersedes_result_id == MatchResult.id)
            .exists(),
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
            await db.execute(
                select(User).where(
                    User.id == payload.opponent_user_id,
                    User.merged_into_user_id.is_(None),
                )
            )
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
    ``awaiting_acceptance`` both sit on the ``in_progress`` status but split
    on whether any result has been posted, so neither bucket leaks into the
    other (issue #381). Every other bucket is a plain status match."""
    if filter_ is MatchListFilter.live:
        return query.where(
            Match.status == MatchStatus.in_progress, ~_has_result_exists()
        )
    if filter_ is MatchListFilter.awaiting_acceptance:
        return query.where(
            Match.status == MatchStatus.in_progress, _has_result_exists()
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


# Sort rank for a match that ``list_attention_kind`` can't classify — sits above
# every real ``attention_priority`` (0–5) so a surprise row sinks to the bottom
# rather than crashing the page. Only reachable defensively: the actionable
# filter already excludes everything that would classify as ``None``.
_UNCLASSIFIED_SORT_RANK = 99


def _actionable_attention_filter[SelectT: Select[Any]](
    query: SelectT, current_user_id: uuid.UUID
) -> SelectT:
    """Narrow ``query`` to the caller's matches that need *their own* action —
    the Attention tab's membership, computed per viewer (issue #729).

    Mirrors the actionable half of ``app.attention.list_attention_kind``
    (``review`` / ``score``): an in-progress match where the caller has *not*
    submitted the standing proposal. This deliberately excludes the passive
    waiting buckets — ``waiting_others`` (a pending/scheduled match) and
    ``waiting_opponent`` (the caller's own posted result awaiting the opponent's
    acceptance) — so the tab never flags a match the caller is merely waiting
    on. The poster and the reviewer of the same posted result therefore see
    *different* Attention counts, unlike before."""
    return query.where(
        Match.status == MatchStatus.in_progress,
        ~my_standing_proposal_exists(current_user_id),
    )


def _attention_matches_query(
    q: str | None, current_user_id: uuid.UUID
) -> Select[tuple[Match]]:
    """The caller's own matches that need their action (optionally
    search-narrowed) — the row set behind the Attention tab and its tab-badge
    count. Restricted to participation, unlike the perspective-neutral browsing
    query, and to the *actionable* buckets, unlike a plain open-status scan."""
    base = _actionable_attention_filter(
        participant_filter(select(Match), current_user_id), current_user_id
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
        return (_UNCLASSIFIED_SORT_RANK, match.updated_at)
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
    # awaiting-acceptance bucket is an `in_progress` row with a standing result,
    # so it's counted separately and peeled out of the `in_progress` total — the
    # `in_progress` count then reads as true-live (no posted result), keeping the
    # two buckets disjoint (issue #381).
    counts_query = select(Match.status, func.count(Match.id))
    awaiting_query = select(func.count(Match.id)).where(
        Match.status == MatchStatus.in_progress, _has_result_exists()
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
    # Split the raw in_progress total into true-live + awaiting-acceptance.
    status_counts[MatchStatus.in_progress] -= awaiting_count

    # The list is open to every signed-in user. Writes still gate on
    # `_is_participant` downstream.
    if attention:
        # The Attention set is bounded by the caller's *actionable* open matches
        # (issue #729) — a handful even for an active player — so we load them
        # all, rank by attention priority in Python (no SQL ordering captures the
        # per-user bucketing), and paginate the sorted list. Its length *is* the
        # tab-badge count, so no separate aggregate is needed on this path.
        actionable_matches = (
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
            actionable_matches, key=lambda m: _attention_sort_key(m, current_user.id)
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
        elif status_ is MatchListFilter.awaiting_acceptance:
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
        awaiting_acceptance_count=awaiting_count,
        status_counts=status_counts,
        attention_count=attention_count,
    )


async def _attention_count(
    db: AsyncSession, q: str | None, current_user_id: uuid.UUID
) -> int:
    """Count of the caller's matches that need their action under the active
    search — the Attention tab's badge when a different tab is showing. Uses the
    same actionable filter as the tab's row set so badge and list agree."""
    query = _actionable_attention_filter(
        participant_filter(select(func.count(Match.id)), current_user_id),
        current_user_id,
    )
    if q:
        query = _player_username_filter(query, q)
    return int((await db.execute(query)).scalar_one())


def _list_row(match: Match, current_user_id: uuid.UUID) -> MatchListRow:
    side_wins = side_win_counts(match)
    sides_sorted = sorted(match.sides, key=lambda s: s.side_number)
    next_number = current_game_number(match)
    is_participant = _is_participant(match, current_user_id)
    # Editability follows the no-result scratchpad rule (``_is_scorable``),
    # not whether a next game exists — so a decided-but-unposted row still reads
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
        negotiation=_negotiation(match, current_user_id),
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
    # request.client.host is the true client IP only when FORWARDED_ALLOW_IPS is
    # set at the uvicorn edge (docs/adr/0008-trust-client-ip-at-the-uvicorn-edge.md);
    # otherwise it's the proxy peer and this collapses to one global bucket (#837).
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
# ``disputed`` is a dead status under the propose/accept model (nothing sets it;
# corrections happen in the supersede chain, not by reopening the scratchpad).
# It's omitted here only because the enum value is retained pending its removal
# migration — its terminal classification is settled there. In practice a
# disputed row is unreachable, and would carry a result anyway, so ``_is_scorable``
# (which also gates on "no result exists") already treats it as non-scorable.
_TERMINAL_STATUSES = {
    MatchStatus.completed,
    MatchStatus.voided,
}


def _is_scorable(match: Match) -> bool:
    """Whether a match accepts score writes right now (ignoring who's asking).

    The saved games are a provisional *scratchpad* until somebody posts the
    first result: editable regardless of whether they already decide the match.
    So the only gates are structural — two sides, a non-terminal status, and
    **no result row at all**. The scratchpad freezes the instant the first
    result is proposed (#715); from there the board only changes via the
    propose/accept negotiation, not the score endpoints.

    Single source of truth shared by the write-path guard
    (``_enforce_scorable``) and the BFF ``can_score`` flag, so the flag the
    clients trust can never disagree with what the score endpoints accept."""
    return (
        len(match.sides) >= 2
        and match.status not in _TERMINAL_STATUSES
        and not match.results
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
    # Any posted result freezes the scratchpad (#715); the board now only
    # changes through propose/accept, not the score endpoints.
    if match.results:
        raise HTTPException(
            status_code=409,
            detail="This match has a posted result; scores are frozen.",
        )
    # Terminal status (``completed``/``voided``) — or any future
    # ``_is_scorable`` gate without a message of its own.
    raise HTTPException(status_code=409, detail="This match is no longer scorable.")


# ----- result-acceptance push ---------------------------------------------

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
    match: Match, poster_id: uuid.UUID, *, is_counter: bool
) -> tuple[str, str] | None:
    """Title + body for the "accept or suggest a correction to the result your
    opponent posted" push, framed for the *recipient* (the side that didn't
    post).

    ``is_counter`` picks the closing prompt to match the actual button pair
    the recipient's in-app callout renders: a first-post shows Accept /
    Suggest correction (``confirmation-callout-display.tsx``'s ``"review"``
    case), while a counter shows Accept / Counter (its ``"corrected"`` case,
    #728). The native iOS push notification itself only ever offers a single,
    static Approve/Suggest-correction action pair (``PushNotificationManager
    .swift``) — it doesn't yet grow a counter-specific action — so this body
    text is the only place a tapped-through counter reads "Counter" until the
    push actions themselves are split the same way.

    The headline carries the games-won score and, where there's room, the
    body lists the individual game scores — both oriented so the poster's
    number comes first. Returns ``None`` when the match isn't a two-human
    match (nothing to accept)."""
    poster_side = my_side(match, poster_id)
    recipient_side = opponent_side(match, poster_id)
    if poster_side is None or recipient_side is None or not poster_side.players:
        return None

    poster_name = poster_side.players[0].user.username
    wins = side_win_counts(match)
    poster_games = wins.get(poster_side.side_number, 0)
    recipient_games = wins.get(recipient_side.side_number, 0)

    # Score always reads winner-first; the phrase tells the recipient which
    # side the poster claims won.
    if poster_games >= recipient_games:
        phrase, hi, lo = "beating you", poster_games, recipient_games
    else:
        phrase, hi, lo = "losing to you", recipient_games, poster_games
    headline = f"{poster_name} reported {phrase} {hi}{_SCORE_DASH}{lo}"

    prompt = "Accept or counter?" if is_counter else "Accept or suggest a correction?"
    games = _game_scores_text(match, poster_side.side_number)
    body = f"{headline}. Games: {games}. {prompt}" if games else f"{headline}. {prompt}"
    return "Accept your match result", body


async def _notify_result_posted(
    notifications: NotificationService, match: Match, poster_id: uuid.UUID
) -> None:
    """Queue an accept/counter (or accept/suggest-correction) prompt to every
    player on the side that now owes a response. Each enqueued job persists
    the in-app record (the bell feed) and fans out push/email per the
    recipient's preferences in the worker. The APNs ``category``/``data``
    carry the action group, the match id (so a tapped push deep-links to the
    right match), and the standing result id (so a tapped Approve binds to the
    exact result the push described, not whatever is standing at tap time — see
    docs/adr/0007), plus a per-match ``collapse_id`` so a superseding push
    replaces the stale one on the lock screen."""
    recipient_side = opponent_side(match, poster_id)
    if recipient_side is None or not recipient_side.players:
        return
    # Derive counter-vs-first-post from the same viewer-relative negotiation
    # state the BFF/UI use (``_negotiation``'s ``"corrected"`` vs ``"review"``),
    # rather than the raw ``supersedes_result_id is not None`` check — that
    # naive check is wrong on a self-edit (poster corrects their own standing
    # proposal before the recipient ever answers): it supersedes a result, but
    # the recipient still lands on the first-post "review" view, not
    # "corrected", so they must get the Accept/Suggest-correction prompt, not
    # Accept/Counter.
    is_counter = (
        _negotiation(match, recipient_side.players[0].user_id).viewer_state
        == "corrected"
    )
    copy = _result_confirmation_copy(match, poster_id, is_counter=is_counter)
    if copy is None:
        return
    title, body = copy
    result = standing_result(match)
    push_data = {"match_id": str(match.id)}
    if result is not None:
        push_data["result_id"] = str(result.id)
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
                push_data=push_data,
                collapse_id=f"result-confirm:{match.id}",
            )
        )


async def _load_rating_changes(
    db: AsyncSession, match: Match
) -> dict[uuid.UUID, RatingChange]:
    """Returns ``user_id -> RatingChange`` for every rating row this match
    produced. Empty for matches that didn't move ratings — including, always,
    a non-completed match, since no rating rows can exist before completion."""
    if match.status != MatchStatus.completed:
        return {}
    rows = (
        (
            await db.execute(
                select(RatingHistory).where(RatingHistory.match_id == match.id)
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
            db, user_id, match.created_at
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
    # ``rows`` is DESC, so ``rows[0]`` is already the most-recent value; the
    # history list is the chronological (ASC) reversal.
    return rows[0], list(reversed(rows))


async def _load_career_before(
    db: AsyncSession,
    user_id: uuid.UUID,
    before: datetime,
) -> tuple[int, int]:
    """Cross-league ``(matches, wins)`` completed strictly before ``before``
    (the current match's ``created_at``). The current match is excluded by the
    date filter alone: a completed match's ``completed_at`` is always ``>=`` its
    own ``created_at``, so it can never satisfy ``completed_at < created_at``. No
    separate ``id`` guard is needed (issue #202)."""
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
    # MatchSide.won so a future void that leaves `won` null naturally
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
        rating_changes=await _load_rating_changes(db, match),
        recent_form=await _load_recent_form(db, user_ids, match),
        head_to_head=await _load_head_to_head(
            db, user_ids if len(user_ids) == 2 else [], match
        ),
    )


# ----- finalize-payload validation + apply --------------------------------


def _first_decider(
    games: list[MatchResultsGameWrite], target: int
) -> tuple[int, int] | None:
    """Walk ``games`` in game-number order tallying wins; return
    ``(decided_side, decided_game_number)`` for the first game at which a side
    reaches ``target`` wins, else ``None``.

    Gap-tolerant: it does not care whether the numbers are contiguous — callers
    that require ``1..N`` numbering check that separately. The single source of
    truth for "who clinched, and when" shared by the finalize validator and the
    scratchpad overrun guard, so the two can never drift."""
    wins: dict[int, int] = {1: 0, 2: 0}
    for g in sorted(games, key=lambda g: g.game_number):
        winner = 1 if g.side_1_points > g.side_2_points else 2
        wins[winner] += 1
        if wins[winner] >= target:
            return winner, g.game_number
    return None


def _overrun_decider(games: list[MatchResultsGameWrite], best_of: int) -> int | None:
    """The game number at which the match was already decided when there are
    scored games numbered *after* it ("overrun"). Returns ``None`` for empty,
    still-undecided, or exactly-decided-at-the-last-game boards — all legal
    scratchpad states.

    Gap-tolerant on purpose: it shares the decider core with the finalize
    validator but does **not** require ``1..N`` contiguity, so legitimate
    out-of-order / gappy entry (e.g. scoring game 3 first) is allowed right up
    until a side actually clinches *before* the highest-numbered scored game.
    That is the impossible state — games can't have been played after the match
    was already won — so the scratchpad write path rejects it."""
    if not games:
        return None
    decider = _first_decider(games, _games_to_win(best_of))
    if decider is None:
        return None
    _, decided_at = decider
    if decided_at < max(g.game_number for g in games):
        return decided_at
    return None


def _enforce_no_overrun(
    games: list[MatchResultsGameWrite], best_of: int, game_number: int
) -> None:
    """Reject a scratchpad write (422) when the prospective board ``games`` would
    leave the match decided before its last scored game. Shared by both
    score-write paths so the check, status, and message can't drift; each caller
    builds its own prospective board (the create path mutates the ORM then reads
    it back, the update path substitutes the payload because its write is raw
    SQL), then hands it here."""
    decided_at = _overrun_decider(games, best_of)
    if decided_at is not None:
        raise HTTPException(
            status_code=422,
            detail=(
                f"The match was already decided at game {decided_at}; "
                f"game {game_number} can't be played."
            ),
        )


def _compact_games(
    games: list[MatchResultsGameWrite],
) -> list[MatchResultsGameWrite]:
    """Normalize a (possibly gappy) scratchpad board into a canonical one:
    close empty slots so the surviving scored games are numbered ``1..N`` with
    no holes. Pure — returns fresh models, doesn't mutate input.

    Renumbers by the *rank of each distinct* ``game_number`` (not by list
    position), so a genuine duplicate game_number is preserved as a duplicate
    (two games at original ``1`` both map to new ``1``) and the strict
    ``_validate_finalize_games`` duplicate check downstream still rejects it.
    (Renumbering *does* absorb an out-of-``best_of``-range game_number — e.g.
    ``[1,2,5]`` on best-of-3 → ``[1,2,3]`` — but the real scratchpad never
    produces one: the score endpoints reject ``game_number > best_of`` before a
    score is ever saved, and a finalize payload's out-of-range numbers only
    reach here via a hand-crafted API call, where relabeling three legal scored
    games into a legal 3-game board is harmless.)

    Provably outcome-invariant: an empty (unscored) slot contributes 0 wins to
    either side, so dropping it and relabeling can never change the winner or
    the game score — only the cosmetic slot numbers. It heals the out-of-order
    clinch (score game 5 while game 4 is blank → ``[1,2,3,5]`` compacts to
    ``[1,2,3,4]`` and finalizes) without touching a real overrun (a fully-scored
    ``[1,2,3,4,5]`` compacts to itself and stays rejected).
    See ``docs/adr/0002-decided-board-is-compacted-at-propose.md``."""
    rank = {
        original: compacted
        for compacted, original in enumerate(
            sorted({g.game_number for g in games}), start=1
        )
    }
    return [
        MatchResultsGameWrite(
            game_number=rank[g.game_number],
            side_1_points=g.side_1_points,
            side_2_points=g.side_2_points,
        )
        for g in sorted(games, key=lambda g: g.game_number)
    ]


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
    decider = _first_decider(games, target)
    if decider is None:
        raise ValueError(
            f"No side reached {target} game wins — the match isn't decided."
        )
    decided_side, decided_at = decider
    if decided_at != max(numbers):
        raise ValueError(
            "Scored games extend past the deciding game; "
            "drop any games after the decider."
        )
    return decided_side


def _games_payload_from_match(match: Match) -> list[MatchResultsGameWrite]:
    """Recast currently-saved scores as a finalize payload, so ``_can_finalize``
    can reuse ``_validate_finalize_games`` instead of duplicating its rules.

    Returns the board **raw** (scored games at their real ``game_number``, gaps
    and all). The two scratchpad overrun guards depend on this: ``create_game_score``
    reports the tapped game in its 422 detail, and ``update_game_score`` substitutes
    the edited game by matching the raw ``game_number`` — both would break on a
    renumbered board. Compaction is applied by ``_can_finalize`` alone, at its own
    call site, since only the finalize predicate wants a canonical board."""
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

    Returns False once any result exists — the FE drives this flag only for the
    FIRST proposal; subsequent counters/acceptances flow through the negotiation
    surface, not /results-as-finalize.

    Compacts the saved board before validating, mirroring the write path: a
    gappy-but-decided board (an out-of-order clinch that left a hole) reports
    ``can_finalize = true`` so the finalize-callout / SaveBanner offers "Post
    result" and the user self-heals with one tap — this also heals already-stuck
    matches with no migration."""
    if match.status not in (MatchStatus.in_progress, MatchStatus.disputed):
        return False
    if match.results:
        return False
    try:
        _validate_finalize_games(
            _compact_games(_games_payload_from_match(match)),
            match.match_settings.best_of,
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
    (solo/unrated: immediately at /results) or awaiting acceptance (rated),
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


def _requires_confirmation(match: Match) -> bool:
    """Only rated matches go through the accept round-trip. Acceptance
    exists to protect ratings from one-sided claims; an unrated match has no
    stakes worth a second party's consent, and a solo match has no second
    human to accept anyway (rated already implies a registered opponent at
    creation — the player check is defensive)."""
    return match.match_settings.affects_rating and _all_sides_have_players(match)


# ----- scoring endpoints ---------------------------------------------------


class MatchLockUnavailable(Exception):
    """``SELECT ... FOR UPDATE NOWAIT`` found the match row already locked by a
    concurrent negotiation transaction. Raised by ``_lock_match_row(nowait=True)``
    so the caller can translate it into a fast, clean 409 instead of blocking
    on the lock (see ``post_match_result``)."""


# Postgres SQLSTATE for a ``NOWAIT`` lock that could not be acquired.
_LOCK_NOT_AVAILABLE = "55P03"


async def _lock_match_row(
    db: AsyncSession, match_id: uuid.UUID, *, nowait: bool = False
) -> None:
    """Take a transaction-scoped row lock on the ``matches`` row so the
    negotiation transitions (``/results`` propose, ``/results/{id}/acceptance``)
    serialize against each other.

    Without this, a participant firing two acceptances (or a propose racing an
    acceptance) concurrently lets both transactions pass their standing-result
    guard on the same pre-image and both commit — finalizing the match twice and
    applying a rating change more than once (issue #365). The lock forces the
    second transaction to wait for the first to commit and then re-read the
    post-image, so its guard returns a clean 409.

    It's a thin ``SELECT matches.id ... FOR UPDATE`` rather than adding
    ``.with_for_update()`` to the eager ``_load_match`` query: a narrow
    lock-only select is cheaper than re-running ``match_eager_options`` (which
    fans out into a selectinload query per relationship) just to take the lock,
    and acquiring it on its own line makes the lock-then-read ordering explicit
    — the subsequent load sees the serialized state. Locking just the parent
    row is enough — every negotiation transition reads and writes that match's
    children under cover of this lock.

    ``nowait=True`` adds ``NOWAIT``: if the row is already locked, Postgres
    raises immediately instead of blocking, which we surface as
    ``MatchLockUnavailable``. ``post_match_result`` uses this so a double-tapped
    finalize doesn't park a request (and its pooled DB connection) on the lock
    for the full duration of the in-flight post — the pile-up that wedged the
    whole instance under a stray double-click (issue #641). The blocking form
    is kept for /results/{id}/acceptance, where a second concurrent caller is a
    *legitimate* acceptor that must wait, re-read, and proceed."""
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
    # ``lock`` callers (the negotiation transitions) take the row lock *before*
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

    # The board can't have games after the match was already decided. The ORM
    # is mutated above, so ``_games_payload_from_match`` already reflects this
    # write; reject before commit (request teardown rolls back the uncommitted
    # session). Gap-tolerant — only a clinch *before* the last scored game trips.
    _enforce_no_overrun(
        _games_payload_from_match(match), match.match_settings.best_of, game_number
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

    # Editing a game's winner can move the decider earlier, so the same
    # "no games past the decider" guard the create path enforces applies here.
    # The UPDATE below runs in raw SQL, so in-memory ``match.games`` still holds
    # the OLD score — build the prospective board by substituting the payload
    # points for this game before checking.
    prospective = [
        g
        if g.game_number != game_number
        else MatchResultsGameWrite(
            game_number=game_number,
            side_1_points=payload.side_1_points,
            side_2_points=payload.side_2_points,
        )
        for g in _games_payload_from_match(match)
    ]
    _enforce_no_overrun(prospective, match.match_settings.best_of, game_number)

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


def _negotiation_conflict(match: Match, current_user_id: uuid.UUID) -> HTTPException:
    """A 409 whose body carries the viewer-relative negotiation state, so a
    client that lost a propose/accept race can re-render from the conflict
    response without an extra round-trip. The standing proposal has moved on
    (a concurrent counter superseded the one the caller targeted, or a first
    result already exists); the FE reconciles against this snapshot."""
    return HTTPException(
        status_code=409,
        detail=_negotiation(match, current_user_id).model_dump(mode="json"),
    )


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
    """Propose a result for a match — the first verb of the propose/accept
    negotiation.

    A first proposal (``supersedes_result_id`` omitted) requires that no result
    exists yet. A counter (``supersedes_result_id`` set) must target the current
    standing proposal — it mints a superseding ``MatchResult`` carrying an
    immutable snapshot of the claimed board, keeping the chain linear. Either way
    the proposed board (validated as complete + decided) becomes the canonical
    ``match_games`` snapshot.

    Solo / unrated matches (no second party whose acceptance is worth waiting on)
    self-accept and finalize immediately — ``side.won`` and the rating update
    fire here. Rated two-human matches leave the result *standing* (unaccepted)
    for the opposing side to accept via
    ``POST /results/{result_id}/acceptance``."""
    try:
        match = await _load_match_for_scoring(
            db, match_id, current_user.id, lock=True, nowait=True
        )
    except MatchLockUnavailable as exc:
        # A concurrent propose is mid-flight (a double-tapped submit). Bail out
        # fast with a 409 rather than blocking on the lock and tying up a
        # connection for the duration of the in-flight post (issue #641). The
        # winner's 201 carries the canonical result; the client refetches it.
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="A result is already being posted for this match. "
            "Refresh to see the latest.",
        ) from exc

    # A terminal match (completed/voided) is closed to new proposals. A completed
    # match has an accepted head, so the result-existence gates below would 409 a
    # first-post against it anyway; but a match voided *before* any result was
    # posted has no results to gate on — so guard the status explicitly here, or a
    # first-post would silently un-void it.
    if match.status in _TERMINAL_STATUSES:
        raise HTTPException(
            status_code=409, detail="This match is no longer open to results."
        )

    # NOTE: no ``_enforce_scorable`` here. The scratchpad-scorable guard is now
    # false the instant any result exists (#715), so a counter — which by design
    # supersedes an existing result — would 409 before it could supersede.
    # Propose has its OWN gates below (first-post vs counter) instead.

    # Compact once, upstream of every consumer below (_validate_finalize_games,
    # _commit_canonical_games, and the immutable _result_games_snapshot), so the
    # minted board is contiguous (see `_compact_games`). Covers both the first
    # proposal and the counter — they share this endpoint.
    payload = payload.model_copy(update={"games": _compact_games(payload.games)})

    # Decided-board hard gate — the strict precondition: an undecided board can't
    # be a result.
    try:
        decided_side = _validate_finalize_games(
            payload.games, match.match_settings.best_of
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if payload.supersedes_result_id is None:
        # First proposal: only valid when no result exists yet. A concurrent
        # first-post (or any existing chain) loses here with the current state.
        if match.results:
            raise _negotiation_conflict(match, current_user.id)
    else:
        # Counter: must target the live standing proposal. If it was already
        # accepted or superseded by a concurrent counter, the id won't match —
        # 409 with the moved-on state.
        standing = standing_result(match)
        if standing is None or payload.supersedes_result_id != standing.id:
            raise _negotiation_conflict(match, current_user.id)

    # Sync the canonical ``match_games`` to the proposed board so the scoreboard
    # ``games``/``can_score`` rendering stays correct. After the first post the
    # scratchpad is frozen, so ``match_games`` stays == the standing snapshot.
    await _commit_canonical_games(db, match, payload)

    result = MatchResult(
        submitted_by_user_id=current_user.id,
        games=_result_games_snapshot(payload),
        supersedes_result_id=payload.supersedes_result_id,
    )
    match.results.append(result)

    # Drives the post-commit push: only a rated two-human match leaves the other
    # side owing an acceptance. Computed before commit; the recipient gets pinged
    # once the result is durably saved.
    awaiting_acceptance = _requires_confirmation(match)
    if not awaiting_acceptance:
        # Solo / unrated path: no second acceptance needed — the proposer
        # self-accepts and the match finalizes immediately (stamping
        # ``completed_at``). A solo match has no second human to accept, so the
        # proposer's own id is recorded as the acceptor.
        result.accepted_by_user_id = current_user.id
        result.accepted_at = datetime.now(UTC)
        match.mark_completed()
        _set_side_won(match, decided_side)
        await _apply_rating_update(db, match)
    else:
        # Rated path: the result stays standing (unaccepted) and ``side.won``
        # stays unset until the opposing side accepts. Status is (re)set to
        # in_progress.
        match.status = MatchStatus.in_progress

    try:
        await db.commit()
    except IntegrityError as exc:
        # ``uq_match_results_supersedes_result_id``: two concurrent counters
        # raced to supersede the same parent and the other one won. Reload and
        # surface the moved-on negotiation state.
        await db.rollback()
        reloaded = await _load_match(db, match_id)
        if reloaded is None:
            raise HTTPException(status_code=404, detail="Match not found.") from exc
        raise _negotiation_conflict(reloaded, current_user.id) from exc

    reloaded = await _load_match(db, match.id)
    assert reloaded is not None
    extras = await _load_view_extras(db, reloaded)
    details = _serialize_details(reloaded, current_user.id, extras)
    # Record + notify the side that now owes an acceptance. Built after the
    # response and best-effort: the result is already committed, so *nothing*
    # here may turn the 201 into a 500 — not a DB error, and not a delivery-side
    # failure (e.g. a malformed APNs key making jwt.encode raise). Hence the
    # blanket catch, mirroring the fire-and-forget enqueue guards in
    # app.sessions. The session is rolled back so the request's teardown is
    # clean even when the failure was the in-app persist commit.
    if awaiting_acceptance:
        try:
            await _notify_result_posted(notifications, reloaded, current_user.id)
        except Exception:
            await db.rollback()
            log.exception(
                "Failed to record result-acceptance notification",
                extra={"match_id": str(match.id)},
            )
    return details


@router.post(
    "/matches/{match_id}/results/{result_id}/acceptance",
    response_model=MatchDetails,
    status_code=status.HTTP_201_CREATED,
)
async def accept_match_result(
    match_id: uuid.UUID,
    result_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchDetails:
    """Accept a standing proposal — the second verb of the negotiation. The
    opposing side ratifies the proposing side's board; the match completes,
    ``side.won`` is stamped from the agreed games, and the rating update runs.

    ``result_id`` is the concurrency token: it must equal the current standing
    proposal's id. If the proposal was superseded by a counter, already accepted,
    or there's no standing proposal, the caller gets a 409 carrying the moved-on
    negotiation state (or a 404 if no result with that id exists on the match).
    The proposing side already consented by proposing, so only a participant on
    the *opposing* side may accept."""
    match = await _load_match_for_scoring(db, match_id, current_user.id, lock=True)

    # The path ``result_id`` must exist on this match at all (404); the live
    # standing-proposal check (409 with the moved-on state) is owned by
    # ``accept_standing_result`` so it runs identically from a worker.
    if not any(r.id == result_id for r in match.results):
        raise HTTPException(status_code=404, detail="Result not found.")

    # The proposing side already consented by proposing; only the opposing side
    # accepts. A participant on the submitter's side (in singles, the submitter
    # themselves) can't accept their own proposal. Only meaningful while the
    # targeted result is still standing — a superseded/absent one falls through
    # to the core's conflict signal below.
    standing = standing_result(match)
    if standing is not None and standing.id == result_id:
        submitter_side = my_side(match, standing.submitted_by_user_id)
        if submitter_side is not None and any(
            p.user_id == current_user.id for p in submitter_side.players
        ):
            raise HTTPException(
                status_code=409, detail="You can't accept your own proposal."
            )

    try:
        await accept_standing_result(
            db,
            match,
            result_id=result_id,
            accepted_by_user_id=current_user.id,
        )
    except StandingResultConflictError:
        raise _negotiation_conflict(match, current_user.id) from None
    except PostedGamesNotDecisiveError:
        raise HTTPException(
            status_code=409, detail="The posted games no longer decide this match."
        ) from None

    await db.commit()

    reloaded = await _load_match(db, match.id)
    assert reloaded is not None
    extras = await _load_view_extras(db, reloaded)
    return _serialize_details(reloaded, current_user.id, extras)
