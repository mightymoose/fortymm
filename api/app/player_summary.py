"""The ``PlayerSummary`` — one player's headline row: rating, rank, career W-L
and recent form.

It backs TWO surfaces, which is why it lives here and not on a router: the
`/players` roster serializes a page of them, and the profile's hero is a single
one (`app.players`). Shared query/domain helpers belong in a module both callers
import (api/CLAUDE.md), and the hydration below is the whole reason — it is four
round trips *regardless of page size*, so a roster of a hundred players costs the
same reads as one profile. Re-deriving any of it per row would be an N+1 on the
list page.

THE LEAGUE SPLIT (ADR-0915) runs straight through the summary, so it is stated
once here: ``rating``, ``rank`` and ``form`` are facts about ONE LADDER and take
a ``league_id``; ``wins`` / ``losses`` are the CAREER W-L, a fact about the
person, and deliberately count every league — they must agree with the profile's
``career`` block, which does the same.
"""

import uuid
from collections.abc import Iterable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Match,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    User,
    UserLeagueRating,
)
from app.ratings.rated import is_rated_member
from app.schemas.player import PlayerSummary

# How many recent W/L results to surface as the "form" string on
# PlayerSummary. TEN, because the profile is where a player is actually studied
# — a five-result window says almost nothing about how they are playing.
#
# `form` is ONE shared field: the `/players` roster serializes the same
# `PlayerSummary` and so also receives ten results, and slices the first five for
# its dots column. That is the intended trade — a second, roster-width form field
# would be a field carrying its own derivation (api/CLAUDE.md).
FORM_WINDOW = 10


async def load_player_ratings(
    db: AsyncSession, league_id: uuid.UUID, user_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, float | None]:
    """One round trip: returns ``user_id -> rating`` in this league. An UNRATED
    player is absent (so ``.get()`` yields ``None``).

    THE ``is_rated_member()`` GATE IS THE WHOLE POINT OF THIS FUNCTION, and it is
    why "no rating row" is not the test: joining a league seeds a 1500 row, so
    every member of a glicko2 ladder has one, and a read of ``rating_value`` alone
    hands a brand-new guest the seed as though they had played for it. A player
    holds a rating here only once something has MOVED that row (``app.ratings.rated``).

    This is the deepest gate on the read side, and the reason the rest of the hero
    falls out for free: ``rank`` is ranked over the same population, and ``peak`` /
    ``rank_of`` / ``percentile`` / ``rating_delta`` all key off this ``rating``
    being present (``player_standing``). No field can disagree with another about
    whether the player is Unrated, because they all ask the same question once.
    """
    ids = list(user_ids)
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(UserLeagueRating.user_id, UserLeagueRating.rating_value).where(
                UserLeagueRating.league_id == league_id,
                UserLeagueRating.user_id.in_(ids),
                is_rated_member(),
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

    The window is evaluated over the ENTIRE rated league population and only THEN
    filtered to ``user_ids`` — never over ``user_ids`` alone — so a player's rank
    is a global fact, invariant under the roster's search or pagination (the #841
    regression).

    UNRATED members are absent from the result (so ``.get()`` yields ``None``):
    no rating, no rank — "not a large number at the bottom of the list"
    (CONTEXT.md, "Rank"). They are excluded from the POPULATION as well as from
    the answer, which is the same thing said twice on purpose: a ladder of a
    hundred seeded-but-never-played guests must not push the two players who have
    actually played each other down to ranks 51 and 52.

    ``is_rated_member()`` is the WHOLE population filter — it carries the tombstone
    exclusion (a merged-away ghost is not a rung, so it cannot inflate a real rank)
    as well as the rated one, which is why there is no ``User`` join left here. It
    is the same predicate ``load_player_ratings``, ``league_rated_population`` and
    ``league_percentile`` ask, so rank, rating, the "of N" behind it and the "Top
    N%" beside it are read off ONE ladder by construction — not by four WHERE
    clauses agreeing to.
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
        ).where(
            UserLeagueRating.league_id == league_id,
            is_rated_member(),
        )
    ).subquery()

    rows = (
        await db.execute(
            select(ranked.c.user_id, ranked.c.rank).where(ranked.c.user_id.in_(ids))
        )
    ).all()
    return {user_id: int(rank) for user_id, rank in rows}


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
    db: AsyncSession, user_ids: list[uuid.UUID], league_id: uuid.UUID
) -> dict[uuid.UUID, str]:
    """One round trip via a window function: returns ``user_id -> "WLWWL"``
    of up to FORM_WINDOW newest-first completed-match outcomes IN THIS LEAGUE.
    Drives the form-dots column.

    LEAGUE-SCOPED, like rating / rank / peak / confidence and unlike career
    (ADR-0915): a match is played in exactly one league, and form says what is
    happening lately *on this ladder*. Drop the ``Match.league_id`` filter and a
    player's form on the FortyMM ladder starts quoting results they got on a USATT
    one — the same class of bug as a peak read from the wrong league. Career is
    the block that deliberately counts every league; this is not it.
    """
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
            Match.league_id == league_id,
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


async def summarize_players(
    db: AsyncSession, users: list[User], league_id: uuid.UUID
) -> list[PlayerSummary]:
    """Hydrate a list of ``User``s into the ``PlayerSummary`` shape the
    `/players` list + profile-page hero render. Four round trips total
    (ratings, W-L, form, ranks) regardless of page size.

    Three of the four are scoped to ``league_id``: `rating`, `rank` and `form`
    are all facts about one ladder (ADR-0915). ``wins``/``losses`` are the
    exception, and deliberately so — they are the CAREER W-L, a fact about the
    person, and they must agree with the profile's `career` block, which counts
    every league. That is why ``_load_wl_counts`` takes no league and
    ``_load_form`` does."""
    if not users:
        return []
    user_ids = [user.id for user in users]
    ratings = await load_player_ratings(db, league_id, user_ids)
    wl = await _load_wl_counts(db, user_ids)
    form = await _load_form(db, user_ids, league_id)
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


async def summarize_one_player(
    db: AsyncSession, user: User, league_id: uuid.UUID
) -> PlayerSummary:
    """The profile hero's summary — the same hydration the roster runs, for one
    player, so the two surfaces cannot report different W-L for the same user."""
    summaries = await summarize_players(db, [user], league_id)
    return summaries[0]
