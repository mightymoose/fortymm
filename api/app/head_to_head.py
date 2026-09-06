"""HEAD-TO-HEAD — one player's record of **meetings** against another.

A **meeting** is a *decided* match between two NAMED players (CONTEXT.md): a win
or a loss, rated or not. Three consequences, and every query in this module is
built to hold all three:

* a match still in play is not a record — it has no outcome yet, so it is not a
  meeting, and a rivalry's score must not move because someone started a match;
* a **voided** match has stopped being one (it is terminal, and voiding clears
  the decision) — the ``status == completed`` + ``won IS NOT NULL`` gate drops it
  from both ends;
* a **solo match** can never be one. Its second side is a player-less sentinel
  (api/CLAUDE.md), not an absence to filter away — so the opponent is reached by
  an INNER JOIN through ``match_side_players``, and a side with no players
  produces no row at all rather than a ``None``-named "opponent".

Head-to-head is CROSS-LEAGUE, like ``career`` and unlike ``rating`` / ``rank`` /
``peak`` / ``confidence`` (ADR-0915). It is a fact about a *pair of people*, not
about a ladder: "how do I do against them" does not become a different question
because they beat you on a different ladder, and the card's Start-a-match CTA is
not league-bound either. That is why nothing here takes a ``league_id``.

It lives next to ``app.career`` — the other cross-league read of the same match
rows — rather than inside the profile router, and rather than inside
``app.matches``: the match-details page has its OWN head-to-head, and it is a
different question. That one is scoped to *this match's two participants* and to
the instant *before* this match, and it lists the meetings themselves. This one
is scoped to a *player's opponents* and is an aggregate. Neither is the other's
special case, so they share the definition of a meeting (stated above) and not a
query.
"""

import uuid
from typing import Any

from sqlalchemy import Select, and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.listed import is_listed_player
from app.models import Match, MatchSide, MatchSidePlayer, MatchStatus, Player
from app.schemas.player import (
    HeadToHeadOpponent,
    HeadToHeadRecord,
    PlayerHeadToHead,
    ViewerHeadToHead,
)

# How many of a player's most-met opponents the profile card shows. Three: it is
# secondary context on someone else's profile (the caller's own record leads),
# and a leaderboard of rivals is not what the card is for.
FREQUENT_OPPONENTS = 3


def _meetings_of(subject_id: uuid.UUID) -> Select[Any]:
    """One row per MEETING the subject has played:
    ``(opponent_id, subject_won, completed_at)``, from the SUBJECT's side.

    This is the single definition of a meeting in this module — both aggregates
    below are folds over it, so "does an in-progress match count?" and "does the
    solo sentinel count?" have exactly one answer apiece and cannot diverge
    between the two blocks of one card.

    The two-aliased-sides join is the trick ``matches._load_head_to_head`` uses
    to pin two players to opposite sides of one match (``opponent_side.id !=
    subject_side.id``), generalised from *a given pair* to *whoever the subject
    played*: the opponent's identity is a selected column here rather than a
    filter.

    ``won`` is read off the SUBJECT's side, so the W-L is written from their
    perspective — a head-to-head is only meaningful from a stated side
    (CONTEXT.md), and this is where the side is stated.
    """
    subject_side = aliased(MatchSide)
    subject_player = aliased(MatchSidePlayer)
    opponent_side = aliased(MatchSide)
    opponent_player = aliased(MatchSidePlayer)
    return (
        select(
            opponent_player.user_id.label("opponent_id"),
            subject_side.won.label("subject_won"),
            Match.completed_at.label("completed_at"),
        )
        .join(subject_side, subject_side.match_id == Match.id)
        .join(
            subject_player,
            and_(
                subject_player.match_side_id == subject_side.id,
                subject_player.user_id == subject_id,
            ),
        )
        .join(
            opponent_side,
            and_(
                opponent_side.match_id == Match.id,
                opponent_side.id != subject_side.id,
            ),
        )
        # INNER JOIN, deliberately: a solo match's second side carries no
        # `match_side_players` row, so it yields nothing here and the match
        # simply is not a meeting. This is the primary guard against the
        # sentinel; `HeadToHeadOpponent` (whose id and username are both
        # REQUIRED, unlike `PlayerMatchOpponent`'s) is the backstop — a
        # None-named "opponent" row is not a value that model can hold.
        .join(opponent_player, opponent_player.match_side_id == opponent_side.id)
        .where(
            # A meeting is DECIDED. `status == completed` alone would be enough
            # today, but `won IS NOT NULL` says the actual invariant the counts
            # depend on — and it is what makes a voided match (which nulls the
            # decision) drop out even if a future flow leaves its status behind.
            Match.status == MatchStatus.completed,
            subject_side.won.is_not(None),
            # Defensive: a match with the same user on both sides is a
            # self-play collision, and is voided rather than counted as a
            # rivalry with oneself.
            opponent_player.user_id != subject_id,
        )
    )


