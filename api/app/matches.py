import math
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_session
from app.models import (
    Match,
    MatchGame,
    MatchGameScore,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    User,
)
from app.players import _escape_like
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
    MatchListResponse,
    MatchListRow,
)
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")

MAX_PAGE_SIZE = 100


# ----- helpers -------------------------------------------------------------


async def _load_match(db: AsyncSession, match_id: uuid.UUID) -> Match | None:
    """Fetch a match with every relationship the BFF serializer touches eagerly
    loaded — async SQLAlchemy can't lazy-load once the request is in flight."""
    result = await db.execute(
        select(Match)
        .where(Match.id == match_id)
        .options(
            selectinload(Match.match_settings),
            selectinload(Match.sides)
            .selectinload(MatchSide.players)
            .selectinload(MatchSidePlayer.user),
            selectinload(Match.games).selectinload(MatchGame.score),
        )
    )
    return result.scalar_one_or_none()


def _is_participant(match: Match, user_id: uuid.UUID) -> bool:
    return any(
        player.user_id == user_id
        for side in match.sides
        for player in side.players
    )


def _games_to_win(best_of: int) -> int:
    return math.ceil(best_of / 2)


def _game_winner_side(score: MatchGameScore) -> int:
    return 1 if score.side_1_points > score.side_2_points else 2


def _side_win_counts(match: Match) -> dict[int, int]:
    counts = {side.side_number: 0 for side in match.sides}
    for game in match.games:
        if game.score is None:
            continue
        winner = _game_winner_side(game.score)
        counts[winner] = counts.get(winner, 0) + 1
    return counts


def _serialize_details(match: Match, current_user_id: uuid.UUID) -> MatchDetails:
    sides_sorted = sorted(match.sides, key=lambda s: s.side_number)
    games_sorted = sorted(match.games, key=lambda g: g.game_number)
    side_wins = _side_win_counts(match)

    my_side = next(
        (
            s
            for s in sides_sorted
            if any(p.user_id == current_user_id for p in s.players)
        ),
        None,
    )
    if my_side is None:
        raise RuntimeError("serialize_details called for non-participant")

    opponent_side = next(
        (s for s in sides_sorted if s.side_number != my_side.side_number),
        None,
    )
    my_number = my_side.side_number

    def _side_schema(side: MatchSide) -> MatchDetailsSide:
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
            is_current_user_side=side.side_number == my_number,
        )

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

    games = [
        MatchDetailsGame(
            id=game.id,
            game_number=game.game_number,
            score=_score_schema(game.score) if game.score else None,
        )
        for game in games_sorted
    ]

    current_game_obj = next(
        (g for g in games_sorted if g.score is None), None
    )
    current_game = (
        MatchDetailsCurrentGame(
            id=current_game_obj.id, game_number=current_game_obj.game_number
        )
        if current_game_obj is not None
        else None
    )

    can_score = current_game is not None and opponent_side is not None

    return MatchDetails(
        id=match.id,
        status=match.status,
        status_label=STATUS_LABELS[match.status],
        best_of=match.match_settings.best_of,
        games_to_win=_games_to_win(match.match_settings.best_of),
        team_size=match.match_settings.team_size,
        affects_rating=match.match_settings.affects_rating,
        created_at=match.created_at,
        my_side=_side_schema(my_side),
        opponent_side=(
            _side_schema(opponent_side) if opponent_side else None
        ),
        games=games,
        current_game=current_game,
        can_score=can_score,
    )


def _add_side(match: Match, side_number: int, player: User) -> None:
    """Attach a single-player side to ``match``.

    Wiring up the ``match`` relationship on both the side and the side-player
    is what populates their (non-null, denormalized) ``match_id`` columns on
    flush."""
    side = MatchSide(match=match, side_number=side_number)
    side.players.append(MatchSidePlayer(match=match, user=player))


# ----- list helpers --------------------------------------------------------


def _participant_filter(query, current_user_id: uuid.UUID):
    me_in_match = (
        select(MatchSidePlayer.id)
        .where(
            MatchSidePlayer.match_id == Match.id,
            MatchSidePlayer.user_id == current_user_id,
        )
        .exists()
    )
    return query.where(me_in_match)


