import csv
import io
import logging
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

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
from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.base import ExecutableOption

from app.attention import (
    attention_priority,
    list_attention_kind,
)
from app.db import get_session
from app.mappers.match_extras_mapper import empty_extras
from app.match_creation import create_match as create_match_core
from app.match_errors import (
    CannotAcceptOwnProposalError,
    MatchClosedError,
    MatchNotFoundError,
    MatchNotScorableError,
    NegotiationConflictError,
    OpponentNotFoundError,
    PostedGamesNotDecisiveError,
    RatedNeedsRegisteredOpponentError,
    ResultNotFoundError,
    ScoreConflictError,
    ScoreNotAllowedError,
    SelfMatchError,
    UndecidedBoardError,
)
from app.match_queries import (
    _actionable_attention_filter,
    _attention_matches_query,
    _player_username_filter,
    current_game_number,
    is_tournament_director,
    match_eager_options,
    participant_filter,
)
from app.match_result_notifications import (
    notify_result_accepted,
    notify_result_posted,
)
from app.match_scoring import (
    MatchLockUnavailable,
    enter_game_score,
    load_match_for_write,
)
from app.match_scoring import (
    delete_game_score as delete_game_score_core,
)
from app.match_scoring import (
    update_game_score as update_game_score_core,
)
from app.match_serialization import (
    compact_games,
    director_flag_is_material,
    is_participant,
    is_scorable,
    load_match_eager,
    negotiation,
    serialize_details,
    side_schema,
    status_label,
    view_extras,
    view_extras_if_participant,
)
from app.models import (
    Match,
    MatchResult,
    MatchStatus,
    User,
)
from app.notifications.dependencies import get_notification_service
from app.notifications.service import NotificationService
from app.rate_limiting import RedisRateLimiter
from app.result_acceptance import (
    accept_result,
    side_win_counts,
)

# Re-exported for ``tests/test_ratings.py``, which loads the finalize eager-load
# superset via ``app.matches.match_rating_eager_options`` (the propose/accept
# paths that consume it now live in the services). Redundant alias marks the
# intentional re-export so ruff doesn't flag it as unused.
from app.result_proposal import match_rating_eager_options as match_rating_eager_options
from app.result_proposal import (
    propose_result,
)
from app.schemas.match import (
    MatchCreate,
    MatchDetails,
    MatchDetailsScore,
    MatchDetailsSide,
    MatchGameScoreConflict,
    MatchGameScoreUpdate,
    MatchGameScoreWrite,
    MatchLeague,
    MatchListFilter,
    MatchListResponse,
    MatchListRow,
    MatchResultsWrite,
)
from app.services.dependencies import get_match_service
from app.services.match_service import MatchService
from app.sessions import get_current_user, get_optional_user

# Re-exported for ``tests/test_matches.py``, which unit-tests the compaction
# helper via ``app.matches._compact_games`` (the propose path that consumes it
# now lives in ``app.result_proposal``). The helper is now the public
# ``compact_games``; this module-level alias keeps the test's import line
# resolving (and counts as a use, so ruff doesn't flag the import as unused).
_compact_games = compact_games

router = APIRouter(prefix="/v1")

log = logging.getLogger(__name__)

MAX_PAGE_SIZE = 100


# ----- helpers -------------------------------------------------------------


# One message for every score-write conflict — a concurrent writer (another
# participant, or the tournament's director) already saved this game. Both the
# create path (a second create loses the unique
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


# ----- list helpers --------------------------------------------------------