async def _versus(
    db: AsyncSession, viewer_id: uuid.UUID, player: Player
) -> ViewerHeadToHead:
    """The CALLER's record against ``player`` — "you are 1-4 against them".

    One round trip, and it always returns a record: an aggregate with no
    ``GROUP BY`` yields exactly one row, so a caller who has never met them gets
    ``0-0`` with no ``last_meeting`` rather than an empty result set. That empty
    record is the state a guest sees, and the card is built on it (ADR-0915) —
    it must not degrade to ``None``, which means something else entirely (the
    caller IS the player).
    """
    meetings = _meetings_of(viewer_id).subquery()
    wins, losses, last_meeting = (
        await db.execute(
            select(
                func.count().filter(meetings.c.subject_won.is_(True)),
                func.count().filter(meetings.c.subject_won.is_(False)),
                func.max(meetings.c.completed_at),
            ).where(meetings.c.opponent_id == player.id)
        )
    ).one()
    return ViewerHeadToHead(
        opponent=HeadToHeadOpponent(id=player.id, username=player.username),
        wins=int(wins),
        losses=int(losses),
        last_meeting=last_meeting,
    )


async def _frequent_opponents(
    db: AsyncSession, player_id: uuid.UUID, limit: int = FREQUENT_OPPONENTS
) -> list[HeadToHeadRecord]:
    """The player's most-met opponents, most meetings first — read from the
    PLAYER's side, not the caller's.

    One round trip for the whole list, opponents hydrated by the same query:
    a per-opponent username lookup would be an N+1 on a card that renders three
    rows.

    Ties on meetings are broken by the most recent meeting, then by username so
    the order is total — an untied `ORDER BY` would let two equally-met
    opponents swap places between requests and make the card flicker.
    """
    meetings = _meetings_of(player_id).subquery()
    total = func.count()
    rows = (
        await db.execute(
            select(
                Player.id,
                Player.username,
                func.count().filter(meetings.c.subject_won.is_(True)),
                func.count().filter(meetings.c.subject_won.is_(False)),
            )
            .select_from(meetings)
            .join(Player, Player.id == meetings.c.opponent_id)
            # Tombstoned (merged-away) users hold no side rows once the merge
            # has re-pointed them, so this excludes nothing in practice — it is
            # here so a ghost can never surface as somebody's rival. The
            # never-active conjunct is the same story twice over: a rival is
            # met through match sides, which a never-active row cannot hold —
            # both filters ride along so no listing carries a different rule
            # (#1438, see ``app.listed.is_listed_player``).
            .where(
                Player.merged_into_player_id.is_(None),
                is_listed_player(),
            )
            .group_by(Player.id, Player.username)
            .order_by(
                total.desc(),
                func.max(meetings.c.completed_at).desc(),
                Player.username,
            )
            .limit(limit)
        )
    ).all()
    return [
        HeadToHeadRecord(
            opponent=HeadToHeadOpponent(id=opponent_id, username=username),
            wins=int(wins),
            losses=int(losses),
        )
        for opponent_id, username, wins, losses in rows
    ]


async def player_head_to_head(
    db: AsyncSession, player: Player, viewer_id: uuid.UUID | None
) -> PlayerHeadToHead:
    """The profile's head-to-head block, VIEWER-AWARE (ADR-0915).

    Two round trips on someone else's profile, one on your own — never one per
    opponent.

    ``versus_viewer`` is ``None`` when the caller has no Player or IS the player.
    The card then shows just their frequent opponents. Every other caller gets
    a record — an empty one if
    they have never met, which is not the same thing and must not collapse into
    it.
    """
    return PlayerHeadToHead(
        versus_viewer=(
            None
            if viewer_id is None or viewer_id == player.id
            else await _versus(db, viewer_id, player)
        ),
        frequent_opponents=await _frequent_opponents(db, player.id),
    )
