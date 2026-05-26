"""Re-point ownership from an ephemeral user to a verified user, then delete
the ephemeral user. Called from sign-in (``/v1/login/consume``) and email
confirmation (``/v1/me/email/confirm``) when the browser arrived with a
different ephemeral session than the target account.

Leaves the verified user's ``user_league_ratings`` and ``rating_history``
stale relative to the freshly-moved matches — the caller enqueues the
``app.ratings.jobs.recompute_after_merge`` background job to reconcile.
"""

import uuid
from dataclasses import dataclass
from typing import Any, cast

from sqlalchemy import CursorResult, delete, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Match, MatchSidePlayer, MatchSignature, RatingHistory, User


@dataclass(frozen=True)
class MergeSummary:
    matches_moved: int


async def merge_user(
    db: AsyncSession,
    *,
    from_user_id: uuid.UUID,
    to_user_id: uuid.UUID,
) -> MergeSummary:
    """Re-point ``from_user_id``'s data onto ``to_user_id`` and delete the
    ephemeral row. Runs inside the caller's transaction — does not commit.

    Caller invariants:
      * ``from_user_id`` is ephemeral (``confirmed_at IS NULL``).
      * ``to_user_id`` already exists.
      * ``from_user_id != to_user_id``.
    """
    matches_moved = await _repoint_match_side_players(
        db, from_user_id=from_user_id, to_user_id=to_user_id
    )
    await _repoint_match_signatures(
        db, from_user_id=from_user_id, to_user_id=to_user_id
    )

    await db.execute(
        update(Match)
        .where(Match.created_by_user_id == from_user_id)
        .values(created_by_user_id=to_user_id)
    )

    # Preserve the audit trail by re-pointing rather than letting the FK's
    # ON DELETE SET NULL null it out when the ephemeral user is deleted.
    await db.execute(
        update(RatingHistory)
        .where(RatingHistory.created_by_user_id == from_user_id)
        .values(created_by_user_id=to_user_id)
    )

    # user_league_ratings / league_memberships both have UNIQUE(league_id,
    # user_id). Re-point only where the verified user has no row in that
    # league; the leftover ephemeral rows cascade-delete with the user below.
    # Don't try to merge JSONB rating state — a rating recompute against the
    # merged match list is the only correct reconciliation.
    await db.execute(
        text(
            """
            UPDATE user_league_ratings AS ulr
            SET user_id = :to_id
            WHERE ulr.user_id = :from_id
              AND NOT EXISTS (
                SELECT 1 FROM user_league_ratings other
                WHERE other.user_id = :to_id
                  AND other.league_id = ulr.league_id
              )
            """
        ),
        {"from_id": from_user_id, "to_id": to_user_id},
    )
    await db.execute(
        text(
            """
            UPDATE league_memberships AS lm
            SET user_id = :to_id
            WHERE lm.user_id = :from_id
              AND NOT EXISTS (
                SELECT 1 FROM league_memberships other
                WHERE other.user_id = :to_id
                  AND other.league_id = lm.league_id
              )
            """
        ),
        {"from_id": from_user_id, "to_id": to_user_id},
    )

    # match_side_players is RESTRICT, so any rows that didn't re-point would
    # block the final user delete. Re-point should always cover them; this is
    # a belt-and-braces drop in case the impossible collision ever fires.
    await db.execute(
        delete(MatchSidePlayer).where(MatchSidePlayer.user_id == from_user_id)
    )
    # Same RESTRICT story for match_signatures — defensive drop after repoint.
    await db.execute(
        delete(MatchSignature).where(MatchSignature.user_id == from_user_id)
    )

    # CASCADE cleans up user_tokens, user_roles, rating_history (user_id), and
    # any user_league_ratings / league_memberships rows that didn't re-point.
    await db.execute(delete(User).where(User.id == from_user_id))
    await db.flush()

    return MergeSummary(matches_moved=matches_moved)


async def _repoint_match_side_players(
    db: AsyncSession,
    *,
    from_user_id: uuid.UUID,
    to_user_id: uuid.UUID,
) -> int:
    """Re-point match_side_players from ephemeral → verified. Returns the row
    count, which equals the number of matches moved because UNIQUE(match_id,
    user_id) caps it at one row per match. NOT EXISTS skips the impossible-
    but-defendable case where both users are already on the same match."""
    result = await db.execute(
        text(
            """
            UPDATE match_side_players AS msp
            SET user_id = :to_id
            WHERE msp.user_id = :from_id
              AND NOT EXISTS (
                SELECT 1 FROM match_side_players other
                WHERE other.user_id = :to_id
                  AND other.match_id = msp.match_id
              )
            """
        ),
        {"from_id": from_user_id, "to_id": to_user_id},
    )
    return cast(CursorResult[Any], result).rowcount or 0


async def _repoint_match_signatures(
    db: AsyncSession,
    *,
    from_user_id: uuid.UUID,
    to_user_id: uuid.UUID,
) -> None:
    """Re-point match_signatures from ephemeral → verified. UNIQUE(match_id,
    user_id) collides only if both users somehow already signed the same
    match — left out by NOT EXISTS; the ephemeral row will then be dropped by
    the defensive ``DELETE`` in ``merge_user``."""
    await db.execute(
        text(
            """
            UPDATE match_signatures AS ms
            SET user_id = :to_id
            WHERE ms.user_id = :from_id
              AND NOT EXISTS (
                SELECT 1 FROM match_signatures other
                WHERE other.user_id = :to_id
                  AND other.match_id = ms.match_id
              )
            """
        ),
        {"from_id": from_user_id, "to_id": to_user_id},
    )
