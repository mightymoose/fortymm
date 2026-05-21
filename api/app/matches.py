import csv
import io
import math
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, selectinload

from app.db import get_session
from app.leagues import resolve_league
from app.models import (
    League,
    Match,
    MatchGame,
    MatchGameScore,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    RatingHistorySource,
    RatingStrategy,
    User,
    UserLeagueRating,
)
from app.players import escape_like
from app.ratings import get_calculator, state_rating_value, validate_state
from app.schemas.match import (
    STATUS_LABELS,
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
    MatchGameScoreWrite,
    MatchLeague,
    MatchListResponse,
    MatchListRow,
)
from app.schemas.rating import RatingChange
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")

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
        is_current_user_side=any(
            p.user_id == current_user_id for p in side.players
        ),
        rating_change=rating_change,
    )


# Shared eager-load chain. Used by every read path that returns a hierarchical
# match — async SQLAlchemy can't lazy-load mid-request, so all four collections
# are pulled up front.
def match_eager_options():
    return (
        selectinload(Match.match_settings),
        selectinload(Match.league).selectinload(League.rating_strategy),
        *_match_history_options(),
    )


def _match_history_options():
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


def _serialize_details(
    match: Match,
    current_user_id: uuid.UUID,
    extras: "ViewExtras | None" = None,
) -> MatchDetails:
    extras = extras or _EMPTY_EXTRAS
    side_wins = side_win_counts(match)

    def _score_schema(score: MatchGameScore) -> MatchDetailsScore:
        return MatchDetailsScore(
            id=score.id,
            side_1_points=score.side_1_points,
            side_2_points=score.side_2_points,
            winner_side_number=_game_winner_side(score),
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

    sides_sorted = sorted(match.sides, key=lambda s: s.side_number)
    is_participant = _is_participant(match, current_user_id)

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
        sides=[
            _side_schema(side, side_wins, current_user_id, extras.rating_changes)
            for side in sides_sorted
        ],
        games=games,
        current_game=current_game,
        # Spectators see scores, never the Score CTA — writes still 404 for
        # non-participants in the score endpoints below.
        can_score=(
            current_game is not None and len(match.sides) >= 2 and is_participant
        ),
        recent_form=extras.recent_form,
        head_to_head=extras.head_to_head,
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


def _filtered_matches_query(q: str | None, status_: MatchStatus | None):
    """Shared base query for the matches list + CSV export (status + search)."""
    base = select(Match)
    if q:
        base = _player_username_filter(base, q)
    return base if status_ is None else base.where(Match.status == status_)


@router.get("/matches.csv", response_class=Response)
async def export_matches_csv(
    status_: MatchStatus | None = Query(default=None, alias="status"),
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
    csv_text = _matches_to_csv(
        [_list_row(match, current_user.id) for match in matches]
    )
    filename = f"fortymm-matches-{datetime.now(UTC).strftime('%Y-%m-%d')}.csv"
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


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

    # status_counts honors `q` but ignores the status filter, so it's built
    # from its own aggregate. `total` then falls out of the same counts — no
    # separate count round-trip needed.
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
        current_game_id=current_game.id if can_score and current_game else None,
        can_score=can_score,
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


@router.get("/matches/{match_id}", response_model=MatchDetails)
async def get_match(
    match_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchDetails:
    # Open to any signed-in viewer. The serializer flags whether the current
    # user is on a side; write paths below still gate on participation.
    match = await _load_match(db, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found.")
    extras = await _load_view_extras(db, match)
    return _serialize_details(match, current_user.id, extras)


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


async def _load_rating_changes(
    db: AsyncSession, match_id: uuid.UUID
) -> dict[uuid.UUID, RatingChange]:
    """Returns ``user_id -> RatingChange`` for every rating row this match
    produced. Empty for matches that didn't move ratings."""
    rows = (
        await db.execute(
            select(RatingHistory).where(RatingHistory.match_id == match_id)
        )
    ).scalars().all()
    return {row.user_id: RatingChange.from_history(row) for row in rows}


def _singles_user_ids(match: Match) -> list[uuid.UUID]:
    """Singles player IDs, ordered by side number. Sides without exactly one
    player are skipped — no doubles surface yet."""
    sides_in_order = sorted(match.sides, key=lambda s: s.side_number)
    return [
        side.players[0].user_id
        for side in sides_in_order
        if len(side.players) == 1
    ]


def _history_base_query(
    current_match_id: uuid.UUID, before: datetime | None = None
):
    """Foundation for both recent-form and H2H lookups: completed matches
    other than this one, eagerly loading just the sides + games subtree.

    Pass ``before`` to restrict to matches completed before that instant, so a
    match viewed in the past shows the form as it stood then rather than the
    players' current form."""
    query = (
        select(Match)
        .where(
            Match.status == MatchStatus.completed,
            Match.id != current_match_id,
        )
        .options(*_match_history_options())
        .order_by(Match.updated_at.desc())
    )
    if before is not None:
        query = query.where(Match.updated_at < before)
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
            await db.execute(
                participant_filter(
                    _history_base_query(match.id, before=match.created_at),
                    user_id,
                ).limit(RECENT_FORM_LIMIT)
            )
        ).scalars().all()
        rating_before, rating_history = await _load_pre_match_rating(
            db, user_id, match.league_id, match.created_at
        )
        matches_before, wins_before = await _load_career_before(
            db, user_id, match.id, match.created_at
        )
        result.append(
            MatchDetailsPlayerForm(
                user_id=user_id,
                recent_results=[
                    _build_form_result(past, user_id) for past in rows
                ],
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
    ).scalars().all()
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
                Match.updated_at < before,
            )
        )
    ).one()
    return int(row[0]), int(row[1])


def _build_form_result(
    past_match: Match, user_id: uuid.UUID
) -> MatchDetailsFormResult:
    mine = my_side(past_match, user_id)
    assert mine is not None  # participant_filter guarantees membership
    side_wins = side_win_counts(past_match)
    player_games = side_wins.get(mine.side_number, 0)
    opp_games = sum(
        wins for n, wins in side_wins.items() if n != mine.side_number
    )
    return MatchDetailsFormResult(
        match_id=past_match.id,
        is_win=mine.won is True,
        player_games_won=player_games,
        opponent_games_won=opp_games,
        opponent_username=opponent_username(past_match, user_id),
        completed_at=past_match.updated_at,
    )


async def _load_head_to_head(
    db: AsyncSession,
    user_ids: list[uuid.UUID],
    current_match_id: uuid.UUID,
) -> MatchDetailsH2H | None:
    if len(user_ids) != 2:
        return None
    user_a, user_b = user_ids
    rows_query = participant_filter(
        participant_filter(_history_base_query(current_match_id), user_a),
        user_b,
    )
    rows = (
        await db.execute(rows_query.limit(H2H_MEETINGS_LIMIT))
    ).scalars().all()

    meetings: list[MatchDetailsH2HMeeting] = []
    for past in rows:
        past_a = my_side(past, user_a)
        past_b = my_side(past, user_b)
        assert past_a is not None and past_b is not None
        side_wins = side_win_counts(past)
        a_games = side_wins.get(past_a.side_number, 0)
        b_games = side_wins.get(past_b.side_number, 0)
        winner_side: int | None = (
            1 if past_a.won is True else 2 if past_b.won is True else None
        )
        meetings.append(
            MatchDetailsH2HMeeting(
                match_id=past.id,
                completed_at=past.updated_at,
                side_1_games_won=a_games,
                side_2_games_won=b_games,
                winner_side_number=winner_side,
            )
        )

    # Full-history aggregates so the displayed window doesn't undercount a
    # long rivalry. Driven from MatchSide.won so a future void/dispute that
    # leaves `won` null naturally drops out of both totals.
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
            db, user_ids if len(user_ids) == 2 else [], match.id
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
            select(RatingHistory.id)
            .where(RatingHistory.match_id == match.id)
            .limit(1)
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
    await _apply_rating_update(db, match)
    await db.commit()

    reloaded = await _load_match(db, match.id)
    assert reloaded is not None
    extras = await _load_view_extras(db, reloaded)
    return _serialize_details(reloaded, current_user.id, extras)


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
    await _apply_rating_update(db, match)
    await db.commit()

    reloaded = await _load_match(db, match.id)
    assert reloaded is not None
    extras = await _load_view_extras(db, reloaded)
    return _serialize_details(reloaded, current_user.id, extras)
