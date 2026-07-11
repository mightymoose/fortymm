"""Shared match query builders and loaded-row readers.

The neutral home for the SQLAlchemy fragments (eager-load chains, ``EXISTS``
filters, base queries) and the small readers over an already-loaded ``Match``
that more than one caller needs — the matches router, the dashboard BFF, and the
match-details read path all build on these.

They used to live on the ``app.matches`` router, which made every other module
import a router's internals (against the ``api/CLAUDE.md`` rule that routers must
not depend on each other) and made a match-details module importing them a
circular import. Nothing here holds a FastAPI type, and nothing here reaches back
into ``app.matches`` — so the match-details read path can import these freely.

One wart, inherited rather than introduced: ``escape_like`` still comes from
``app.players``, which does define a router. It's a pure string helper with no
router dependency of its own and it creates no cycle for our callers, but it does
mean this module is not yet the clean leaf it should be. Moving it to a neutral
home would finish the job.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Select, select
from sqlalchemy.orm import aliased, selectinload
from sqlalchemy.sql.base import ExecutableOption

from app.models import (
    Match,
    MatchGame,
    MatchResult,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    User,
)
from app.players import escape_like
from app.result_acceptance import _games_to_win, side_win_counts

# ----- eager-load chains ---------------------------------------------------


# Shared eager-load chain. Used by every read path that returns a hierarchical
# match — async SQLAlchemy can't lazy-load mid-request, so all collections are
# pulled up front. The posted results (the propose/accept chain) are needed
# wherever ``can_finalize`` / the awaiting-acceptance status label / the
# derived ``negotiation`` block are computed.
#
# ``Match.league`` is eager (serializers read ``league.id``/``league.name``) but
# its nested ``rating_strategy`` is NOT — only the score-write finalize paths
# read it (inside ``_apply_rating_update``), and they load it explicitly via
# ``match_rating_eager_options`` so the list / detail / dashboard reads don't pay
# an extra ``selectinload`` on the strategy row (issue #182).
def match_eager_options() -> tuple[ExecutableOption, ...]:
    return (
        selectinload(Match.match_settings),
        selectinload(Match.league),
        selectinload(Match.results),
        *match_history_options(),
    )


def match_history_options() -> tuple[ExecutableOption, ...]:
    """Subset of ``match_eager_options`` for paths that only need sides + scores
    (recent form, H2H): no match_settings, no league/rating-strategy."""
    return (
        selectinload(Match.sides)
        .selectinload(MatchSide.players)
        .selectinload(MatchSidePlayer.user),
        selectinload(Match.games).selectinload(MatchGame.score),
    )


def history_base_query(
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
        .options(*match_history_options())
        .order_by(Match.completed_at.desc())
    )
    if before is not None:
        query = query.where(Match.completed_at < before)
    return query


# ----- query filters -------------------------------------------------------


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


# ----- readers over a loaded match -----------------------------------------


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


def current_game_number(match: Match) -> int | None:
    """The next un-scored game number for an open match. ``None`` when:

    - the match is finalized / voided / pending (not in progress);
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
    if match.status != MatchStatus.in_progress:
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
