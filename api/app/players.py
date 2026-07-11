import uuid
from collections.abc import Iterable, Mapping
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import Select, and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.career import player_career
from app.db import get_session
from app.head_to_head import player_head_to_head
from app.leagues import player_leagues, resolve_league, resolve_league_or_default
from app.models import (
    Match,
    MatchSidePlayer,
    User,
    UserLeagueRating,
)
from app.player_matches import paginated_player_matches
from app.player_summary import (
    load_player_ratings,
    summarize_one_player,
    summarize_players,
)
from app.ratings.history import player_rating_history
from app.ratings.stats import player_confidence, player_standing
from app.schemas.player import (
    PlayerDetail,
    PlayerListResponse,
    PlayerMatchListResponse,
    PlayerRead,
)
from app.schemas.rating import (
    DEFAULT_RATING_WINDOW,
    RatingHistoryWindow,
    RatingWindow,
)
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
    ratings = await load_player_ratings(db, league.id, (user.id for user in opponents))
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
    ratings = await load_player_ratings(db, league.id, (user.id for user in users))
    return _serialize(users, ratings)


# ---------------------------------------------------------------------------
# /players list + per-player profile + per-player matches
#
# BFF endpoints — each returns exactly what its consumer page needs (rating,
# W-L, form, per-set scores), so the FE doesn't join sides + games + flip
# perspective. See `web-client/CLAUDE.md` BFF section.
#
# The domain work each of them needs lives OUTSIDE this router (api/CLAUDE.md:
# a route parses, calls a query/domain function, and shapes the response): the
# summary hydration in `app.player_summary`, the perspective flip in
# `app.player_matches`, the rating reads in `app.ratings.stats`, and the
# cross-league blocks in `app.career` / `app.head_to_head`.
# ---------------------------------------------------------------------------


def _username_substring_filter[SelectT: Select[Any]](query: SelectT, q: str) -> SelectT:
    """Restrict a User-rooted query to rows whose ``username`` matches the
    substring ``q`` (case-insensitive, LIKE-escaped). Generic over the
    select shape so the same helper works for the page query (returns User)
    and the count query (returns int)."""
    pattern = f"%{escape_like(q.strip())}%"
    return query.where(User.username.ilike(pattern, escape="\\"))


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

    items = await summarize_players(db, users, league.id)
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


async def _player_detail(
    db: AsyncSession,
    user: User,
    league_id: uuid.UUID,
    viewer_id: uuid.UUID,
    window: RatingWindow,
) -> PlayerDetail:
    """Body for `/v1/players/{id}` — bundles the hero summary with the player's
    six most recent matches so the profile overview paints in one round trip.

    ``match_total`` is the *all-inclusive* history count that backs the "View
    all N matches" link — the same population the embedded window is drawn from
    (any status, rated or not, solo matches and matches in play included), so it
    is exactly ``matches.total``. It is deliberately larger than the hero's
    ``wins + losses`` whenever a match is undecided; see ADR-0915.

    THE LEAGUE SPLIT (ADR-0915), stated in one place because every field here
    sits on one side of it or the other:

    * LEAGUE-SCOPED — everything about where this player stands on a *ladder*:
      ``rating`` and ``rank`` (via ``summarize_one_player``), ``form`` (same),
      ``peak`` / ``rank_of`` / ``percentile`` / ``rating_delta`` (via
      ``player_standing``) and ``confidence``. Ask for the same player in two
      leagues and every one of them can differ.
    * CROSS-LEAGUE — ``career``, a fact about the *person*: decided matches, W-L,
      win rate, games-won share, streaks. Passing ``league_id`` into
      ``player_career`` would be the bug, not an improvement. The summary's own
      ``wins``/``losses`` are the same career W-L and are cross-league for the
      same reason. ``matches`` / ``match_total`` are cross-league too: the
      history is all-inclusive (ADR-0008).
    * NEITHER — ``leagues`` is the switcher itself, so it is the same list on
      every request for this player; each row carries that row's OWN rating. The
      client derives which row is selected (falling back to ``is_default``).

    THE VIEWER SPLIT (ADR-0915) is the other axis, and ``head_to_head`` is the
    only field on it: this response now varies by WHO IS ASKING. ``viewer_id`` is
    therefore a real argument and not the ``_current_user`` this endpoint used to
    bind and throw away — the caller's own record against this player is the one
    thing on the page that is about the caller. Everything above is a fact about
    the player alone and is byte-identical for every viewer.

    ``rating_history`` embeds the chart's ``window``-worth of data so first paint
    costs one request; the standalone endpoint below serves the same shape when
    the user flips range. It is league-scoped like the rest of the rating half.
    """
    summary = await summarize_one_player(db, user, league_id)
    matches = await paginated_player_matches(
        db, user.id, page=1, page_size=PROFILE_RECENT_MATCHES
    )
    standing = await player_standing(db, user.id, league_id, summary)
    return PlayerDetail(
        **summary.model_dump(),
        matches=matches,
        match_total=matches.total,
        member_since=user.created_at,
        peak=standing.peak,
        rank_of=standing.rank_of,
        percentile=standing.percentile,
        rating_delta=standing.rating_delta,
        confidence=await player_confidence(db, user.id, league_id),
        career=await player_career(db, user.id),
        leagues=await player_leagues(db, user.id),
        head_to_head=await player_head_to_head(db, user, viewer_id),
        rating_history=await player_rating_history(db, user.id, league_id, window),
    )