def _has_result_exists() -> Any:
    """``EXISTS`` correlated subquery: this match has any result row. On an
    ``in_progress`` match the presence of any result means a standing proposal
    exists (acceptance moves the match to ``completed``, so the head of the
    chain is necessarily unaccepted) — making "has a result" the derived
    "Awaiting acceptance" bucket (see ``status_label``). Pulled into a helper
    so the list filter and the status-count aggregate split the Live vs awaiting
    buckets identically (issue #381)."""
    return select(MatchResult.id).where(MatchResult.match_id == Match.id).exists()


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
    # Thin HTTP adapter over the transport-neutral creation service: it raises
    # domain exceptions, which we map back to the exact status + body this
    # endpoint has always produced.
    try:
        created = await create_match_core(
            db,
            creator=current_user,
            opponent_user_id=payload.opponent_user_id,
            league_id=payload.league_id,
            best_of=payload.best_of,
            rated=payload.rated,
        )
    except SelfMatchError as err:
        raise HTTPException(
            status_code=422,
            detail="You cannot start a match against yourself.",
        ) from err
    except OpponentNotFoundError as err:
        raise HTTPException(status_code=404, detail="Opponent not found.") from err
    except RatedNeedsRegisteredOpponentError as err:
        raise HTTPException(
            status_code=422,
            detail="A rated match needs a registered opponent.",
        ) from err
    return serialize_details(created, current_user.id)


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
    # `is_participant` downstream.
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
    viewer_is_participant = is_participant(match, current_user_id)
    # Editability follows the no-result scratchpad rule (``is_scorable``),
    # not whether a next game exists — so a decided-but-unposted row still reads
    # as scorable. ``current_game_number`` stays the next-playable-game
    # deep-link target (None when decided or signed); suppressed for spectators.
    can_score = viewer_is_participant and is_scorable(match)

    return MatchListRow(
        id=match.id,
        status=match.status,
        status_label=status_label(match),
        league=MatchLeague(id=match.league.id, name=match.league.name),
        sides=[side_schema(side, side_wins, current_user_id) for side in sides_sorted],
        best_of=match.match_settings.best_of,
        affects_rating=match.match_settings.affects_rating,
        created_at=match.created_at,
        current_game_number=next_number if viewer_is_participant else None,
        can_score=can_score,
        negotiation=negotiation(match, current_user_id),
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
    scorecard with those flags off. can_score is also true for a signed-in
    caller who is the director of the tournament this match belongs to, even
    when they aren't a participant. Per-IP rate-limited (60/min) so an open URL
    can't be scraped from one source.

    The richer history payload — recent form, head-to-head, and per-side rating
    changes — is *only* loaded for a caller who is a participant on this match
    (see #515). Non-participants (anonymous holders of the share URL or
    signed-in spectators) get the scorecard with those extras empty/null, so a
    public link reveals the result but not the players' rivalry / rating
    metadata.

    The serializer flags whether the current user is on a side; write paths
    below still gate on participation via `get_current_user`."""
    match = await load_match_eager(db, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found.")
    domain_match = await match_service.get_match(match_id)
    if domain_match is None:
        raise HTTPException(status_code=404, detail="Match not found.")
    # Gate the history/rivalry/rating payload on participation. Anonymous and
    # spectator callers never see another player's form or rating trajectory —
    # they get the scorecard with empty extras (see #515).
    viewer_is_participant = current_user is not None and is_participant(
        match, current_user.id
    )
    extras = (
        await view_extras(match_service, match)
        if viewer_is_participant
        else empty_extras()
    )
    # The director read flags are a second, independent widening from the write
    # gate (#1523 constraint 10) — a signed-in, non-participant viewer may still
    # be the tournament's director. Skip the query for an anonymous caller or
    # one who's already a participant (the fast, common-case paths), and for a
    # match where the answer changes nothing —
    # ``director_flag_is_material`` names the two windows where it does: a
    # scorable board (``can_score`` / ``can_finalize``) and a live match with a
    # standing proposal (``negotiation.your_turn``). A completed, voided or
    # pending match throws the answer away, and those are exactly the matches
    # people share links to. Only a signed-in non-participant reading a live,
    # unsettled match pays the extra join.
    viewer_is_director = (
        current_user is not None
        and not viewer_is_participant
        and director_flag_is_material(match)
        and await is_tournament_director(db, match_id, current_user.id)
    )
    return serialize_details(
        match,
        current_user.id if current_user else None,
        extras,
        domain_match,
        viewer_is_director=viewer_is_director,
    )


# ----- scoring endpoints ---------------------------------------------------


async def _load_match_for_scoring(
    db: AsyncSession,
    match_id: uuid.UUID,
    current_user_id: uuid.UUID,
    *,
    lock: bool = False,
    nowait: bool = False,
    options: tuple[ExecutableOption, ...] | None = None,
) -> Match:
    """The HTTP adapter over the FastAPI-free ``load_match_for_write``: it maps
    the service's :class:`MatchNotFoundError` (absent match, or a caller who is
    neither a participant nor the tournament's director) to the endpoints'
    historical ``HTTPException(404, "Match not found.")`` and lets
    :class:`MatchLockUnavailable` propagate so ``post_match_result`` can
    translate a held ``NOWAIT`` lock into its fast 409.

    Both the negotiation transitions (``post_match_result``,
    ``accept_match_result``) and — as the injected load seam — the score handlers
    call this, so it stays the single monkeypatchable load the #835 row-lock race
    tests barrier on."""
    try:
        return await load_match_for_write(
            db,
            match_id,
            current_user_id,
            lock=lock,
            nowait=nowait,
            options=options,
        )
    except MatchNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Match not found.") from exc


# Per-game endpoints are addressed by ``game_number``: a game row may not
# exist yet (the FE deeplinks straight into ``/games/N/scores/new``). The
# create handler lookups-or-inserts the MatchGame; update and delete operate
# on an existing score. All three are pure "save / clear scratchpad state" —
# they never touch match.status, side wins, side.won, or ratings. The single
# canonical commit happens in ``finalize_match`` (now in ``app.result_acceptance``,
# reached via the propose/accept services), not here.


# The FastAPI-free score write path (``app.match_scoring``) raises this closed
# family of domain exceptions; ``_map_score_write_error`` reproduces the exact
# status + body each endpoint produced before the guards moved into the service.
# ``_SCORE_WRITE_ERRORS`` is the ``except`` tuple; the alias types the mapper.
_ScoreWriteError = (
    MatchNotFoundError
    | MatchNotScorableError
    | ScoreNotAllowedError
    | ScoreConflictError
)
_SCORE_WRITE_ERRORS = (
    MatchNotFoundError,
    MatchNotScorableError,
    ScoreNotAllowedError,
    ScoreConflictError,
)


def _map_score_write_error(exc: _ScoreWriteError) -> HTTPException:
    """Adapt a score-write domain exception to its historical HTTP response:
    ``MatchNotFoundError`` → 404 with the carried message (``"Match not found."``
    / ``"Score not found."``), ``MatchNotScorableError`` → its carried 422/409 +
    message, ``ScoreNotAllowedError`` → 422 (best-of range / overrun), and
    ``ScoreConflictError`` → the structured 409 ``MatchGameScoreConflict`` body."""
    if isinstance(exc, MatchNotFoundError):
        return HTTPException(status_code=404, detail=exc.message)
    if isinstance(exc, MatchNotScorableError):
        return HTTPException(status_code=exc.http_status, detail=exc.message)
    if isinstance(exc, ScoreNotAllowedError):
        return HTTPException(status_code=422, detail=str(exc))
    return _score_conflict(exc.committed_score)


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
    match_service: MatchService = Depends(get_match_service),
) -> MatchDetails:
    # The whole write path — the blocking match row lock (serializing against a
    # concurrent first ``post_match_result`` NOWAIT lock, #835/ADR-0009), the
    # scorability / best-of-range / no-overrun guards, and the mutation — is
    # owned by the service. ``load_match=_load_match_for_scoring`` injects the
    # router's monkeypatchable load seam (mapping a missing/foreign match to its
    # 404) so the row-lock race tests still barrier on it.
    try:
        reloaded = await enter_game_score(
            db,
            match_id,
            current_user.id,
            game_number=game_number,
            side_1_points=payload.side_1_points,
            side_2_points=payload.side_2_points,
            load_match=_load_match_for_scoring,
        )
    except _SCORE_WRITE_ERRORS as exc:
        raise _map_score_write_error(exc) from exc

    extras = await view_extras_if_participant(match_service, reloaded, current_user.id)
    return serialize_details(reloaded, current_user.id, extras)


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
    match_service: MatchService = Depends(get_match_service),
) -> MatchDetails:
    # Whole write path owned by the service (blocking row lock, scorability, the
    # score's existence 404, the no-overrun guard on the payload-substituted
    # prospective board, then the optimistic-concurrency UPDATE — #835/ADR-0009).
    # ``load_match=_load_match_for_scoring`` keeps the barrier-patchable load seam.
    try:
        reloaded = await update_game_score_core(
            db,
            match_id,
            current_user.id,
            game_number=game_number,
            side_1_points=payload.side_1_points,
            side_2_points=payload.side_2_points,
            expected_version=payload.expected_version,
            load_match=_load_match_for_scoring,
        )
    except _SCORE_WRITE_ERRORS as exc:
        raise _map_score_write_error(exc) from exc

    extras = await view_extras_if_participant(match_service, reloaded, current_user.id)
    return serialize_details(reloaded, current_user.id, extras)


@router.delete(
    "/matches/{match_id}/games/{game_number}/scores",
    response_model=MatchDetails,
)
async def delete_game_score(
    match_id: uuid.UUID,
    game_number: Annotated[int, Path(ge=1, le=7)],
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
    match_service: MatchService = Depends(get_match_service),
) -> MatchDetails:
    # Whole write path owned by the service (blocking row lock, scorability, the
    # score's existence 404, then the clear — #835/ADR-0009). Two racing clears
    # re-read under the lock, so the loser sees the already-cleared score and
    # 404s. ``load_match=_load_match_for_scoring`` keeps the barrier-patchable
    # load seam.
    try:
        reloaded = await delete_game_score_core(
            db,
            match_id,
            current_user.id,
            game_number=game_number,
            load_match=_load_match_for_scoring,
        )
    except _SCORE_WRITE_ERRORS as exc:
        raise _map_score_write_error(exc) from exc

    extras = await view_extras_if_participant(match_service, reloaded, current_user.id)
    return serialize_details(reloaded, current_user.id, extras)


def _negotiation_conflict(match: Match, current_user_id: uuid.UUID) -> HTTPException:
    """A 409 whose body carries the viewer-relative negotiation state, so a
    client that lost a propose/accept race can re-render from the conflict
    response without an extra round-trip. The standing proposal has moved on
    (a concurrent counter superseded the one the caller targeted, or a first
    result already exists); the FE reconciles against this snapshot."""
    return HTTPException(
        status_code=409,
        detail=negotiation(match, current_user_id).model_dump(mode="json"),
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
    match_service: MatchService = Depends(get_match_service),
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
    fire here — and so does a result submitted by the tournament's director
    (entitled to write on any called match in a tournament they created, even
    as a non-participant): the director's result is authoritative and is never
    left standing for anyone to accept on their behalf, whether it's a first
    proposal or a counter to a player's standing one. Rated two-human matches
    proposed by one of their own participants leave the result *standing*
    (unaccepted) for the opposing side to accept via
    ``POST /results/{result_id}/acceptance``."""
    # The whole propose path — the NOWAIT row lock (serializing against a
    # concurrent transition, #641/#835), the terminal-status gate, board
    # compaction + the decided-board validator, the first-post-vs-counter
    # negotiation gates, the canonical-board commit, the self-accept/finalize
    # (solo/unrated) vs. leave-standing (rated) fork, and the concurrent-counter
    # IntegrityError race — is owned by the service. ``load_match=
    # _load_match_for_scoring`` injects the router's monkeypatchable load seam
    # (mapping a missing/foreign match to its 404) so the row-lock race tests
    # still barrier on it, and a held ``NOWAIT`` lock surfaces as
    # ``MatchLockUnavailable`` below.
    try:
        outcome = await propose_result(
            db,
            match_id,
            current_user.id,
            games=payload.games,
            supersedes_result_id=payload.supersedes_result_id,
            load_match=_load_match_for_scoring,
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
    except MatchClosedError as exc:
        # A terminal match (completed/voided) is closed to new proposals.
        raise HTTPException(
            status_code=409, detail="This match is no longer open to results."
        ) from exc
    except UndecidedBoardError as exc:
        # The strict decided-board precondition failed — an undecided/invalid
        # board can't be a result.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except NegotiationConflictError as exc:
        # The propose lost the negotiation race (a result already exists, the
        # counter targeted a stale standing id, or the unique constraint tripped).
        # The 409 carries the viewer-relative moved-on state from the loaded match.
        raise _negotiation_conflict(exc.match, current_user.id) from exc
    except MatchNotFoundError as exc:
        # The concurrent-counter reload found the match gone — today's 404.
        raise HTTPException(status_code=404, detail="Match not found.") from exc

    reloaded = outcome.match
    extras = await view_extras_if_participant(match_service, reloaded, current_user.id)
    details = serialize_details(reloaded, current_user.id, extras)
    # Record + notify the side that now owes an acceptance. Built after the
    # response and best-effort: the result is already committed, so *nothing*
    # here may turn the 201 into a 500 — not a DB error, and not a delivery-side
    # failure (e.g. a malformed APNs key making jwt.encode raise). Hence the
    # blanket catch, mirroring the fire-and-forget enqueue guards in
    # app.sessions. The session is rolled back so the request's teardown is
    # clean even when the failure was the in-app persist commit.
    if outcome.awaiting_acceptance:
        try:
            await notify_result_posted(notifications, reloaded, current_user.id)
        except Exception:
            await db.rollback()
            log.exception(
                "Failed to record result-acceptance notification",
                extra={"match_id": str(match_id)},
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
    match_service: MatchService = Depends(get_match_service),
    notifications: NotificationService = Depends(get_notification_service),
) -> MatchDetails:
    """Accept a standing proposal — the second verb of the negotiation. The
    opposing side ratifies the proposing side's board; the match completes,
    ``side.won`` is stamped from the agreed games, and the rating update runs.

    ``result_id`` is the concurrency token: it must equal the current standing
    proposal's id. If the proposal was superseded by a counter, already accepted,
    or there's no standing proposal, the caller gets a 409 carrying the moved-on
    negotiation state (or a 404 if no result with that id exists on the match).
    The proposing side already consented by proposing, so only a participant on
    the *opposing* side may accept — with one exception: the tournament's
    director may also accept a player's standing proposal on a match they
    didn't play in, since they share the same authorization gate every write on
    this match goes through (a director never has a "submitter's side" to be
    blocked by). A director's own proposals never reach this endpoint at all —
    they always self-finalize at ``POST /results``."""
    # The whole accept path — the blocking row lock (serializing against a
    # concurrent transition, #365), the result-exists 404 gate, the submitter-side
    # self-accept guard, the live standing-proposal check, ``finalize_match`` (mark
    # completed, stamp ``side.won``, apply ratings, advance any tournament draw),
    # and the commit — is owned by the service. ``load_match=_load_match_for_scoring``
    # injects the router's monkeypatchable load seam (mapping a missing/foreign
    # match to its 404) so the #835 row-lock race tests still barrier on it.
    try:
        reloaded = await accept_result(
            db,
            match_id,
            current_user.id,
            result_id=result_id,
            load_match=_load_match_for_scoring,
        )
    except ResultNotFoundError as exc:
        # The path ``result_id`` isn't a result on this match at all.
        raise HTTPException(status_code=404, detail="Result not found.") from exc
    except CannotAcceptOwnProposalError as exc:
        # A participant on the submitter's side can't accept their own proposal.
        raise HTTPException(
            status_code=409, detail="You can't accept your own proposal."
        ) from exc
    except NegotiationConflictError as exc:
        # The targeted result is no longer the live standing proposal (superseded,
        # already accepted, or none standing). The 409 carries the viewer-relative
        # moved-on state from the loaded match.
        raise _negotiation_conflict(exc.match, current_user.id) from exc
    except PostedGamesNotDecisiveError as exc:
        raise HTTPException(
            status_code=409, detail="The posted games no longer decide this match."
        ) from exc

    extras = await view_extras_if_participant(match_service, reloaded, current_user.id)
    details = serialize_details(reloaded, current_user.id, extras)
    # Close the loop for the poster. The propose side told the *opponent* to
    # review; now that they've accepted, tell the *poster* their result is
    # final — otherwise their inbox stays empty on a completed match. The poster
    # is the accepted result's submitter, never the accepting current user.
    # Built after the response and best-effort — mirrors the propose handler's
    # guard, so a delivery-side failure can never turn the 201 into a 500; the
    # session is rolled back so teardown is clean even when the in-app persist
    # was at fault. Building ``details`` off ``reloaded`` *before* this block is
    # load-bearing: the ``except``'s ``db.rollback()`` expires the identity map,
    # so any serialization after it would lazy-load ``reloaded``'s expired
    # attributes outside the greenlet (``MissingGreenlet`` → the very 500 this
    # guard exists to prevent).
    poster_id = next(
        (r.submitted_by_user_id for r in reloaded.results if r.id == result_id),
        None,
    )
    if poster_id is not None:
        try:
            await notify_result_accepted(notifications, reloaded, poster_id)
        except Exception:
            await db.rollback()
            log.exception(
                "Failed to record result-accepted notification",
                extra={"match_id": str(match_id)},
            )

    return details
