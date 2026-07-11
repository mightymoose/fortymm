import uuid
from collections.abc import Iterable, Mapping
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import Select, and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, selectinload
from sqlalchemy.sql.base import ExecutableOption

from app.db import get_session
from app.leagues import resolve_league
from app.models import (
    Match,
    MatchGame,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    User,
    UserLeagueRating,
)
from app.schemas.player import (
    PlayerDetail,
    PlayerListResponse,
    PlayerMatchGame,
    PlayerMatchListResponse,
    PlayerMatchOpponent,
    PlayerMatchRow,
    PlayerRead,
    PlayerSummary,
)
from app.schemas.rating import RatingChange
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")

# Sizes for the two opponent-picker endpoints. The recent grid shows six
# chips; the typeahead caps its dropdown well below the full roster.
RECENT_DEFAULT_LIMIT = 6
SEARCH_DEFAULT_LIMIT = 10
MAX_LIMIT = 50

# Pagination caps for the `/players` list + per-player matches endpoint.
# Mirrors `MAX_PAGE_SIZE` in matches.py so the two list surfaces feel the
# same.
LIST_DEFAULT_PAGE_SIZE = 25
LIST_MAX_PAGE_SIZE = 100

# How many recent W/L results to surface as the "form" string on
# PlayerSummary. Matches the FE's FormDots component (5 chips).
FORM_WINDOW = 5

# How many matches the profile bundle embeds. The profile is an *overview*: it
# renders a "Recent matches" card of the last six and links to the full
# paginated history at its own route (ADR-0915), which is served by
# `/v1/players/{id}/matches` — that endpoint keeps its 25-per-page default.
PROFILE_RECENT_MATCHES = 6


def _serialize(
    users: Iterable[User],
    ratings: Mapping[uuid.UUID, float | None] | None = None,
) -> list[PlayerRead]:
    ratings = ratings or {}
    return [
        PlayerRead(id=user.id, username=user.username, rating=ratings.get(user.id))
        for user in users
    ]


async def _load_player_ratings(
    db: AsyncSession, league_id: uuid.UUID, user_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, float | None]:
    ids = list(user_ids)
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(UserLeagueRating.user_id, UserLeagueRating.rating_value).where(
                UserLeagueRating.league_id == league_id,
                UserLeagueRating.user_id.in_(ids),
            )
        )
    ).all()
    return {user_id: rating for user_id, rating in rows}