def _opponent_username_filter(query, current_user_id: uuid.UUID, q: str):
    pattern = f"%{_escape_like(q.strip())}%"
    has_matching_opponent = (
        select(MatchSidePlayer.id)
        .join(User, User.id == MatchSidePlayer.user_id)
        .where(
            MatchSidePlayer.match_id == Match.id,
            MatchSidePlayer.user_id != current_user_id,
            User.username.ilike(pattern, escape="\\"),
        )
        .exists()
    )
    return query.where(has_matching_opponent)


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

    settings = MatchSettings(
        team_size=1,
        best_of=payload.best_of,
        affects_rating=affects_rating,
    )
    match = Match(
        match_settings=settings,
        created_by_user_id=current_user.id,
        status=MatchStatus.pending,
    )
    _add_side(match, 1, current_user)
    if opponent is not None:
        _add_side(match, 2, opponent)
    # Game 1 always exists from the moment a match is created — the FE never
    # creates a game, it only deep-links into the current one to record a score.
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
    base = _participant_filter(select(Match), current_user.id)
    if q:
        base = _opponent_username_filter(base, current_user.id, q)

    paged = base
    if status_ is not None:
        paged = paged.where(Match.status == status_)

    total = (
        await db.execute(
            select(func.count()).select_from(paged.order_by(None).subquery())
        )
    ).scalar_one()

    matches = (
        (
            await db.execute(
                paged.options(
                    selectinload(Match.match_settings),
                    selectinload(Match.sides)
                    .selectinload(MatchSide.players)
                    .selectinload(MatchSidePlayer.user),
                    selectinload(Match.games).selectinload(MatchGame.score),
                )
                .order_by(Match.created_at.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
        )
        .scalars()
        .all()
    )

    items: list[MatchListRow] = [
        _list_row(match, current_user.id) for match in matches
    ]

    # status_counts honors `q` but ignores the status filter, so build it from
    # the unpaginated, unstatused query: same WHEREs as `base`, project the
    # status column, group by it.
    counts_query = _participant_filter(
        select(Match.status, func.count(Match.id)), current_user.id
    )
    if q:
        counts_query = _opponent_username_filter(
            counts_query, current_user.id, q
        )
    counts_query = counts_query.group_by(Match.status)
    status_counts: dict[MatchStatus, int] = {s: 0 for s in MatchStatus}
    for status_value, count in (await db.execute(counts_query)).all():
        status_counts[status_value] = count

    return MatchListResponse(
        items=items,
        page=page,
        page_size=page_size,
        total=total,
        status_counts=status_counts,
    )


def _list_row(match: Match, current_user_id: uuid.UUID) -> MatchListRow:
    my_side = next(
        s
        for s in match.sides
        if any(p.user_id == current_user_id for p in s.players)
    )
    opponent_side = next(
        (s for s in match.sides if s.side_number != my_side.side_number),
        None,
    )

    side_wins = _side_win_counts(match)
    my_games_won = side_wins.get(my_side.side_number, 0)
    opp_games_won = (
        side_wins.get(opponent_side.side_number, 0) if opponent_side else 0
    )

    opponent_player = (
        opponent_side.players[0]
        if opponent_side and opponent_side.players
        else None
    )

    current_game = next(
        (g for g in match.games if g.score is None), None
    )
    scorable = (
        match.status in {MatchStatus.pending, MatchStatus.in_progress}
        and opponent_side is not None
        and current_game is not None
    )

    is_win: bool | None = None
    if match.status == MatchStatus.completed and opponent_side is not None:
        is_win = my_games_won > opp_games_won

    return MatchListRow(
        id=match.id,
        status=match.status,
        status_label=STATUS_LABELS[match.status],
        opponent_username=(
            opponent_player.user.username if opponent_player else None
        ),
        opponent_user_id=(
            opponent_player.user_id if opponent_player else None
        ),
        my_games_won=my_games_won,
        opponent_games_won=opp_games_won,
        is_win=is_win,
        best_of=match.match_settings.best_of,
        created_at=match.created_at,
        current_game_id=current_game.id if scorable else None,
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
    """Apply all post-score-write derivations on a single loaded ``match``:

    - side ``score`` (count of games each side has won)
    - match ``status`` (completed if either side reached games_to_win)
    - side ``won`` flags (true/false on completion, reset to None on re-open)
    - game lifecycle reconciliation (delete trailing unscored games when
      completed; ensure exactly one trailing unscored game otherwise)
    """
    sides_by_number = {s.side_number: s for s in match.sides}
    side_wins = _side_win_counts(match)
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
        has_scored = a_wins > 0 or b_wins > 0
        match.status = (
            MatchStatus.in_progress if has_scored else MatchStatus.pending
        )
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
