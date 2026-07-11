"""Data access for the match-details *view extras* — rating changes, per-player
recent form (with the pre-match rating trail and career record), and the
head-to-head block.

A plain class wired with an ``AsyncSession`` (no FastAPI imports) so it's
constructible in the REPL, in scripts, and in tests. It takes **primitives** —
the ids / instants / status the caller already holds from the match it loaded —
and returns the storage-agnostic ``app.domain.match.extras`` shapes; the SQL and
the ORM rows stop here.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, selectinload

from app.domain.match.extras import (
    CareerRecord,
    FormResult,
    HeadToHead,
    HeadToHeadMeeting,
    PlayerForm,
    PreMatchRating,
    RatingChange,
)
from app.match_queries import (
    history_base_query,
    my_side,
    opponent_username,
    participant_filter,
)
from app.models import (
    Match,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
)
from app.result_acceptance import side_win_counts

RECENT_FORM_LIMIT = 5
H2H_MEETINGS_LIMIT = 5
# Cap on the pre-match sparkline so the BFF stays cheap; the dashboard
# Sparkline already pads single points to 2.
RATING_HISTORY_LIMIT = 10


def _form_result(past_match: Match, user_id: uuid.UUID) -> FormResult:
    mine = my_side(past_match, user_id)
    assert mine is not None  # participant_filter guarantees membership
    # The history query filters status == completed, so completed_at is set.
    assert past_match.completed_at is not None
    side_wins = side_win_counts(past_match)
    player_games = side_wins.get(mine.side_number, 0)
    opp_games = sum(wins for n, wins in side_wins.items() if n != mine.side_number)
    return FormResult(
        match_id=past_match.id,
        is_win=mine.won is True,
        player_games_won=player_games,
        opponent_games_won=opp_games,
        opponent_username=opponent_username(past_match, user_id),
        completed_at=past_match.completed_at,
    )


class MatchDetailsRepository:
    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def rating_changes(
        self, match_id: uuid.UUID, status: MatchStatus
    ) -> dict[uuid.UUID, RatingChange]:
        """Returns ``user_id -> RatingChange`` for every rating row this match
        produced. Empty for matches that didn't move ratings — including, always,
        a non-completed match, since no rating rows can exist before completion."""
        if status != MatchStatus.completed:
            return {}
        rows = (
            (
                await self._db.execute(
                    select(RatingHistory).where(RatingHistory.match_id == match_id)
                )
            )
            .scalars()
            .all()
        )
        return {
            row.user_id: RatingChange.of(
                before=row.previous_rating_value, after=row.rating_value
            )
            for row in rows
        }

    async def recent_form(
        self,
        user_ids: list[uuid.UUID],
        match_id: uuid.UUID,
        league_id: uuid.UUID,
        created_at: datetime,
    ) -> list[PlayerForm]:
        """Each player's last few completed matches before this one, with the
        rating + career record they carried into it."""
        if not user_ids:
            return []

        # Batched once for every player, ahead of the loop — one round-trip
        # each, not one per user (issue #195).
        careers = await self.career_before(user_ids, created_at)
        ratings = await self.pre_match_ratings(user_ids, league_id, created_at)

        result: list[PlayerForm] = []
        for user_id in user_ids:
            rows = (
                (
                    await self._db.execute(
                        participant_filter(
                            history_base_query(match_id, before=created_at),
                            user_id,
                        ).limit(RECENT_FORM_LIMIT)
                    )
                )
                .scalars()
                .all()
            )
            result.append(
                PlayerForm(
                    user_id=user_id,
                    recent_results=[_form_result(past, user_id) for past in rows],
                    rating_before=ratings[user_id],
                    career_before=careers[user_id],
                )
            )
        return result

    async def pre_match_ratings(
        self,
        user_ids: list[uuid.UUID],
        league_id: uuid.UUID,
        before: datetime,
    ) -> dict[uuid.UUID, PreMatchRating]:
        """Every cited player's rating in ``league_id`` as of just before
        ``before``, plus the chronological trail behind it, in **one** round-trip
        rather than one query per user (issue #195).

        The per-user ``ORDER BY created_at DESC LIMIT n`` collapses into a single
        ``ROW_NUMBER() OVER (PARTITION BY user_id ...)`` window, capped in an outer
        query (a window function can't be filtered in its own ``WHERE``). The cap
        is therefore genuinely **per user** — a flat ``LIMIT`` over the whole
        result set would starve the second player.

        Strict ``<`` on ``before`` so this match's own rating row never leaks in.

        A player with no rating history in the league has **no rows** in the
        windowed result; they are defaulted back in as an unrated player, so every
        requested id is always a key of the returned dict."""
        if not user_ids:
            return {}
        ranked = (
            select(
                RatingHistory.user_id,
                RatingHistory.rating_value,
                func.row_number()
                .over(
                    partition_by=RatingHistory.user_id,
                    order_by=RatingHistory.created_at.desc(),
                )
                .label("rn"),
            )
            .where(
                RatingHistory.user_id.in_(user_ids),
                RatingHistory.league_id == league_id,
                RatingHistory.created_at < before,
            )
            .subquery()
        )
        rows = (
            await self._db.execute(
                select(ranked.c.user_id, ranked.c.rating_value)
                .where(ranked.c.rn <= RATING_HISTORY_LIMIT)
                .order_by(ranked.c.user_id, ranked.c.rn)
            )
        ).all()

        # Rows arrive newest-first per user (``rn`` ascending), so the head of each
        # trail is the most-recent value and the history is its chronological
        # (ASC) reversal.
        trails: dict[uuid.UUID, list[float]] = {}
        for row in rows:
            trails.setdefault(row[0], []).append(float(row[1]))
        rated = {
            user_id: PreMatchRating(value=trail[0], history=list(reversed(trail)))
            for user_id, trail in trails.items()
        }
        return {
            user_id: rated.get(user_id, PreMatchRating(value=None, history=[]))
            for user_id in user_ids
        }

    async def career_before(
        self,
        user_ids: list[uuid.UUID],
        before: datetime,
    ) -> dict[uuid.UUID, CareerRecord]:
        """Every cited player's cross-league ``(matches, wins)`` completed strictly
        before ``before`` (the current match's ``created_at``), in **one**
        ``GROUP BY user_id`` round-trip rather than one query per user (issue #195).

        The current match is excluded by the date filter alone: a completed match's
        ``completed_at`` is always ``>=`` its own ``created_at``, so it can never
        satisfy ``completed_at < created_at``. No separate ``id`` guard is needed
        (issue #202).

        A player with no prior completed matches has **no row** in the grouped
        result; they are defaulted back in as a zero record, so every requested id
        is always a key of the returned dict."""
        if not user_ids:
            return {}
        side = aliased(MatchSide)
        player = aliased(MatchSidePlayer)
        rows = (
            await self._db.execute(
                select(
                    player.user_id,
                    func.count(Match.id),
                    func.count(Match.id).filter(side.won.is_(True)),
                )
                .join(side, side.match_id == Match.id)
                .join(player, player.match_side_id == side.id)
                .where(
                    player.user_id.in_(user_ids),
                    Match.status == MatchStatus.completed,
                    Match.completed_at < before,
                )
                .group_by(player.user_id)
            )
        ).all()
        played = {
            row[0]: CareerRecord(matches=int(row[1]), wins=int(row[2])) for row in rows
        }
        return {
            user_id: played.get(user_id, CareerRecord(matches=0, wins=0))
            for user_id in user_ids
        }

    async def head_to_head(
        self,
        user_ids: list[uuid.UUID],
        match_id: uuid.UUID,
        created_at: datetime,
    ) -> HeadToHead | None:
        """The rivalry between this match's two singles players as it stood
        going into it. ``None`` unless there are exactly two players."""
        if len(user_ids) != 2:
            return None
        user_a, user_b = user_ids
        rows_query = participant_filter(
            participant_filter(history_base_query(match_id, before=created_at), user_a),
            user_b,
        ).options(selectinload(Match.match_settings))
        rows = (
            (await self._db.execute(rows_query.limit(H2H_MEETINGS_LIMIT)))
            .scalars()
            .all()
        )

        meetings: list[HeadToHeadMeeting] = []
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
                HeadToHeadMeeting(
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
                Match.id != match_id,
                Match.completed_at < created_at,
                a_player.user_id == user_a,
                b_player.user_id == user_b,
                a_side.id != b_side.id,
            )
        )
        total, a_wins, b_wins = (await self._db.execute(counts_query)).one()

        return HeadToHead(
            total_meetings=total,
            side_1_wins=a_wins,
            side_2_wins=b_wins,
            recent_meetings=meetings,
        )