async def _load_player_ranks(
    db: AsyncSession, league_id: uuid.UUID, user_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """One round trip: returns ``user_id -> rank`` for the requested users.

    ``rank`` is a player's GLOBAL position on the league's rating ladder by
    STANDARD COMPETITION RANKING — ``rank = 1 + (# of players rated strictly
    higher)``, so equal ratings share a rank and the next rank skips
    (…, 7, 7, 9, …), exactly what SQL ``RANK()`` computes.

    The window is evaluated over the ENTIRE non-merged, rated league population
    and only THEN filtered to ``user_ids`` — never over ``user_ids`` alone — so
    a player's rank is a global fact, invariant under the roster's search or
    pagination (the #841 regression). Tombstoned (merged-away) users are
    excluded from the population so a ghost never inflates a real rank.

    Users with no rating in the league are absent from the result (so
    ``.get()`` yields ``None``): no rating, no rank.
    """
    ids = list(user_ids)
    if not ids:
        return {}
    ranked = (
        select(
            UserLeagueRating.user_id.label("user_id"),
            func.rank()
            .over(order_by=UserLeagueRating.rating_value.desc())
            .label("rank"),
        )
        .join(User, User.id == UserLeagueRating.user_id)
        .where(
            UserLeagueRating.league_id == league_id,
            User.merged_into_user_id.is_(None),
            UserLeagueRating.rating_value.is_not(None),
        )
    ).subquery()

    rows = (
        await db.execute(
            select(ranked.c.user_id, ranked.c.rank).where(ranked.c.user_id.in_(ids))
        )
    ).all()
    return {user_id: int(rank) for user_id, rank in rows}


def escape_like(term: str) -> str:
    """Escape LIKE wildcards so a query of ``%`` matches a literal percent
    sign rather than every username."""
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("/players/recent", response_model=list[PlayerRead])
async def list_recent_opponents(
    limit: int = Query(RECENT_DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    league_id: uuid.UUID | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[PlayerRead]:
    """Opponents the caller has actually played, for the new-match picker.

    Ranked by how recently the caller last played them (most recent first),
    tie-broken alphabetically. Returns only real opponents — a caller with no
    match history gets an empty list, so the picker never presents strangers as
    "recent opponents" (#167).
    """
    # Join the caller's side and the opponent's side of each shared match so
    # the database returns hydrated User rows already ordered by recency —
    # one round trip, no Python re-sort.
    opp = aliased(MatchSidePlayer)
    mine = aliased(MatchSidePlayer)
    opponents = (
        (
            await db.execute(
                select(User)
                .join(opp, opp.user_id == User.id)
                .join(Match, Match.id == opp.match_id)
                .join(
                    mine,
                    and_(
                        mine.match_id == opp.match_id,
                        mine.user_id == current_user.id,
                    ),
                )
                .where(
                    User.id != current_user.id,
                    User.merged_into_user_id.is_(None),
                )
                .group_by(User.id)
                # Stable tiebreaker so ties on created_at (seed data, tests,
                # concurrent creates) don't reorder across requests.
                .order_by(func.max(Match.created_at).desc(), User.username)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )

    league = await resolve_league(db, league_id)
    ratings = await _load_player_ratings(db, league.id, (user.id for user in opponents))
    return _serialize(opponents, ratings)


@router.get("/players/search", response_model=list[PlayerRead])
async def search_players(
    q: str = Query(..., description="Username substring to match against."),
    limit: int = Query(SEARCH_DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    league_id: uuid.UUID | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[PlayerRead]:
    """Username substring search backing the opponent typeahead.

    Case-insensitive, excludes the caller, and caps the result count so the
    client never has to fetch and filter the whole roster. An empty query
    matches nothing.
    """
    term = q.strip()
    if not term:
        return []

    pattern = f"%{escape_like(term)}%"
    result = await db.execute(
        select(User)
        .where(
            User.id != current_user.id,
            # Exclude tombstoned (merged-away) guests so ghosts never surface.
            User.merged_into_user_id.is_(None),
            User.username.ilike(pattern, escape="\\"),
        )
        .order_by(User.username)
        .limit(limit)
    )
    users = result.scalars().all()
    league = await resolve_league(db, league_id)
    ratings = await _load_player_ratings(db, league.id, (user.id for user in users))
    return _serialize(users, ratings)


# ---------------------------------------------------------------------------
# /players list + per-player profile + per-player matches
#
# BFF endpoints — each returns exactly what its consumer page needs (rating,
# W-L, form, per-set scores), so the FE doesn't join sides + games + flip
# perspective. See `web-client/CLAUDE.md` BFF section.
# ---------------------------------------------------------------------------


def _username_substring_filter[SelectT: Select[Any]](query: SelectT, q: str) -> SelectT:
    """Restrict a User-rooted query to rows whose ``username`` matches the
    substring ``q`` (case-insensitive, LIKE-escaped). Generic over the
    select shape so the same helper works for the page query (returns User)
    and the count query (returns int)."""
    pattern = f"%{escape_like(q.strip())}%"
    return query.where(User.username.ilike(pattern, escape="\\"))


async def _load_wl_counts(
    db: AsyncSession, user_ids: list[uuid.UUID]
) -> dict[uuid.UUID, tuple[int, int]]:
    """One round trip: returns ``user_id -> (wins, losses)`` across all of
    that user's completed matches. Drives the W-L column.

    Explicitly gates on ``Match.status == completed`` even though
    ``MatchSide.won`` is only set non-null today when a match completes —
    so a future void flow that nulls ``won`` doesn't silently
    leak into career W-L. Matches the gate used by ``_load_form``.
    """
    if not user_ids:
        return {}
    rows = (
        await db.execute(
            select(
                MatchSidePlayer.user_id,
                func.count().filter(MatchSide.won.is_(True)).label("wins"),
                func.count().filter(MatchSide.won.is_(False)).label("losses"),
            )
            .join(MatchSide, MatchSide.id == MatchSidePlayer.match_side_id)
            .join(Match, Match.id == MatchSide.match_id)
            .where(
                MatchSidePlayer.user_id.in_(user_ids),
                Match.status == MatchStatus.completed,
            )
            .group_by(MatchSidePlayer.user_id)
        )
    ).all()
    return {row[0]: (int(row[1]), int(row[2])) for row in rows}


async def _load_form(
    db: AsyncSession, user_ids: list[uuid.UUID]
) -> dict[uuid.UUID, str]:
    """One round trip via a window function: returns ``user_id -> "WLWWL"``
    of up to FORM_WINDOW newest-first completed-match outcomes. Drives the
    form-dots column."""
    if not user_ids:
        return {}
    ranked = (
        select(
            MatchSidePlayer.user_id.label("user_id"),
            MatchSide.won.label("won"),
            func.row_number()
            .over(
                partition_by=MatchSidePlayer.user_id,
                # `created_at` (not `updated_at`) so the form-dots column
                # is ordered the same way `list_player_matches` orders the
                # matches table — the top 5 dots match the visible top of
                # the list.
                order_by=Match.created_at.desc(),
            )
            .label("rn"),
        )
        .join(MatchSide, MatchSide.id == MatchSidePlayer.match_side_id)
        .join(Match, Match.id == MatchSide.match_id)
        .where(
            MatchSidePlayer.user_id.in_(user_ids),
            Match.status == MatchStatus.completed,
            MatchSide.won.is_not(None),
        )
    ).subquery()

    rows = (
        await db.execute(
            select(ranked.c.user_id, ranked.c.won)
            .where(ranked.c.rn <= FORM_WINDOW)
            .order_by(ranked.c.user_id, ranked.c.rn)
        )
    ).all()

    form: dict[uuid.UUID, str] = {}
    for user_id, won in rows:
        form.setdefault(user_id, "")
        form[user_id] += "W" if won else "L"
    return form


async def _summarize_players(
    db: AsyncSession, users: list[User], league_id: uuid.UUID
) -> list[PlayerSummary]:
    """Hydrate a list of ``User``s into the ``PlayerSummary`` shape the
    `/players` list + profile-page hero render. Four round trips total
    (ratings, W-L, form, ranks) regardless of page size."""
    if not users:
        return []
    user_ids = [user.id for user in users]
    ratings = await _load_player_ratings(db, league_id, user_ids)
    wl = await _load_wl_counts(db, user_ids)
    form = await _load_form(db, user_ids)
    ranks = await _load_player_ranks(db, league_id, user_ids)
    return [
        PlayerSummary(
            id=user.id,
            username=user.username,
            rating=ratings.get(user.id),
            wins=wl.get(user.id, (0, 0))[0],
            losses=wl.get(user.id, (0, 0))[1],
            form=form.get(user.id, ""),
            rank=ranks.get(user.id),
        )
        for user in users
    ]


@router.get("/players", response_model=PlayerListResponse)
async def list_players(
    q: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=LIST_DEFAULT_PAGE_SIZE, ge=1, le=LIST_MAX_PAGE_SIZE),
    league_id: uuid.UUID | None = Query(default=None),
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> PlayerListResponse:
    """Paginated roster backing the `/players` list page.

    Sorted by default-league rating (highest first), with NULL ratings (i.e.
    players who haven't played a rated match yet) sorted last so the top of
    the list always shows ranked players. Falls back to alphabetic order for
    ties.
    """
    league = await resolve_league(db, league_id)

    base = (
        select(User)
        .where(User.merged_into_user_id.is_(None))
        .outerjoin(
            UserLeagueRating,
            and_(
                UserLeagueRating.user_id == User.id,
                UserLeagueRating.league_id == league.id,
            ),
        )
        .order_by(
            UserLeagueRating.rating_value.desc().nulls_last(),
            User.username,
        )
    )
    if q and q.strip():
        base = _username_substring_filter(base, q)

    # `total` keys the pagination footer + drives the "Showing N-M of T" line.
    # Build the count from the same `q` filter; an unfiltered roster total
    # would mislead users searching for a niche substring.
    count_query: Select[tuple[int]] = (
        select(func.count()).select_from(User).where(User.merged_into_user_id.is_(None))
    )
    if q and q.strip():
        count_query = _username_substring_filter(count_query, q)
    total = (await db.execute(count_query)).scalar_one()

    users = list(
        (await db.execute(base.offset((page - 1) * page_size).limit(page_size)))
        .scalars()
        .all()
    )

    items = await _summarize_players(db, users, league.id)
    return PlayerListResponse(items=items, page=page, page_size=page_size, total=total)


async def _load_player_by_id(db: AsyncSession, player_id: uuid.UUID) -> User | None:
    return (
        await db.execute(
            select(User).where(
                User.id == player_id,
                User.merged_into_user_id.is_(None),
            )
        )
    ).scalar_one_or_none()


async def _summarize_one_player(
    db: AsyncSession, user: User, league_id: uuid.UUID
) -> PlayerSummary:
    summaries = await _summarize_players(db, [user], league_id)
    return summaries[0]


async def _player_detail(
    db: AsyncSession, user: User, league_id: uuid.UUID
) -> PlayerDetail:
    """Body for `/v1/players/{id}` — bundles the hero summary with the player's
    six most recent matches so the profile overview paints in one round trip.

    ``match_total`` is the *all-inclusive* history count that backs the "View
    all N matches" link — the same population the embedded window is drawn from
    (any status, rated or not, solo matches and matches in play included), so it
    is exactly ``matches.total``. It is deliberately larger than the hero's
    ``wins + losses`` whenever a match is undecided; see ADR-0915."""
    summary = await _summarize_one_player(db, user, league_id)
    matches = await _paginated_player_matches(
        db, user.id, page=1, page_size=PROFILE_RECENT_MATCHES
    )
    return PlayerDetail(
        **summary.model_dump(), matches=matches, match_total=matches.total
    )


@router.get("/players/{player_id}", response_model=PlayerDetail)
async def get_player(
    player_id: uuid.UUID,
    league_id: uuid.UUID | None = Query(default=None),
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> PlayerDetail:
    """Authed profile bundle for `/players/$userId` — the overview in one
    response: hero + the six most recent matches + the all-inclusive
    `match_total` behind the "View all N matches" link. The full paginated
    history is served by `/v1/players/{id}/matches`."""
    user = await _load_player_by_id(db, player_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Player not found."
        )
    league = await resolve_league(db, league_id)
    return await _player_detail(db, user, league.id)


def _player_matches_eager() -> tuple[ExecutableOption, ...]:
    """Eager-load sides + side players + per-game scores + settings. Matches
    the structure matches.py uses for its detail view but skips
    league/rating_strategy since the per-player row doesn't render those."""
    return (
        selectinload(Match.sides)
        .selectinload(MatchSide.players)
        .selectinload(MatchSidePlayer.user),
        selectinload(Match.games).selectinload(MatchGame.score),
        # Needed to derive the "Awaiting acceptance" boolean (#364): an
        # ``in_progress`` match with a posted-but-unaccepted result carries
        # a standing ``MatchResult``.
        selectinload(Match.results),
        # ``affects_rating`` gates the row's Δ column: an unrated match moved no
        # rating, so it reports no rating change (not a zero one).
        selectinload(Match.match_settings),
    )


async def _load_match_rating_changes(
    db: AsyncSession,
    player_id: uuid.UUID,
    match_ids: Iterable[uuid.UUID],
) -> dict[uuid.UUID, RatingChange]:
    """One round trip for the whole page: returns ``match_id -> RatingChange``
    for this player's ``rating_history`` rows on the given matches — never one
    query per row.

    Only rated, completed matches have a history row (voiding deletes them), and
    ``(match_id, user_id)`` is unique among non-null ``match_id`` rows, so a
    match maps to at most one change for a player."""
    ids = list(match_ids)
    if not ids:
        return {}
    rows = (
        (
            await db.execute(
                select(RatingHistory).where(
                    RatingHistory.match_id.in_(ids),
                    RatingHistory.user_id == player_id,
                )
            )
        )
        .scalars()
        .all()
    )
    changes: dict[uuid.UUID, RatingChange] = {}
    for row in rows:
        # IN-filtered to non-null match ids, so this narrowing is total.
        if row.match_id is None:
            continue
        changes[row.match_id] = RatingChange.from_history(row)
    return changes


def _serialize_player_match(
    match: Match,
    player_id: uuid.UUID,
    rating_change: RatingChange | None = None,
) -> PlayerMatchRow:
    """Project a hydrated ``Match`` into the player's perspective: games
    ordered + scored from the player's side, opponent flattened, result
    derived from ``MatchSide.won``, and the rating the match moved for this
    player (``None`` unless the match is both decided and rated)."""
    sides_sorted = sorted(match.sides, key=lambda s: s.side_number)
    mine = next(
        (s for s in sides_sorted if any(p.user_id == player_id for p in s.players)),
        None,
    )
    if mine is None:
        # The participant filter on the list query guarantees membership;
        # this branch is a defensive fallback.
        raise HTTPException(
            status_code=500, detail="Match listed without the player on a side."
        )
    opp_side = next(
        (s for s in sides_sorted if s.side_number != mine.side_number), None
    )
    opp_user = (
        opp_side.players[0].user if opp_side is not None and opp_side.players else None
    )
    opponent = PlayerMatchOpponent(
        id=opp_user.id if opp_user else None,
        username=opp_user.username if opp_user else None,
    )

    games_sorted = sorted(match.games, key=lambda g: g.game_number)
    games: list[PlayerMatchGame] = []
    for game in games_sorted:
        if game.score is None:
            continue
        if mine.side_number == 1:
            games.append(
                PlayerMatchGame(
                    mine=game.score.side_1_points,
                    theirs=game.score.side_2_points,
                )
            )
        else:
            games.append(
                PlayerMatchGame(
                    mine=game.score.side_2_points,
                    theirs=game.score.side_1_points,
                )
            )

    # ``mine.won`` is only stamped when a match completes — immediately at
    # /results for solo/unrated matches, at /results/{id}/acceptance for rated
    # ones (issue #485). A rated match awaiting acceptance therefore carries
    # ``result: null`` here: the opponent hasn't accepted the claim, so the
    # profile must not show a W/L yet. The per-game scores stay public.
    result: Literal["W", "L"] | None = None
    if mine.won is True:
        result = "W"
    elif mine.won is False:
        result = "L"

    # A result has been proposed but the opponent hasn't accepted it yet. This
    # mirrors matches.py's ``_status_label`` ("Awaiting acceptance") bucket
    # — computed inline here so players.py doesn't import the matches router's
    # internals (api/CLAUDE.md: routers must not depend on each other). The FE
    # uses this to render a distinct chip instead of the green "LIVE" one a
    # genuinely-live ``in_progress`` match gets (#364).
    awaiting_acceptance = (
        match.status == MatchStatus.in_progress and len(match.results) > 0
    )

    # The Δ column. A match only moved a rating if it is DECIDED (``result`` is
    # set — so pending / in progress / awaiting acceptance / voided rows are all
    # out) *and* RATED. Anything else reports ``None``, which the FE renders as
    # ``—``: a zero here would claim the match was rated and moved nothing.
    decided_and_rated = result is not None and match.match_settings.affects_rating
    moved = rating_change if decided_and_rated else None

    return PlayerMatchRow(
        id=match.id,
        status=match.status,
        created_at=match.created_at,
        opponent=opponent,
        games=games,
        result=result,
        awaiting_acceptance=awaiting_acceptance,
        rating_change=moved,
    )


async def _paginated_player_matches(
    db: AsyncSession,
    player_id: uuid.UUID,
    page: int,
    page_size: int,
) -> PlayerMatchListResponse:
    """Per-player matches list backing `/v1/players/{id}/matches`: list
    shape, newest-first ordering, and the perspective flip onto the
    headline player's side.

    ``total`` is the ALL-INCLUSIVE history count (ADR-0008): every match the
    player is a side of, any status, rated or not, solo "No opponent" matches
    included. No status filter — a match still in play is history too."""
    participant = (
        select(MatchSidePlayer.id)
        .where(
            MatchSidePlayer.match_id == Match.id,
            MatchSidePlayer.user_id == player_id,
        )
        .exists()
    )
    total = (
        await db.execute(select(func.count()).select_from(Match).where(participant))
    ).scalar_one()
    matches = list(
        (
            await db.execute(
                select(Match)
                .where(participant)
                .options(*_player_matches_eager())
                .order_by(Match.created_at.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
        )
        .scalars()
        .all()
    )
    # One rating-history round trip for the whole page, not one per row.
    changes = await _load_match_rating_changes(
        db, player_id, (match.id for match in matches)
    )
    items = [
        _serialize_player_match(match, player_id, changes.get(match.id))
        for match in matches
    ]
    return PlayerMatchListResponse(
        items=items, page=page, page_size=page_size, total=total
    )


@router.get("/players/{player_id}/matches", response_model=PlayerMatchListResponse)
async def list_player_matches(
    player_id: uuid.UUID,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=LIST_DEFAULT_PAGE_SIZE, ge=1, le=LIST_MAX_PAGE_SIZE),
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> PlayerMatchListResponse:
    """Paginated per-player match history backing the full-history route
    (`/players/$userId/matches`), 25 to a page. The profile overview embeds only
    the six most recent inline (`GET /v1/players/{id}`) and links here for the
    rest.

    The history is all-inclusive (ADR-0008): every match the player is a side
    of, any status, rated or not, solo "No opponent" matches included.
    Newest-first by ``created_at``. Games are projected from the player's
    perspective so the FE renders them without flipping sides.
    """
    user = await _load_player_by_id(db, player_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Player not found."
        )
    return await _paginated_player_matches(db, player_id, page, page_size)