@router.get("/players/{player_id}", response_model=PlayerDetail)
async def get_player(
    player_id: uuid.UUID,
    league_id: uuid.UUID | None = Query(default=None),
    window: RatingWindow = Query(default=DEFAULT_RATING_WINDOW, alias="range"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> PlayerDetail:
    """Authed profile bundle for `/players/$userId` — the overview in one
    response: hero + the six most recent matches + the all-inclusive
    `match_total` behind the "View all N matches" link. The full paginated
    history is served by `/v1/players/{id}/matches`.

    `league_id` selects the ladder the RATING HALF of the page is about,
    defaulting to the default league when it is omitted — and also when it names
    a league that does not exist. The league is a LENS on this player, not the
    resource being addressed (ADR-0915): a stale bookmark to a deleted ladder
    degrades to the default one rather than 404ing a player who is perfectly
    fine. `player_id` is the resource, and an unknown one is still a 404.
    Everything about where this player stands follows the league: `rating` and
    `rank` out of `rank_of` (so it reads "#3 of 42", never a naked "#3"), their
    all-time `peak`, the `rating_delta` their most recent rated match moved, their
    recent `form`, a `percentile` (only once the league is large enough for it to
    mean anything), and `confidence`. An unrated player has none of them.

    `confidence` says how settled that rating is on this ladder: a `level`
    (`provisional` / `firming_up` / `settled`), the 95% `interval` around the
    rating ("somewhere between 1551 and 1823"), and the Glicko-2 `deviation` and
    `volatility` behind them. It is `null` — the card does not render — for an
    unrated player, and for one whose rating was supplied externally by a manual
    strategy, which carries no deviation to be confident about.

    `leagues` lists every league this player belongs to with their rating on each
    — the Leagues card, which is the page's league *switcher*. It is the same
    list whichever league was asked for; the client marks the selected row (and
    falls back to the one flagged `is_default` when no `league_id` was named).

    `career` is the exception: it is CROSS-LEAGUE and ignores `league_id`
    entirely. Rating, rank, peak, form and percentile are facts about a *ladder*;
    a player's lifetime record — decided matches, W-L, win rate, games-won share,
    current and best streak — is a fact about the *person* (ADR-0915). Ask for
    the same player in two different leagues and only the rating half changes.
    `career.decided` counts decided matches alone, so it is smaller than
    `match_total` whenever one of their matches is still in play.

    `head_to_head` is VIEWER-AWARE — the one block here that depends on who is
    asking (ADR-0915), so two callers get different bytes for the same profile
    and no cache in front of this endpoint may share them. `versus_viewer` is the
    CALLER's own record against this player, written from the caller's side ("you
    are 1-4 against them", not "they are 4-1 against you"): `null` when the caller
    *is* this player, and present with zero meetings — never `null`, never an
    error — when they have simply never played, which is what a brand-new guest
    always sees. `frequent_opponents` is this player's most-met opponents, read
    from *their* side. A meeting is a *decided* match between two named players,
    rated or not, in any league: a match still in play is not a record, and a solo
    "No opponent" match can never be one.

    `rating_history` is the rating chart's data for the calendar window named by
    `range` (`30d` / `90d` / `1y`, defaulting to `90d`) — the same shape
    `GET /v1/players/{id}/rating-history` returns, embedded so the profile paints
    its chart without a second request. The client seeds that endpoint's cache from
    this block and calls it only when the user changes range (ADR-0915). Note the
    `anchor` inside it is a point from OUTSIDE the window, on purpose."""
    user = await _load_player_by_id(db, player_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Player not found."
        )
    league = await resolve_league_or_default(db, league_id)
    return await _player_detail(db, user, league.id, current_user.id, window)


@router.get("/players/{player_id}/rating-history", response_model=RatingHistoryWindow)
async def get_player_rating_history(
    player_id: uuid.UUID,
    league_id: uuid.UUID | None = Query(default=None),
    window: RatingWindow = Query(default=DEFAULT_RATING_WINDOW, alias="range"),
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> RatingHistoryWindow:
    """The player's rating over a CALENDAR window — the profile's rating chart
    (ADR-0915). `range` is `30d`, `90d` (the default) or `1y`; `league_id` names
    the ladder, defaulting to the default league, because a rating is a fact about
    one ladder and never about a player "in general". As on the profile bundle it
    is a lens and not the resource, so a `league_id` naming no league degrades to
    the default ladder rather than 404ing; an unknown `player_id` is still a 404.

    The chart is drawn from three things:

    * `anchor` — the player's rating **as of the window start**, read from their
      last rating change *at or before* it. It is therefore A POINT FROM OUTSIDE
      THE REQUESTED WINDOW, with an `at` older than the window's left edge, and
      that is deliberate: rating history exists only where matches completed, so
      the window's left edge is almost never a match. Without it, a player whose
      first match in the window landed on day forty would be told their ninety-day
      change was only the movement since day forty. `null` when they held no rating
      at that instant — there is nothing to carry in — and the line then starts at
      the first in-window point.
    * `points` — every rating change inside the window, oldest first. A **voided**
      match is absent, not zeroed: voiding deletes its rating-history rows, so it
      leaves the rating timeline entirely (CONTEXT.md, "Voided match") and the
      chart can change shape retroactively. An EMPTY list is a first-class answer,
      never an error: a rated player with nothing in the last ninety days gets
      their anchor and no points, and the chart draws a flat line at their current
      rating.
    * `change` — the net movement across the window, measured from the `anchor`
      (or, with no anchor, from the first in-window point) to the latest one.
      `null`, never `+0`, for an empty window: nothing was played, so there is no
      delta to report.

    `peak` is the highest point WITHIN THE WINDOW, and is a different number from
    the profile's `peak`, which is the player's all-time high on the ladder. Do not
    read either for the other.
    """
    user = await _load_player_by_id(db, player_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Player not found."
        )
    league = await resolve_league_or_default(db, league_id)
    return await player_rating_history(db, user.id, league.id, window)


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
    return await paginated_player_matches(db, player_id, page, page_size)
