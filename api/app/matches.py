import math
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_session
from app.leagues import get_default_league
from app.models import (
    League,
    Match,
    MatchGame,
    MatchGameScore,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    User,
)
from app.players import escape_like
from app.schemas.match import (
    STATUS_LABELS,
    MatchCreate,
    MatchDetails,
    MatchDetailsCurrentGame,
    MatchDetailsGame,
    MatchDetailsPlayer,
    MatchDetailsScore,
    MatchDetailsSide,
    MatchGameScoreWrite,
    MatchLeague,
    MatchListResponse,
    MatchListRow,
)
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")

MAX_PAGE_SIZE = 100


# ----- helpers -------------------------------------------------------------


def _side_schema(
    side: MatchSide,
    side_wins: dict[int, int],
    current_user_id: uuid.UUID,
) -> MatchDetailsSide:
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
        is_current_user_side=any(
            p.user_id == current_user_id for p in side.players
        ),
    )


# Shared eager-load chain. Used by every read path that returns a hierarchical
# match — async SQLAlchemy can't lazy-load mid-request, so all four collections
# are pulled up front.
def match_eager_options():
    return (
        selectinload(Match.match_settings),
        selectinload(Match.league),
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


async def _resolve_league(
    db: AsyncSession, league_id: uuid.UUID | None
) -> League:
    if league_id is not None:
        league = (
            await db.execute(select(League).where(League.id == league_id))
        ).scalar_one_or_none()
        if league is None:
            raise HTTPException(status_code=404, detail="League not found.")
        return league
    default = await get_default_league(db)
    if default is None:
        raise HTTPException(
            status_code=500, detail="No default league configured."
        )
    return default


def my_side(match: Match, user_id: uuid.UUID) -> MatchSide | None:
    return next(
        (
            s
            for s in match.sides
            if any(p.user_id == user_id for p in s.players)
        ),
        None,
    )


def opponent_side(match: Match, user_id: uuid.UUID) -> MatchSide | None:
    mine = my_side(match, user_id)
    if mine is None:
        return None
    return next(
        (s for s in match.sides if s.side_number != mine.side_number), None
    )


def opponent_username(match: Match, user_id: uuid.UUID) -> str | None:
    opp = opponent_side(match, user_id)
    if opp is None or not opp.players:
        return None
    return opp.players[0].user.username


def _is_participant(match: Match, user_id: uuid.UUID) -> bool:
    return my_side(match, user_id) is not None


def _games_to_win(best_of: int) -> int:
    return math.ceil(best_of / 2)


def _game_winner_side(score: MatchGameScore) -> int:
    # Ties are blocked by MatchGameScoreWrite; defensive fallback maps to side 2.
    return 1 if score.side_1_points > score.side_2_points else 2


def side_win_counts(match: Match) -> dict[int, int]:
    counts = {side.side_number: 0 for side in match.sides}
    for game in match.games:
        if game.score is None:
            continue
        winner = _game_winner_side(game.score)
        counts[winner] = counts.get(winner, 0) + 1
    return counts


def current_unscored_game(match: Match) -> MatchGame | None:
    return next((g for g in match.games if g.score is None), None)


def _serialize_details(match: Match, current_user_id: uuid.UUID) -> MatchDetails:
    mine = my_side(match, current_user_id)
    if mine is None:
        raise RuntimeError("serialize_details called for non-participant")
    opp = opponent_side(match, current_user_id)
    side_wins = side_win_counts(match)
    my_number = mine.side_number

    def _score_schema(score: MatchGameScore) -> MatchDetailsScore:
        my_points = (
            score.side_1_points if my_number == 1 else score.side_2_points
        )
        opp_points = (
            score.side_2_points if my_number == 1 else score.side_1_points
        )
        return MatchDetailsScore(
            id=score.id,
            my_points=my_points,
            opponent_points=opp_points,
            is_my_win=_game_winner_side(score) == my_number,
        )

    games_sorted = sorted(match.games, key=lambda g: g.game_number)
    games = [
        MatchDetailsGame(
            id=game.id,
            game_number=game.game_number,
            score=_score_schema(game.score) if game.score else None,
        )
        for game in games_sorted
    ]

    current_game_obj = current_unscored_game(match)
    current_game = (
        MatchDetailsCurrentGame(
            id=current_game_obj.id, game_number=current_game_obj.game_number
        )
        if current_game_obj is not None
        else None
    )

    return MatchDetails(
        id=match.id,
        status=match.status,
        status_label=STATUS_LABELS[match.status],
        league=MatchLeague(id=match.league.id, name=match.league.name),
        best_of=match.match_settings.best_of,
        games_to_win=_games_to_win(match.match_settings.best_of),
        team_size=match.match_settings.team_size,
        affects_rating=match.match_settings.affects_rating,
        created_at=match.created_at,
        my_side=_side_schema(mine, side_wins, current_user_id),
        opponent_side=(
            _side_schema(opp, side_wins, current_user_id) if opp else None
        ),
        games=games,
        current_game=current_game,
        can_score=current_game is not None and opp is not None,
    )


def _add_side(match: Match, side_number: int, player: User) -> None:
    """Attach a single-player side to ``match``.

    Wiring up the ``match`` relationship on both the side and the side-player
    is what populates their (non-null, denormalized) ``match_id`` columns on
    flush."""
    side = MatchSide(match=match, side_number=side_number)
    side.players.append(MatchSidePlayer(match=match, user=player))


# ----- list helpers --------------------------------------------------------


def participant_filter(query, current_user_id: uuid.UUID):
    me_in_match = (
        select(MatchSidePlayer.id)
        .where(
            MatchSidePlayer.match_id == Match.id,
            MatchSidePlayer.user_id == current_user_id,
        )
        .exists()
    )
    return query.where(me_in_match)


def _player_username_filter(query, q: str):
    """Restrict to matches that have *any* player whose username matches ``q``."""
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
                select(User).where(User.id == payload.opponent_user_id)
            )
        ).scalar_one_or_none()
        if opponent is None:
            raise HTTPException(status_code=404, detail="Opponent not found.")

    if payload.rated and opponent is None:
        raise HTTPException(
            status_code=422,
            detail="A rated match needs a registered opponent.",
        )

    # Guest / "start without opponent" matches have only the creator's side,
    # so they can never affect ratings regardless of the requested flag.
    affects_rating = payload.rated and opponent is not None

    league = await _resolve_league(db, payload.league_id)

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
    if opponent is not None:
        _add_side(match, 2, opponent)
    # The FE never creates a game — game 1 is written here so scoring routes
    # always have a real entity to deep-link into.
    match.games.append(MatchGame(game_number=1))

    db.add(match)
    await db.commit()

    created = await _load_match(db, match.id)
    assert created is not None
    return _serialize_details(created, current_user.id)


