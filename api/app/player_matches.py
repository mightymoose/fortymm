"""One player's match history, projected onto THEIR side of each match.

The list is the same read for two surfaces (api/CLAUDE.md: a shared helper
belongs in a module both callers import) — the profile overview embeds the six
most recent, the full-history route pages through all of them, and both go
through ``paginated_player_matches``. Neither may drift from the other on what a
match *looks like* from a player's point of view.

That projection is the domain work here, and it is why this is not a query the
router could inline:

* the PERSPECTIVE FLIP — game scores are stored as ``side_1`` / ``side_2``, and a
  row on this list reads ``mine`` / ``theirs``, so which side the player was on
  decides which number is which;
* the RESULT — read from ``MatchSide.won``, which is stamped only when a match
  completes. A rated match awaiting acceptance therefore has NO W/L yet (#485);
* the Δ COLUMN — a match moved a rating only if it is both DECIDED and RATED.
  Anything else reports ``None`` (rendered ``—``), never a zero, which would
  claim the match was rated and moved nothing.

The history is ALL-INCLUSIVE (ADR-0008): every match the player is a side of, any
status, rated or not, solo "No opponent" matches included. A match still in play
is history too — so there is no status filter anywhere below.
"""

import uuid
from collections.abc import Iterable
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload, selectinload
from sqlalchemy.sql.base import ExecutableOption

from app.models import (
    Match,
    MatchGame,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
)
from app.result_chain import standing_result
from app.schemas.player import (
    PlayerMatchGame,
    PlayerMatchListResponse,
    PlayerMatchOpponent,
    PlayerMatchRow,
)
from app.schemas.rating import RatingChange


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
        # rating, so it reports no rating change (not a zero one). Many-to-one
        # (``matches.match_settings_id``), so it joins into the match query
        # rather than costing a second SELECT.
        joinedload(Match.match_settings),
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

    # A result has been proposed but the opponent hasn't accepted it yet — the
    # same predicate matches.py's ``_status_label`` buckets as "Awaiting
    # acceptance", read from the one place that defines it (``app.result_chain``,
    # a shared domain module — not the matches router). The FE uses this to
    # render a distinct chip instead of the green "LIVE" one a genuinely-live
    # ``in_progress`` match gets (#364).
    awaiting_acceptance = (
        match.status == MatchStatus.in_progress and standing_result(match) is not None
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


async def paginated_player_matches(
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