@router.get("/matches", response_model=MatchListResponse)
async def list_matches(
    status_: MatchStatus | None = Query(default=None, alias="status"),
    q: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=MAX_PAGE_SIZE),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchListResponse:
    # The list is open to every signed-in user. Writes still gate on
    # `_is_participant` downstream.
    base = select(Match)
    if q:
        base = _player_username_filter(base, q)

    paged = base if status_ is None else base.where(Match.status == status_)

    matches = (
        (
            await db.execute(
                paged.options(*match_eager_options())
                .order_by(Match.created_at.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
        )
        .scalars()
        .all()
    )

    # status_counts honors `q` and ignores the status filter, so it's built
    # from `base`. `total` then falls out of the same aggregate — no separate
    # count round-trip needed.
    counts_query = select(Match.status, func.count(Match.id))
    if q:
        counts_query = _player_username_filter(counts_query, q)
    status_counts: dict[MatchStatus, int] = {s: 0 for s in MatchStatus}
    for status_value, count in (
        await db.execute(counts_query.group_by(Match.status))
    ).all():
        status_counts[status_value] = count
    total = (
        status_counts[status_] if status_ is not None else sum(status_counts.values())
    )

    return MatchListResponse(
        items=[_list_row(match, current_user.id) for match in matches],
        page=page,
        page_size=page_size,
        total=total,
        status_counts=status_counts,
    )


def _list_row(match: Match, current_user_id: uuid.UUID) -> MatchListRow:
    side_wins = side_win_counts(match)
    sides_sorted = sorted(match.sides, key=lambda s: s.side_number)
    current_game = current_unscored_game(match)
    can_score = (
        match.status in {MatchStatus.pending, MatchStatus.in_progress}
        and len(match.sides) >= 2
        and current_game is not None
        and _is_participant(match, current_user_id)
    )

    return MatchListRow(
        id=match.id,
        status=match.status,
        status_label=STATUS_LABELS[match.status],
        league=MatchLeague(id=match.league.id, name=match.league.name),
        sides=[
            _side_schema(side, side_wins, current_user_id)
            for side in sides_sorted
        ],
        best_of=match.match_settings.best_of,
        created_at=match.created_at,
        current_game_id=current_game.id if can_score else None,
        can_score=can_score,
    )


@router.get("/matches/{match_id}", response_model=MatchDetails)
async def get_match(
    match_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchDetails:
    match = await _load_match(db, match_id)
    if match is None or not _is_participant(match, current_user.id):
        raise HTTPException(status_code=404, detail="Match not found.")
    return _serialize_details(match, current_user.id)


# ----- score writes --------------------------------------------------------


def _enforce_scorable(match: Match) -> None:
    if len(match.sides) < 2:
        raise HTTPException(
            status_code=422,
            detail="This match has no opponent and can't be scored.",
        )
    if match.status in {MatchStatus.disputed, MatchStatus.voided}:
        raise HTTPException(
            status_code=409, detail="This match is no longer scorable."
        )


def _recompute_match(match: Match) -> None:
    """Apply all post-score-write derivations on a loaded ``match``:
    side ``score``, match ``status``, side ``won`` flags, and the trailing
    un-scored game (deleted on completion; exactly one otherwise)."""
    sides_by_number = {s.side_number: s for s in match.sides}
    side_wins = side_win_counts(match)
    target = _games_to_win(match.match_settings.best_of)
    a_wins = side_wins.get(1, 0)
    b_wins = side_wins.get(2, 0)

    for side in match.sides:
        side.score = side_wins.get(side.side_number, 0)

    decided = a_wins >= target or b_wins >= target
    side_one = sides_by_number.get(1)
    side_two = sides_by_number.get(2)

    if decided:
        match.status = MatchStatus.completed
        if side_one is not None:
            side_one.won = a_wins > b_wins
        if side_two is not None:
            side_two.won = b_wins > a_wins
    else:
        match.status = MatchStatus.in_progress
        for side in match.sides:
            side.won = None

    games_sorted = sorted(match.games, key=lambda g: g.game_number)
    trailing_unscored = [g for g in games_sorted if g.score is None]
    if decided:
        for game in trailing_unscored:
            match.games.remove(game)
    elif not trailing_unscored:
        next_number = (
            max((g.game_number for g in games_sorted), default=0) + 1
        )
        match.games.append(MatchGame(game_number=next_number))


async def _load_match_for_scoring(
    db: AsyncSession,
    match_id: uuid.UUID,
    current_user_id: uuid.UUID,
) -> Match:
    match = await _load_match(db, match_id)
    if match is None or not _is_participant(match, current_user_id):
        raise HTTPException(status_code=404, detail="Match not found.")
    return match


@router.post(
    "/matches/{match_id}/games/{game_id}/scores",
    response_model=MatchDetails,
    status_code=status.HTTP_201_CREATED,
)
async def create_game_score(
    match_id: uuid.UUID,
    game_id: uuid.UUID,
    payload: MatchGameScoreWrite,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchDetails:
    match = await _load_match_for_scoring(db, match_id, current_user.id)
    _enforce_scorable(match)

    game = next((g for g in match.games if g.id == game_id), None)
    if game is None:
        raise HTTPException(status_code=404, detail="Game not found.")
    if game.score is not None:
        raise HTTPException(
            status_code=409, detail="This game has already been scored."
        )

    game.score = MatchGameScore(
        side_1_points=payload.side_1_points,
        side_2_points=payload.side_2_points,
    )

    _recompute_match(match)
    await db.commit()

    reloaded = await _load_match(db, match.id)
    assert reloaded is not None
    return _serialize_details(reloaded, current_user.id)


@router.put(
    "/matches/{match_id}/games/{game_id}/scores/{score_id}",
    response_model=MatchDetails,
)
async def update_game_score(
    match_id: uuid.UUID,
    game_id: uuid.UUID,
    score_id: uuid.UUID,
    payload: MatchGameScoreWrite,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchDetails:
    match = await _load_match_for_scoring(db, match_id, current_user.id)
    _enforce_scorable(match)

    game = next((g for g in match.games if g.id == game_id), None)
    if game is None:
        raise HTTPException(status_code=404, detail="Game not found.")
    if game.score is None or game.score.id != score_id:
        raise HTTPException(status_code=404, detail="Score not found.")

    game.score.side_1_points = payload.side_1_points
    game.score.side_2_points = payload.side_2_points

    _recompute_match(match)
    await db.commit()

    reloaded = await _load_match(db, match.id)
    assert reloaded is not None
    return _serialize_details(reloaded, current_user.id)
